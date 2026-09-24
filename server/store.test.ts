import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { backupDatabase, DrawingStore } from './store.ts';
import { checkChange } from './validate.ts';

const A = 'user-a';
const B = 'user-b';
const DRAWING = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const op = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const KEY = { provider: 'binance', symbol: 'BTCUSDT', timeframe: '1h' };

function change(opId: string, baseRev: number, data: unknown, extra: Record<string, unknown> = {}) {
  return checkChange({ id: DRAWING, op_id: opId, base_rev: baseRev, prev_op_ids: [], ...KEY, kind: 'line', data, deleted: false, ...extra });
}

const stores: DrawingStore[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function open(file = ':memory:', now?: () => number): DrawingStore {
  const store = new DrawingStore(file, { now });
  stores.push(store);
  return store;
}

describe('DrawingStore (compare-and-swap on SQLite)', () => {
  it('creates a drawing and treats a retry of the same op as a duplicate', () => {
    const s = open();
    const [created] = s.apply(A, [change(op(1), 0, { v: 1 })], 100).results;
    expect(created).toMatchObject({ id: DRAWING, status: 'applied', row: { rev: 1, deleted: false, data: { v: 1 } } });
    const retry = s.apply(A, [change(op(1), 0, { v: 1 })], 100);
    expect(retry.results[0]).toMatchObject({ status: 'duplicate', row: { rev: 1 } });
    expect(retry.changed).toEqual([]); // nothing to broadcast
    expect(s.pull(A, KEY, null, 10)).toHaveLength(1);
  });

  it('applies an update on the current revision and reports a stale one as a conflict', () => {
    const s = open();
    s.apply(A, [change(op(1), 0, { v: 1 })], 100);
    expect(s.apply(A, [change(op(2), 1, { v: 2 })], 100).results[0]).toMatchObject({ status: 'applied', row: { rev: 2, data: { v: 2 } } });
    const stale = s.apply(A, [change(op(3), 1, { v: 'stale' })], 100);
    expect(stale.results[0]).toMatchObject({ status: 'conflict', row: { rev: 2, data: { v: 2 } } });
    expect(stale.changed).toEqual([]);
  });

  it('keeps deletions as tombstones (with the previous data) so offline devices learn about them', () => {
    const s = open();
    s.apply(A, [change(op(1), 0, { v: 1 })], 100);
    const [del] = s.apply(A, [change(op(2), 1, null, { deleted: true })], 100).results;
    expect(del).toMatchObject({ status: 'applied', row: { rev: 2, deleted: true, data: { v: 1 } } });
  });

  it("accepts an edit on top of the client's own unacknowledged op (lost response), not someone else's", () => {
    const s = open();
    s.apply(A, [change(op(1), 0, { v: 'a' })], 100); // applied, but the client never heard back
    const [b] = s.apply(A, [change(op(2), 0, { v: 'b' }, { prev_op_ids: [op(1)] })], 100).results;
    expect(b).toMatchObject({ status: 'applied', row: { rev: 2, data: { v: 'b' } } });
    const [c] = s.apply(A, [change(op(3), 0, { v: 'c' })], 100).results; // no proof of authorship
    expect(c.status).toBe('conflict');
  });

  it("isolates users: another user's id is rejected and never readable", () => {
    const s = open();
    s.apply(A, [change(op(1), 0, { v: 1 })], 100);
    expect(s.pull(B, KEY, null, 10)).toEqual([]);
    expect(s.apply(B, [change(op(2), 1, { hacked: true })], 100).results[0]).toEqual({ id: DRAWING, status: 'rejected', row: null });
    expect(s.pull(A, KEY, null, 10)[0].data).toEqual({ v: 1 });
  });

  it('reports invalid changes per change without failing the rest of the batch', () => {
    const s = open();
    const ok = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const outcome = s.apply(
      A,
      [
        checkChange({ id: DRAWING, op_id: op(1), base_rev: 0, ...KEY, kind: 'ink', data: { pts: 'x'.repeat(270_000) }, deleted: false }),
        checkChange({ id: 'not-a-uuid', op_id: op(2), ...KEY, kind: 'ink', data: {} }),
        checkChange({ id: ok, op_id: op(3), ...KEY, kind: 'bogus', data: {} }),
        checkChange({ id: ok, op_id: op(4), base_rev: 0, ...KEY, kind: 'ink', data: { v: 1 }, deleted: false }),
      ],
      100,
    );
    expect(outcome.results.map((r) => r.status)).toEqual(['invalid', 'invalid', 'invalid', 'applied']);
    expect(outcome.results[0].error).toMatch(/too large/);
    expect(outcome.results[1].id).toBe('not-a-uuid');
    expect(s.pull(A, KEY, null, 10).map((r) => r.id)).toEqual([ok]);
  });

  it('limits live drawings per user, per change: edits, deletions and other users still go through', () => {
    const s = open();
    const id = (n: number) => `d0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const create = (n: number) => checkChange({ id: id(n), op_id: op(n), base_rev: 0, ...KEY, kind: 'ink', data: {}, deleted: false });
    const edit = (n: number, opN: number, base: number, extra: Record<string, unknown> = {}) =>
      checkChange({ id: id(n), op_id: op(opN), base_rev: base, ...KEY, kind: 'ink', data: { edited: opN }, deleted: false, ...extra });

    s.apply(A, [create(1), create(2)], 3);
    const atLimit = s.apply(A, [create(3), create(4), edit(1, 11, 1)], 3).results;
    expect(atLimit.map((r) => r.status)).toEqual(['applied', 'invalid', 'applied']); // only the 4th drawing is refused
    expect(atLimit[1].error).toBe('drawing quota exceeded (max 3)');
    // Deleting frees a slot (tombstones do not count); reviving a tombstone needs one again.
    expect(s.apply(A, [edit(2, 12, 1, { deleted: true, data: null })], 3).results[0].status).toBe('applied');
    expect(s.apply(A, [create(4)], 3).results[0].status).toBe('applied');
    expect(s.apply(A, [edit(2, 13, 2)], 3).results[0]).toMatchObject({ status: 'invalid', error: 'drawing quota exceeded (max 3)' });
    expect(s.apply(B, [create(5)], 3).results[0].status).toBe('applied');
  });

  it('has a generation that survives restarts and changes only when renewed (restore)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dac-gen-'));
    dirs.push(dir);
    const file = join(dir, 'drawings.sqlite');
    const first = open(file);
    const generation = first.generation;
    expect(generation).toMatch(/^[0-9a-f]{32}$/);
    first.close();
    const again = open(file);
    expect(again.generation).toBe(generation);
    const renewed = again.renewGeneration();
    expect(renewed).not.toBe(generation);
    expect(again.generation).toBe(renewed);
    expect(open().generation).not.toBe(generation); // every new database has its own
  });

  it('refuses to start on a database file it cannot write, with a clear message', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dac-ro-'));
    dirs.push(dir);
    const file = join(dir, 'drawings.sqlite');
    open(file).close();
    chmodSync(file, 0o444);
    try {
      expect(() => new DrawingStore(file)).toThrow(/cannot write to the database .* owned by the user running the server/);
    } finally {
      chmodSync(file, 0o644);
    }
    expect(open(file).checkWritable()).toBeNull();
  });

  it('pulls one chart in updated_at order from a cursor, with strictly increasing timestamps', () => {
    const s = open(':memory:', () => Date.UTC(2026, 0, 1)); // a frozen clock must not produce ties
    const id = (n: number) => `e0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    for (let n = 1; n <= 3; n++) s.apply(A, [checkChange({ id: id(n), op_id: op(n), ...KEY, kind: 'line', data: { n } })], 100);
    s.apply(A, [checkChange({ id: id(9), op_id: op(9), ...KEY, timeframe: '4h', kind: 'line', data: {} })], 100);
    const rows = s.pull(A, KEY, null, 10);
    expect(rows.map((r) => r.id)).toEqual([id(1), id(2), id(3)]);
    expect(new Set(rows.map((r) => r.updated_at)).size).toBe(3);
    expect(s.pull(A, KEY, rows[1].updated_at, 10).map((r) => r.id)).toEqual([id(2), id(3)]);
    expect(s.pull(A, KEY, null, 2)).toHaveLength(2);
  });

  it('persists to a file, migrates once and refuses a database from a newer version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dac-store-'));
    dirs.push(dir);
    const file = join(dir, 'drawings.sqlite');
    const first = open(file);
    first.apply(A, [change(op(1), 0, { v: 1 })], 100);
    first.close();
    const reopened = open(file);
    expect(reopened.pull(A, KEY, null, 10)).toHaveLength(1);
    // A later write still gets a later timestamp than everything already stored.
    const before = reopened.pull(A, KEY, null, 10)[0].updated_at;
    const [updated] = reopened.apply(A, [change(op(2), 1, { v: 2 })], 100).results;
    expect(updated.row!.updated_at > before).toBe(true);
    reopened.close();

    const raw = new DatabaseSync(file);
    raw.exec('pragma user_version = 99');
    raw.close();
    expect(() => new DrawingStore(file)).toThrow(/newer than this server/);
  });

  it('restore.ts puts a backup in place, drops a stale write-ahead log and renews the generation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dac-restore-'));
    dirs.push(dir);
    const file = join(dir, 'drawings.sqlite');
    const live = open(file);
    live.apply(A, [change(op(1), 0, { v: 1 })], 100);
    const backup = join(dir, 'backup.sqlite');
    backupDatabase(file, backup);
    live.apply(A, [change(op(2), 1, { v: 2 })], 100); // after the backup: sits in the WAL
    const oldGeneration = live.generation;
    expect(existsSync(`${file}-wal`)).toBe(true);
    copyFileSync(`${file}-wal`, join(dir, 'stale-wal')); // as if the server had died with it
    live.close();
    copyFileSync(join(dir, 'stale-wal'), `${file}-wal`);

    const output = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/restore.ts', backup], {
      env: { ...process.env, DB_FILE: file },
      encoding: 'utf8',
    });
    expect(output).toMatch(/restored .* \(generation [0-9a-f]{32}\)/);
    const restored = open(file);
    expect(restored.pull(A, KEY, null, 10)).toMatchObject([{ rev: 1, data: { v: 1 } }]); // the WAL was not replayed
    expect(restored.generation).not.toBe(oldGeneration);
  });

  it('backs up a live database to a new file (and never overwrites one)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dac-backup-'));
    dirs.push(dir);
    const file = join(dir, 'drawings.sqlite');
    const live = open(file);
    live.apply(A, [change(op(1), 0, { v: 1 })], 100);
    const copy = join(dir, "backup 'one'.sqlite");
    backupDatabase(file, copy);
    live.apply(A, [change(op(2), 1, { v: 2 })], 100); // the server keeps writing
    expect(open(copy).pull(A, KEY, null, 10)).toMatchObject([{ rev: 1, data: { v: 1 } }]);
    expect(() => backupDatabase(file, copy)).toThrow(/already exists/);
  });
});
