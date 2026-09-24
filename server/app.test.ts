import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ChangeResult, PreviewMessage, ServerMessage } from '../src/sync/protocol.ts';
import { startServer, type RunningServer, type ServerOptions } from './http.ts';

const KEY = { provider: 'binance', symbol: 'BTCUSDT', timeframe: '1h' };
const uuid = (n: number, prefix = 'a') => `${prefix.repeat(8)}-0000-4000-8000-${String(n).padStart(12, '0')}`;

function change(n: number, extra: Record<string, unknown> = {}) {
  return { id: uuid(n), op_id: uuid(n, 'b'), base_rev: 0, prev_op_ids: [], ...KEY, kind: 'line', data: { n }, deleted: false, ...extra };
}

const servers: RunningServer[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  for (const s of servers.splice(0)) await s.close();
});

/** Test identity: the X-Test-User header (defaults to the single local user). */
const byHeader: ServerOptions['identify'] = (req) => {
  const user = req.headers['x-test-user'];
  if (user === 'nobody') return null;
  return { userId: typeof user === 'string' ? user : 'local' };
};

async function server(options: ServerOptions = {}): Promise<RunningServer> {
  const s = await startServer({ host: '127.0.0.1', identify: byHeader, log: () => undefined, ...options });
  servers.push(s);
  return s;
}

function post(s: RunningServer, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${s.url}/api/changes`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

interface Client {
  readonly ws: WebSocket;
  readonly messages: ServerMessage[];
  next(type: ServerMessage['type'], timeoutMs?: number): Promise<ServerMessage>;
  closed: Promise<void>;
}

async function live(s: RunningServer, user = 'local', options: WebSocket.ClientOptions = {}): Promise<Client> {
  const ws = new WebSocket(`${s.url.replace('http', 'ws')}/api/live`, { headers: { 'x-test-user': user }, ...options });
  sockets.push(ws);
  const messages: ServerMessage[] = [];
  const waiters: Array<{ type: string; resolve: (m: ServerMessage) => void }> = [];
  ws.on('message', (data) => {
    const m = JSON.parse(data.toString()) as ServerMessage;
    messages.push(m);
    const i = waiters.findIndex((w) => w.type === m.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
  });
  const closed = new Promise<void>((resolve) => ws.on('close', () => resolve()));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return {
    ws,
    messages,
    closed,
    next(type, timeoutMs = 2_000) {
      const seen = messages.find((m) => m.type === type && !consumed.has(m));
      if (seen) {
        consumed.add(seen);
        return Promise.resolve(seen);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ${type} message within ${timeoutMs} ms`)), timeoutMs);
        waiters.push({
          type,
          resolve: (m) => {
            clearTimeout(timer);
            consumed.add(m);
            resolve(m);
          },
        });
      });
    },
  };
}
const consumed = new WeakSet<ServerMessage>();

function preview(id: string, extra: Partial<PreviewMessage> = {}): PreviewMessage {
  return { chart: 'binance:BTCUSDT:1h', id, style: { color: '#ffd166', width: 2 }, pts: [1, 2, 0.5], end: null, device: 'dev-1', ...extra };
}

describe('sync server HTTP API', () => {
  it('reports health and the session of the single local user', async () => {
    const s = await server({ version: '9.9.9' });
    expect(await (await fetch(`${s.url}/api/health`)).json()).toEqual({ ok: true, version: '9.9.9' });
    const session = await fetch(`${s.url}/api/session`);
    expect(session.headers.get('cache-control')).toBe('no-store');
    expect(await session.json()).toEqual({ user: { id: 'local' }, auth: 'none', generation: s.store.generation });
  });

  it('reports an unwritable database as unhealthy (so the container health check notices)', async () => {
    const s = await server();
    s.store.checkWritable = () => 'attempt to write a readonly database';
    const res = await fetch(`${s.url}/api/health`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, error: 'attempt to write a readonly database' });
  });

  it('bounces /api/login back into the app, only ever to a path of its own', async () => {
    const s = await server();
    const target = async (next: string) => (await fetch(`${s.url}/api/login?next=${encodeURIComponent(next)}`, { redirect: 'manual' })).headers.get('location');
    expect(await target('/?provider=mock&tf=1h')).toBe('/?provider=mock&tf=1h');
    for (const hostile of ['//evil.example/x', 'https://evil.example', '/\\evil.example', '/api/login', '']) expect(await target(hostile), hostile).toBe('/');
    expect((await fetch(`${s.url}/api/login`, { redirect: 'manual' })).status).toBe(302);
  });

  it('applies changes and serves them back through pull, oldest first, from a cursor', async () => {
    const s = await server();
    const res = await post(s, { changes: [change(1), change(2)] });
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as { results: ChangeResult[] };
    expect(results.map((r) => [r.status, r.row?.rev])).toEqual([
      ['applied', 1],
      ['applied', 1],
    ]);
    const pull = async (query: string) => ((await (await fetch(`${s.url}/api/drawings?${query}`)).json()) as { rows: Array<{ id: string; updated_at: string }> }).rows;
    const all = await pull('provider=binance&symbol=BTCUSDT&timeframe=1h');
    expect(all.map((r) => r.id)).toEqual([uuid(1), uuid(2)]);
    expect((await pull(`provider=binance&symbol=BTCUSDT&timeframe=1h&since=${encodeURIComponent(all[1].updated_at)}`)).map((r) => r.id)).toEqual([uuid(2)]);
    expect(await pull('provider=binance&symbol=BTCUSDT&timeframe=1h&limit=1')).toHaveLength(1);
    expect(await pull('provider=binance&symbol=ETHUSDT&timeframe=1h')).toEqual([]);
  });

  it('refuses malformed requests with clear status codes', async () => {
    const s = await server({ maxBodyBytes: 2_000 });
    expect((await post(s, { changes: [] }, { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await post(s, '{not json')).status).toBe(400);
    expect((await post(s, { nope: true })).status).toBe(400);
    expect((await post(s, { changes: Array.from({ length: 201 }, (_, i) => change(i)) })).status).toBe(413); // body limit first
    const big = await post(s, { changes: [change(1, { data: { pad: 'x'.repeat(3_000) } })] });
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: 'request too large (max 2000 bytes)' });
    expect((await fetch(`${s.url}/api/drawings?provider=binance`)).status).toBe(400);
    const wrongMethod = await fetch(`${s.url}/api/changes`);
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('POST');
    expect((await fetch(`${s.url}/api/live`)).status).toBe(426);
    expect((await fetch(`${s.url}/api/nope`)).status).toBe(404);
    expect((await fetch(`${s.url}/elsewhere`)).status).toBe(404); // API-only server
  });

  it('limits the batch size, and the drawings per user one change at a time', async () => {
    const s = await server({ maxRows: 2 });
    const tooMany = await post(s, { changes: Array.from({ length: 201 }, (_, i) => change(i)) });
    expect(tooMany.status).toBe(400);
    const res = await post(s, { changes: [change(1), change(2), change(3)] });
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as { results: ChangeResult[] };
    expect(results.map((r) => r.status)).toEqual(['applied', 'applied', 'invalid']);
    expect(results[2].error).toBe('drawing quota exceeded (max 2)');
  });

  it('works with an asynchronous identity check', async () => {
    const s = await server({ identify: async (req) => (req.headers['x-test-user'] === 'nobody' ? null : { userId: 'async-user' }) });
    expect(await (await fetch(`${s.url}/api/session`)).json()).toMatchObject({ user: { id: 'async-user' } });
    expect((await fetch(`${s.url}/api/session`, { headers: { 'x-test-user': 'nobody' } })).status).toBe(401);
    expect(await (await live(s)).next('hello')).toMatchObject({ user: { id: 'async-user' } });
  });

  it('refuses callers the identity function rejects (the hook for adding auth later)', async () => {
    const s = await server();
    const res = await fetch(`${s.url}/api/session`, { headers: { 'x-test-user': 'nobody' } });
    expect(res.status).toBe(401);
    expect((await post(s, { changes: [change(1)] }, { 'x-test-user': 'nobody' })).status).toBe(401);
    await expect(live(s, 'nobody')).rejects.toThrow(/401/);
  });
});

describe('sync server live connection', () => {
  it("pushes changed rows to every connection of the writer's user, and only to them", async () => {
    const s = await server();
    const a = await live(s, 'local');
    const b = await live(s, 'local');
    const other = await live(s, 'someone-else');
    expect(await a.next('hello')).toEqual({ type: 'hello', user: { id: 'local' }, generation: s.store.generation });
    await post(s, { changes: [change(1)] });
    for (const c of [a, b]) {
      const m = await c.next('rows');
      expect(m.type === 'rows' && m.rows.map((r) => [r.id, r.rev])).toEqual([[uuid(1), 1]]);
    }
    await post(s, { changes: [change(1)] }); // duplicate: nothing changed, nothing pushed
    await new Promise((r) => setTimeout(r, 100));
    expect(a.messages.filter((m) => m.type === 'rows')).toHaveLength(1);
    expect(other.messages.filter((m) => m.type === 'rows')).toEqual([]);
  });

  it("relays previews to the user's other connections only, and drops malformed ones", async () => {
    const s = await server();
    const sender = await live(s);
    const peer = await live(s);
    const other = await live(s, 'someone-else');
    sender.ws.send(JSON.stringify({ type: 'preview', message: preview('bad', { pts: [1, 2] as unknown as number[] }) }));
    sender.ws.send(JSON.stringify({ type: 'preview', message: preview('s1') }));
    const m = await peer.next('preview');
    expect(m).toEqual({ type: 'preview', message: preview('s1') });
    await new Promise((r) => setTimeout(r, 100));
    expect(peer.messages.filter((x) => x.type === 'preview')).toHaveLength(1); // 'bad' never arrived
    expect(sender.messages.some((x) => x.type === 'preview')).toBe(false);
    expect(other.messages.some((x) => x.type === 'preview')).toBe(false);
  });

  it('sends heartbeats and drops a connection that stops answering pings', async () => {
    const s = await server({ heartbeatMs: 60 });
    const healthy = await live(s);
    await healthy.next('ping');
    const dead = await live(s, 'local', { autoPong: false });
    await dead.closed; // terminated after two heartbeats without a pong
    expect(healthy.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('refuses live connections from pages of other sites (unless allowed)', async () => {
    const s = await server({ allowedOrigins: ['https://chart.example.com'] });
    await expect(live(s, 'local', { origin: 'http://evil.example' })).rejects.toThrow(/403/);
    const host = new URL(s.url).host;
    expect(await (await live(s, 'local', { origin: `http://${host}` })).next('hello')).toMatchObject({ type: 'hello' });
    expect(await (await live(s, 'local', { origin: 'https://chart.example.com' })).next('hello')).toMatchObject({ type: 'hello' });
  });

  it('survives hostile input: deeply nested previews, malformed upgrades, a failing identity check', async () => {
    const s = await server({
      identify: (req) => {
        if (req.headers['x-test-user'] === 'boom') throw new Error('identity service down');
        return { userId: 'local' };
      },
    });
    const sender = await live(s);
    const peer = await live(s);
    // Extra fields are dropped, not re-serialized (100k levels of nesting would overflow the stack).
    const nested = `${'['.repeat(100_000)}${']'.repeat(100_000)}`;
    sender.ws.send(`{"type":"preview","message":${JSON.stringify(preview('s1')).slice(0, -1)},"x":${nested}}}`);
    expect(await peer.next('preview')).toEqual({ type: 'preview', message: preview('s1') });

    await new Promise<void>((resolve) => {
      const raw = connect(s.port, '127.0.0.1', () =>
        raw.write('GET //[ HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'),
      );
      raw.on('error', () => resolve());
      raw.on('close', () => resolve());
    });
    await expect(live(s, 'boom')).rejects.toThrow(/500/);

    expect((await fetch(`${s.url}/api/health`)).status).toBe(200); // still alive
  });

  it('closes live connections when the server shuts down', async () => {
    const s = await server();
    const c = await live(s);
    await s.close();
    await c.closed;
  });
});
