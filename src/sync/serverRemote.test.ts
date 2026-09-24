import 'fake-indexeddb/auto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../../server/http.ts';
import type { ChartKey, Drawing } from '../drawing/model';
import { LocalDrawingDb } from './localDb';
import { PersistentDocuments } from './PersistentDocuments';
import type { PreviewMessage, RemoteRow } from './protocol';
import type { ChannelStatus } from './remote';
import { LOGIN_REQUIRED, ServerRemote, SyncServerError, type LiveEnv } from './serverRemote';
import { SyncEngine } from './SyncEngine';

const KEY: ChartKey = { provider: 'binance', symbol: 'BTCUSDT', timeframe: '1h' };
const NODE_ENV: LiveEnv = { createSocket: (url) => new WebSocket(url) };
const uuid = (n: number, prefix = 'a') => `${prefix.repeat(8)}-0000-4000-8000-${String(n).padStart(12, '0')}`;

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function server(port = 0, dbFile = ':memory:'): Promise<RunningServer> {
  const s = await startServer({ host: '127.0.0.1', port, dbFile, log: () => undefined });
  cleanups.push(() => s.close());
  return s;
}

function remote(s: { url: string } | string): ServerRemote {
  const r = new ServerRemote(typeof s === 'string' ? s : s.url, NODE_ENV);
  cleanups.push(() => r.dispose());
  return r;
}

function change(n: number, data: unknown = { n }) {
  return { id: uuid(n), op_id: uuid(n, 'b'), base_rev: 0, prev_op_ids: [], ...KEY, kind: 'line', data, deleted: false };
}

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('ServerRemote against the real sync server', () => {
  it('writes, pulls and knows the session', async () => {
    const s = await server();
    const r = remote(s);
    expect(r.generation).toBeNull();
    expect(await r.session()).toEqual({ user: { id: 'local' }, auth: 'none', generation: s.store.generation });
    expect(r.generation).toBe(s.store.generation);
    const [result] = await r.applyChanges([change(1)]);
    expect(result).toMatchObject({ id: uuid(1), status: 'applied', row: { rev: 1, data: { n: 1 } } });
    const rows = await r.pull(KEY, null, 10);
    expect(rows.map((row) => row.id)).toEqual([uuid(1)]);
    expect(await r.pull(KEY, rows[0].updated_at, 10)).toHaveLength(1); // cursor is inclusive
  });

  it('streams rows written by another device and relays previews both ways', async () => {
    const s = await server();
    const a = remote(s);
    const b = remote(s);
    const rows: RemoteRow[] = [];
    const statuses: ChannelStatus[] = [];
    b.subscribeChanges('local', (row) => rows.push(row), (st) => statuses.push(st));
    const seenByA: PreviewMessage[] = [];
    const seenByB: PreviewMessage[] = [];
    const pa = a.subscribePreviews('local', (m) => seenByA.push(m));
    const pb = b.subscribePreviews('local', (m) => seenByB.push(m));
    await until(() => pa.ready && pb.ready && statuses.includes('SUBSCRIBED'));

    await a.applyChanges([change(1)]);
    await until(() => rows.length === 1);
    expect(rows[0]).toMatchObject({ id: uuid(1), rev: 1 });

    const message: PreviewMessage = { chart: 'binance:BTCUSDT:1h', id: 's1', style: { color: '#ffd166', width: 2 }, pts: [1, 2, 0.5], end: null, device: 'a' };
    pa.send(message);
    await until(() => seenByB.length === 1);
    expect(seenByB[0]).toEqual(message);
    expect(seenByA).toEqual([]); // not echoed to the sender
  });

  it('reconnects after the server restarts and keeps receiving', async () => {
    const first = await server();
    const port = first.port;
    const r = remote(`http://127.0.0.1:${port}`);
    const statuses: ChannelStatus[] = [];
    const rows: RemoteRow[] = [];
    r.subscribeChanges('local', (row) => rows.push(row), (st) => statuses.push(st));
    await until(() => statuses.at(-1) === 'SUBSCRIBED');

    const firstGeneration = first.store.generation;
    expect(r.generation).toBe(firstGeneration); // from the server's hello

    await first.close();
    await until(() => statuses.at(-1) === 'CLOSED');
    const second = await server(port); // a new database: a new generation
    await until(() => statuses.at(-1) === 'SUBSCRIBED', 8_000);
    expect(statuses).toEqual(['SUBSCRIBED', 'CLOSED', 'SUBSCRIBED']);
    expect(r.generation).toBe(second.store.generation);
    expect(r.generation).not.toBe(firstGeneration);

    await remote(second).applyChanges([change(2)]);
    await until(() => rows.length === 1);
  });

  it('reports a proxy login redirect and a proxy error page as clear errors', async () => {
    const proxy: Server = createServer((req, res) => {
      if (req.url?.startsWith('/api/changes')) res.writeHead(302, { Location: 'https://example.cloudflareaccess.com/login' }).end();
      else res.writeHead(502, { 'Content-Type': 'text/html' }).end('<html>Bad gateway</html>');
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => proxy.close(() => resolve())));
    const r = remote(`http://127.0.0.1:${(proxy.address() as AddressInfo).port}`);
    await expect(r.applyChanges([change(1)])).rejects.toThrow(LOGIN_REQUIRED);
    const failure = await r.session().catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(SyncServerError);
    expect((failure as SyncServerError).status).toBe(502);
    expect((failure as SyncServerError).message).toBe('Sync server unavailable (HTTP 502)');
  });
});

describe('two devices syncing through the real server (full client stack)', () => {
  let dbCounter = 0;

  function device(s: RunningServer) {
    const db = new LocalDrawingDb(`dac-server-${Date.now()}-${++dbCounter}`);
    const r = remote(s);
    let sync: SyncEngine | null = null;
    const docs = new PersistentDocuments(db, { currentOwner: () => sync?.currentUser ?? null, onLocalWrite: () => sync?.requestFlush() });
    sync = new SyncEngine(db, docs, r, { isOnline: () => true });
    const engine = sync;
    cleanups.push(() => {
      engine.dispose();
      docs.dispose();
      return db.close();
    });
    engine.setUser('local');
    engine.setActiveChart(KEY);
    return { docs, sync: engine, doc: docs.open(KEY) };
  }

  const line = (id: string, color = '#ffd166'): Drawing => ({ id, kind: 'line', style: { color, width: 2 }, createdAt: 1, t1: 1000, p1: 10, t2: 2000, p2: 20 });

  it('delivers a drawing and its deletion from one device to the other, live', async () => {
    const s = await server();
    const a = device(s);
    const b = device(s);
    await until(() => a.sync.getStatus().state === 'synced' && b.sync.getStatus().state === 'synced');

    const id = uuid(7);
    a.doc.commit('draw', [{ op: 'put', drawing: line(id) }]);
    await until(() => b.doc.store.get(id) !== undefined);
    expect(b.doc.store.get(id)).toEqual(line(id));

    b.doc.commit('erase', [{ op: 'delete', id }]);
    await until(() => a.doc.store.get(id) === undefined);
    await until(() => a.sync.getStatus().pending === 0 && b.sync.getStatus().pending === 0);
    expect(s.store.pull('local', KEY, null, 10)[0]).toMatchObject({ id, rev: 2, deleted: true });
  });
});
