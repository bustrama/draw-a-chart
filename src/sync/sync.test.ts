import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChartKey, Drawing } from '../drawing/model';
import { LocalDrawingDb } from './localDb';
import { PersistentDocuments } from './PersistentDocuments';
import { SyncEngine } from './SyncEngine';
import { FakeBackend } from './testing/FakeBackend';

const KEY: ChartKey = { provider: 'binance', symbol: 'BTCUSDT', timeframe: '1h' };
const USER = 'user-1';
let dbCounter = 0;
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function line(id: string, t2 = 2000, color = '#ffffff'): Drawing {
  return { id, kind: 'line', style: { color, width: 2 }, createdAt: 1, t1: 1000, p1: 10, t2, p2: 20 };
}

interface Device {
  db: LocalDrawingDb;
  docs: PersistentDocuments;
  sync: SyncEngine;
  online: boolean;
}

function device(backend: FakeBackend | null, dbName = `dac-test-${++dbCounter}`): Device {
  const db = new LocalDrawingDb(dbName);
  const dev = {} as Device;
  dev.online = true;
  dev.db = db;
  dev.docs = new PersistentDocuments(db, {
    currentOwner: () => dev.sync.currentUser,
    onLocalWrite: () => dev.sync.requestFlush(),
  });
  cleanups.push(() => dev.docs.dispose());
  dev.sync = new SyncEngine(db, dev.docs, backend ? backend.api(USER) : null, { isOnline: () => dev.online });
  cleanups.push(() => dev.sync.dispose());
  return dev;
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

async function settleSync(...devices: Device[]): Promise<void> {
  for (let i = 0; i < 5; i++) {
    for (const d of devices) {
      await d.docs.flushWrites();
      await d.sync.syncNow();
    }
    await tick(5);
  }
}

describe('local persistence', () => {
  it('persists local edits and restores them in a new session', async () => {
    const name = `dac-persist-${++dbCounter}`;
    const a = device(null, name);
    const doc = a.docs.open(KEY);
    await a.docs.whenLoaded(KEY);
    doc.commit('draw', [{ op: 'put', drawing: line('x') }]);
    doc.commit('draw', [{ op: 'put', drawing: line('y') }]);
    doc.commit('erase', [{ op: 'delete', id: 'x' }]);
    await a.docs.flushWrites();

    const b = device(null, name); // same IndexedDB = app reload
    const restored = b.docs.open(KEY);
    await b.docs.whenLoaded(KEY);
    expect(restored.store.all().map((d) => d.id)).toEqual(['y']);
    expect(a.sync.getStatus().state).toBe('local-only');
  });

  it('never loses a stroke drawn while the chart was still loading', async () => {
    const name = `dac-race-${++dbCounter}`;
    const a = device(null, name);
    const doc = a.docs.open(KEY);
    await a.docs.whenLoaded(KEY);
    doc.commit('draw', [{ op: 'put', drawing: line('old') }]);
    await a.docs.flushWrites();

    const b = device(null, name);
    const doc2 = b.docs.open(KEY);
    doc2.commit('draw', [{ op: 'put', drawing: line('new') }]); // before the load resolves
    await b.docs.whenLoaded(KEY);
    expect(doc2.store.all().map((d) => d.id).sort()).toEqual(['new', 'old']);
  });

  it('coalesces create + delete of an unsynced drawing into a single queued tombstone', async () => {
    const backend = new FakeBackend();
    const a = device(backend);
    const doc = a.docs.open(KEY);
    doc.commit('draw', [{ op: 'put', drawing: line('tmp') }]);
    doc.commit('erase', [{ op: 'delete', id: 'tmp' }]);
    await a.docs.flushWrites();
    expect(await a.db.pendingCount()).toBe(1);
    a.sync.setUser(USER);
    await settleSync(a);
    expect(backend.rows.get('tmp')).toMatchObject({ deleted: true, rev: 1 });
    expect(await a.db.pendingCount()).toBe(0);
  });

  it('adopts newer server content when a retried change turns out to be a duplicate', async () => {
    const backend = new FakeBackend();
    const a = device(backend);
    const b = device(backend);
    const docA = a.docs.open(KEY);
    const docB = b.docs.open(KEY);
    a.sync.setUser(USER);
    b.sync.setUser(USER);
    b.sync.setActiveChart(KEY);
    backend.loseResponses = 1; // A's create is applied, but A never hears back
    docA.commit('draw', [{ op: 'put', drawing: line('dup') }]);
    await a.docs.flushWrites();
    await a.sync.flush();
    // Meanwhile B moves the drawing (rev 2), then A retries its create (duplicate at rev 2).
    await settleSync(b);
    docB.commit('move', [{ op: 'put', drawing: line('dup', 4242) }]);
    await settleSync(b);
    a.sync.setActiveChart(KEY);
    await settleSync(a);
    expect(docA.store.get('dup')).toMatchObject({ t2: 4242 });
  });
});

describe('synchronization between devices', () => {
  it('propagates creation, modification and deletion to another device in real time', async () => {
    const backend = new FakeBackend();
    const a = device(backend);
    const b = device(backend);
    const docA = a.docs.open(KEY);
    const docB = b.docs.open(KEY);
    a.sync.setUser(USER);
    b.sync.setUser(USER);
    a.sync.setActiveChart(KEY);
    b.sync.setActiveChart(KEY);

    docA.commit('draw', [{ op: 'put', drawing: line('d1') }]);
    await settleSync(a, b);
    expect(docB.store.get('d1')).toEqual(line('d1'));

    docA.commit('move', [{ op: 'put', drawing: line('d1', 5000) }]);
    await settleSync(a, b);
    expect(docB.store.get('d1')).toMatchObject({ t2: 5000 });

    docB.commit('erase', [{ op: 'delete', id: 'd1' }]);
    await settleSync(a, b);
    expect(docA.store.get('d1')).toBeUndefined();
    expect(backend.rows.get('d1')).toMatchObject({ deleted: true, rev: 3 });
    expect(a.sync.getStatus()).toMatchObject({ state: 'synced', pending: 0 });
  });

  it('queues changes while offline and delivers them after reconnecting', async () => {
    const backend = new FakeBackend();
    const a = device(backend);
    const b = device(backend);
    const docA = a.docs.open(KEY);
    const docB = b.docs.open(KEY);
    a.sync.setUser(USER);
    b.sync.setUser(USER);
    b.sync.setActiveChart(KEY);
    await settleSync(a, b);

    a.online = false;
    backend.failCalls = 100;
    docA.commit('draw', [{ op: 'put', drawing: line('offline-1') }]);
    docA.commit('draw', [{ op: 'put', drawing: line('offline-2') }]);
    await a.docs.flushWrites();
    await a.sync.syncNow();
    expect(a.sync.getStatus()).toMatchObject({ state: 'offline', pending: 2 });
    expect(docB.store.size).toBe(0);

    a.online = true;
    backend.failCalls = 0;
    await settleSync(a, b);
    expect(docB.store.all().map((d) => d.id).sort()).toEqual(['offline-1', 'offline-2']);
    expect(a.sync.getStatus().pending).toBe(0);
  });

  it('does not duplicate a change when the response was lost and the request is retried', async () => {
    const backend = new FakeBackend();
    const a = device(backend);
    const docA = a.docs.open(KEY);
    a.sync.setUser(USER);
    backend.loseResponses = 1;
    docA.commit('draw', [{ op: 'put', drawing: line('once') }]);
    await settleSync(a);
    expect(backend.rows.size).toBe(1);
    expect(backend.rows.get('once')?.rev).toBe(1); // applied once, retry answered 'duplicate'
    expect(await a.db.pendingCount()).toBe(0);
  });

  it('resolves concurrent edits deterministically (server version wins on conflict)', async () => {
    const backend = new FakeBackend();
    const a = device(backend);
    const b = device(backend);
    const docA = a.docs.open(KEY);
    const docB = b.docs.open(KEY);
    a.sync.setUser(USER);
    b.sync.setUser(USER);
    a.sync.setActiveChart(KEY);
    b.sync.setActiveChart(KEY);
    docA.commit('draw', [{ op: 'put', drawing: line('shared') }]);
    await settleSync(a, b);
    expect(docB.store.get('shared')).toBeTruthy();

    // B goes offline and edits; meanwhile A edits the same drawing and syncs first.
    b.online = false;
    backend.failCalls = 0;
    docB.commit('recolor', [{ op: 'put', drawing: line('shared', 2000, '#ff0000') }]);
    await b.docs.flushWrites();
    docA.commit('move', [{ op: 'put', drawing: line('shared', 9000) }]);
    await a.docs.flushWrites();
    await a.sync.syncNow();
    b.online = true;
    await settleSync(a, b);

    expect(docA.store.get('shared')).toMatchObject({ t2: 9000, style: { color: '#ffffff' } });
    expect(docB.store.get('shared')).toEqual(docA.store.get('shared'));
    expect(backend.rows.get('shared')?.rev).toBe(2);
  });

  it('rebases an edit made while the previous change was in flight (no false conflict)', async () => {
    const backend = new FakeBackend();
    const a = device(backend);
    const docA = a.docs.open(KEY);
    a.sync.setUser(USER);
    await settleSync(a);
    let release: () => void = () => undefined;
    backend.gate = new Promise((r) => (release = r));
    docA.commit('draw', [{ op: 'put', drawing: line('r') }]);
    await a.docs.flushWrites();
    const flushing = a.sync.flush();
    await expect.poll(() => backend.calls === 0 && a.sync.getInFlight().has('r')).toBe(true); // create is in flight
    docA.commit('move', [{ op: 'put', drawing: line('r', 7777) }]);
    await a.docs.flushWrites();
    backend.gate = null;
    release();
    await flushing;
    await settleSync(a);
    expect(backend.rows.get('r')).toMatchObject({ rev: 2, data: expect.objectContaining({ t2: 7777 }) });
    expect(await a.db.pendingCount()).toBe(0);
  });

  it('coalesces edits made before the first one was sent into a single change', async () => {
    const backend = new FakeBackend();
    const a = device(backend);
    const docA = a.docs.open(KEY);
    docA.commit('draw', [{ op: 'put', drawing: line('c') }]);
    docA.commit('move', [{ op: 'put', drawing: line('c', 3333) }]);
    await a.docs.flushWrites();
    expect(await a.db.pendingCount()).toBe(1);
    a.sync.setUser(USER);
    await settleSync(a);
    expect(backend.rows.get('c')).toMatchObject({ rev: 1, data: expect.objectContaining({ t2: 3333 }) });
    expect(backend.calls).toBe(1);
  });

  it('pulls changes made while the device was not subscribed', async () => {
    const backend = new FakeBackend();
    const a = device(backend);
    const docA = a.docs.open(KEY);
    a.sync.setUser(USER);
    docA.commit('draw', [{ op: 'put', drawing: line('p1') }]);
    docA.commit('draw', [{ op: 'put', drawing: line('p2') }]);
    await settleSync(a);

    const late = device(backend); // new device, signs in later
    const docLate = late.docs.open(KEY);
    late.sync.setUser(USER);
    late.sync.setActiveChart(KEY);
    await settleSync(late);
    expect(docLate.store.all().map((d) => d.id).sort()).toEqual(['p1', 'p2']);
  });

  it('keeps an edit made after a lost response (no false conflict), for moves and erases', async () => {
    const backend = new FakeBackend();
    const a = device(backend);
    const docA = a.docs.open(KEY);
    a.sync.setUser(USER);
    await settleSync(a);

    backend.loseResponses = 1; // the create is committed but A never hears back
    docA.commit('draw', [{ op: 'put', drawing: line('lost') }]);
    await a.docs.flushWrites();
    await a.sync.flush();
    expect(backend.rows.get('lost')?.rev).toBe(1);
    docA.commit('move', [{ op: 'put', drawing: line('lost', 9999) }]); // coalesces into the sent entry
    await settleSync(a);
    expect(backend.rows.get('lost')).toMatchObject({ rev: 2, data: expect.objectContaining({ t2: 9999 }) });
    expect(docA.store.get('lost')).toMatchObject({ t2: 9999 });

    backend.loseResponses = 1;
    docA.commit('move', [{ op: 'put', drawing: line('lost', 1234) }]);
    await a.docs.flushWrites();
    await a.sync.flush();
    docA.commit('erase', [{ op: 'delete', id: 'lost' }]);
    await settleSync(a);
    expect(backend.rows.get('lost')).toMatchObject({ deleted: true });
    expect(docA.store.get('lost')).toBeUndefined();
    expect(await a.db.pendingCount()).toBe(0);
  });

  it('isolates a change the server refuses (e.g. oversized) and keeps syncing the rest', async () => {
    const backend = new FakeBackend();
    const a = device(backend);
    const docA = a.docs.open(KEY);
    a.sync.setUser(USER);
    const huge: Drawing = { id: 'huge', kind: 'ink', style: { color: '#ffffff', width: 2 }, createdAt: 1, pts: Array.from({ length: 30_000 }, (_, i) => i + 0.123456) };
    docA.commit('draw', [{ op: 'put', drawing: huge }]);
    docA.commit('draw', [{ op: 'put', drawing: line('small') }]);
    await settleSync(a);
    expect(backend.rows.has('small')).toBe(true);
    expect(backend.rows.has('huge')).toBe(false);
    expect(docA.store.get('huge')).toBeTruthy(); // kept on this device
    expect(await a.db.pendingCount()).toBe(0); // not retried forever
    expect(a.sync.getStatus().state).toBe('error');
    expect(a.sync.getStatus().error).toMatch(/could not be synced/);
    // A later successful pull does not hide the problem.
    a.sync.setActiveChart(KEY);
    await settleSync(a);
    expect(a.sync.getStatus().state).toBe('error');
  });

  it('recovers entries that were in flight when the user signed out', async () => {
    const backend = new FakeBackend();
    const a = device(backend);
    const docA = a.docs.open(KEY);
    a.sync.setUser(USER);
    await settleSync(a);
    let release: () => void = () => undefined;
    backend.gate = new Promise((r) => (release = r));
    docA.commit('draw', [{ op: 'put', drawing: line('flight') }]);
    await a.docs.flushWrites();
    const flushing = a.sync.flush();
    await expect.poll(() => a.sync.getInFlight().has('flight')).toBe(true);
    a.sync.setUser(null); // sign out mid-request
    expect(a.sync.getInFlight().size).toBe(0);
    backend.gate = null;
    release();
    await flushing;
    a.sync.setUser(USER);
    docA.commit('move', [{ op: 'put', drawing: line('flight', 4242) }]);
    await settleSync(a);
    expect(backend.rows.get('flight')).toMatchObject({ data: expect.objectContaining({ t2: 4242 }) });
    expect(await a.db.pendingCount()).toBe(0);
  });

  it("never sends one user's queued changes under another user's session", async () => {
    const backend = new FakeBackend();
    const dbName = `dac-owner-${++dbCounter}`;
    const a = device(backend, dbName);
    const docA = a.docs.open(KEY);
    // Signed in as "alice" but offline: the change is queued with alice as owner.
    const alice = new SyncEngine(a.db, a.docs, backend.api('alice'), { isOnline: () => false });
    cleanups.push(() => alice.dispose());
    a.sync.dispose();
    const owner = { current: 'alice' as string | null };
    const docs = new PersistentDocuments(a.db, { currentOwner: () => owner.current });
    cleanups.push(() => docs.dispose());
    const doc = docs.open({ ...KEY, timeframe: '4h' });
    await docs.whenLoaded({ ...KEY, timeframe: '4h' });
    doc.commit('draw', [{ op: 'put', drawing: line('alice-1') }]);
    await docs.flushWrites();
    void docA;

    const bob = new SyncEngine(a.db, docs, backend.api('bob'), { isOnline: () => true });
    cleanups.push(() => bob.dispose());
    bob.setUser('bob');
    await bob.syncNow();
    expect(backend.rows.has('alice-1')).toBe(false);
    expect(bob.getStatus().pending).toBe(0); // bob has nothing to send

    bob.setUser(null);
    const aliceAgain = new SyncEngine(a.db, docs, backend.api('alice'), { isOnline: () => true });
    cleanups.push(() => aliceAgain.dispose());
    aliceAgain.setUser('alice');
    await aliceAgain.syncNow();
    expect(backend.rows.get('alice-1')?.user_id).toBe('alice');
  });

  it('keeps two tabs on the same device consistent', async () => {
    const dbName = `dac-tabs-${++dbCounter}`;
    const tab1 = device(null, dbName);
    const tab2 = device(null, dbName);
    const doc1 = tab1.docs.open(KEY);
    const doc2 = tab2.docs.open(KEY);
    await Promise.all([tab1.docs.whenLoaded(KEY), tab2.docs.whenLoaded(KEY)]);
    doc1.commit('draw', [{ op: 'put', drawing: line('shared-tab') }]);
    await tab1.docs.flushWrites();
    await expect.poll(() => doc2.store.get('shared-tab')?.id).toBe('shared-tab');
    doc2.commit('erase', [{ op: 'delete', id: 'shared-tab' }]);
    await tab2.docs.flushWrites();
    await expect.poll(() => doc1.store.get('shared-tab')).toBeUndefined();
    expect(doc2.history.canUndo).toBe(true);
    expect(doc1.history.canUndo).toBe(true); // tab 1's own draw; the remote erase is not in its history
  });

  it('relays live previews to other devices only', async () => {
    const backend = new FakeBackend();
    const received: string[] = [];
    const db = new LocalDrawingDb(`dac-preview-${++dbCounter}`);
    const docs = new PersistentDocuments(db);
    const a = new SyncEngine(db, docs, backend.api(USER), { isOnline: () => true }, { onPreview: (m) => received.push(`a:${m.id}`) });
    const db2 = new LocalDrawingDb(`dac-preview-${++dbCounter}`);
    const b = new SyncEngine(db2, new PersistentDocuments(db2), backend.api(USER), { isOnline: () => true }, { onPreview: (m) => received.push(`b:${m.id}`) });
    cleanups.push(() => a.dispose(), () => b.dispose());
    a.setUser(USER);
    b.setUser(USER);
    a.sendPreview({ chart: 'binance:BTCUSDT:1h', id: 's1', style: { color: '#ffffff', width: 2 }, pts: [1, 2, 0.5], end: null });
    await tick(10);
    expect(received).toEqual(['b:s1']);
  });
});

describe('a server that was restored from a backup or replaced (new generation)', () => {
  it('gets back every drawing a device still has when its database was replaced', async () => {
    const backend = new FakeBackend();
    const a = device(backend);
    const doc = a.docs.open(KEY);
    a.sync.setUser(USER);
    a.sync.setActiveChart(KEY);
    await a.docs.whenLoaded(KEY);
    doc.commit('draw', [{ op: 'put', drawing: line('kept') }]);
    doc.commit('draw', [{ op: 'put', drawing: line('erased') }]);
    await settleSync(a);
    doc.commit('erase', [{ op: 'delete', id: 'erased' }]);
    await settleSync(a);
    expect(backend.rows.get('kept')?.rev).toBe(1);

    backend.replace(); // e.g. the server's volume was lost: an empty database
    await settleSync(a);
    expect(backend.rows.get('kept')).toMatchObject({ rev: 1, deleted: false, data: line('kept') });
    expect(backend.rows.has('erased')).toBe(false); // a deletion is not resurrected
    expect(doc.store.all().map((d) => d.id)).toEqual(['kept']);
    expect(a.sync.getStatus()).toMatchObject({ state: 'synced', pending: 0 });
  });

  it("after a restore, the backup's versions win and drawings it lacks come back from the device", async () => {
    const backend = new FakeBackend();
    const a = device(backend);
    const b = device(backend);
    const docA = a.docs.open(KEY);
    a.sync.setUser(USER);
    a.sync.setActiveChart(KEY);
    await a.docs.whenLoaded(KEY);
    docA.commit('draw', [{ op: 'put', drawing: line('old') }]);
    await settleSync(a);
    const backup = backend.snapshot();
    docA.commit('move', [{ op: 'put', drawing: line('old', 7777) }]); // after the backup
    docA.commit('draw', [{ op: 'put', drawing: line('new') }]); // after the backup
    await settleSync(a);
    expect(backend.rows.get('old')?.rev).toBe(2);

    backend.restore(backup);
    await settleSync(a);
    expect(docA.store.get('old')).toEqual(line('old')); // the backup's version
    expect(backend.rows.get('old')).toMatchObject({ rev: 1 });
    expect(backend.rows.get('new')).toMatchObject({ rev: 1, data: line('new') }); // uploaded again
    expect(a.sync.getStatus()).toMatchObject({ state: 'synced', pending: 0, error: null });

    // A device that joins now sees exactly the restored + recovered state.
    const docB = b.docs.open(KEY);
    b.sync.setUser(USER);
    b.sync.setActiveChart(KEY);
    await settleSync(b);
    expect(docB.store.all().map((d) => d.id).sort()).toEqual(['new', 'old']);
    expect(docB.store.get('old')).toEqual(line('old'));
  });

  it('records the generation on first contact without resetting anything', async () => {
    const backend = new FakeBackend();
    const a = device(backend);
    const doc = a.docs.open(KEY);
    await a.docs.whenLoaded(KEY);
    doc.commit('draw', [{ op: 'put', drawing: line('local') }]); // before ever syncing
    await a.docs.flushWrites();
    a.sync.setUser(USER);
    await settleSync(a);
    expect(backend.rows.get('local')?.rev).toBe(1);
    expect(await a.db.getMeta('server-generation')).toBe(backend.generation);
  });
});
