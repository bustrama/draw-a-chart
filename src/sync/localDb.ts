import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { uuid } from '../lib/ids';
import { chartKeyString, parseDrawing, type ChartKey, type Drawing, type DrawingKind } from '../drawing/model';
import type { Mutation } from '../drawing/store';
import type { TimeframeId } from '../market/types';

/** Local copy of a drawing (or its tombstone) plus sync metadata. */
export interface StoredDrawing {
  readonly id: string;
  /** chartKeyString(provider:symbol:timeframe) */
  readonly chart: string;
  readonly drawing: Drawing | null;
  readonly deleted: boolean;
  /** Last server revision this record reflects (0 = never synced). */
  readonly rev: number;
  readonly updatedAt: number;
}

/**
 * Pending change for one drawing (coalesced: at most one entry per drawing).
 * `baseRev` is the server revision the change was made against (0 = new drawing).
 */
export interface OutboxEntry {
  readonly id: string;
  readonly chart: string;
  readonly key: ChartKey;
  readonly kind: DrawingKind;
  readonly opId: string;
  readonly baseRev: number;
  readonly drawing: Drawing | null;
  readonly deleted: boolean;
  readonly queuedAt: number;
  /** Signed-in user who made the change; null = made while signed out (adopted on sign-in). */
  readonly owner: string | null;
  /** Whether `opId` has been sent at least once (its response may have been lost). */
  readonly sent: boolean;
  /**
   * Superseded op ids for this drawing that were sent but never acknowledged. If the server row
   * was last written by one of them, it is this client's own earlier state, not a conflict.
   */
  readonly prevOpIds: readonly string[];
}

/** A server row as it arrives from Supabase (RPC result, pull, or realtime). */
export interface RemoteRow {
  readonly id: string;
  readonly provider: string;
  readonly symbol: string;
  readonly timeframe: string;
  readonly kind: string;
  readonly data: unknown;
  readonly deleted: boolean;
  readonly rev: number;
  readonly updated_at: string;
}

export type AckStatus = 'applied' | 'duplicate' | 'conflict' | 'rejected' | 'invalid';

interface Schema extends DBSchema {
  drawings: { key: string; value: StoredDrawing; indexes: { chart: string } };
  outbox: { key: string; value: OutboxEntry; indexes: { queuedAt: number } };
  meta: { key: string; value: unknown };
}

export const DB_NAME = 'draw-a-chart';
const DB_VERSION = 1;
const MAX_PREV_OP_IDS = 8;

/** Result of merging remote rows: what to apply to open documents, per chart. */
export type RemoteChanges = Map<string, Mutation[]>;

/**
 * IndexedDB-backed drawing repository. Every local edit writes the drawing record and its outbox
 * entry in ONE transaction, so a crash can never leave a change that is saved but not queued
 * (or queued but not saved).
 */
export class LocalDrawingDb {
  readonly name: string;
  private readonly dbPromise: Promise<IDBPDatabase<Schema>>;

  constructor(name = DB_NAME) {
    this.name = name;
    this.dbPromise = openDB<Schema>(name, DB_VERSION, {
      upgrade(db) {
        const drawings = db.createObjectStore('drawings', { keyPath: 'id' });
        drawings.createIndex('chart', 'chart');
        const outbox = db.createObjectStore('outbox', { keyPath: 'id' });
        outbox.createIndex('queuedAt', 'queuedAt');
        db.createObjectStore('meta');
      },
    });
  }

  /** Non-deleted drawings of one chart. */
  async loadChart(chart: string): Promise<Drawing[]> {
    const db = await this.dbPromise;
    const rows = await db.getAllFromIndex('drawings', 'chart', chart);
    const out: Drawing[] = [];
    for (const r of rows) {
      if (r.deleted || !r.drawing) continue;
      const d = parseDrawing(r.drawing);
      if (d) out.push(d);
    }
    return out;
  }

  async getRecord(id: string): Promise<StoredDrawing | undefined> {
    return (await this.dbPromise).get('drawings', id);
  }

  async getEntry(id: string): Promise<OutboxEntry | undefined> {
    return (await this.dbPromise).get('outbox', id);
  }

  /**
   * Persists local mutations and queues them for sync.
   *
   * Concurrency: the change's base revision is derived only from state inside this transaction
   * (the pending entry's base, else the record's rev). If a previous change for the same drawing
   * is in flight, `acknowledge` rebases this entry (same base => successor edit); if that previous
   * change was sent but its answer was lost, its op id travels along in `prevOpIds`. Deletions are
   * always queued as tombstones, even for drawings that may not have reached the server yet: the
   * create could be in flight, and a tombstone is the only race-free answer.
   */
  async applyLocal(key: ChartKey, mutations: readonly Mutation[], owner: string | null = null): Promise<void> {
    if (mutations.length === 0) return;
    const chart = chartKeyString(key);
    const db = await this.dbPromise;
    const tx = db.transaction(['drawings', 'outbox'], 'readwrite');
    const drawings = tx.objectStore('drawings');
    const outbox = tx.objectStore('outbox');
    const now = Date.now();
    for (const m of mutations) {
      const id = m.op === 'put' ? m.drawing.id : m.id;
      const deleted = m.op === 'delete';
      const drawing = m.op === 'put' ? m.drawing : null;
      const [rec, pending] = await Promise.all([drawings.get(id), outbox.get(id)]);
      const rev = rec?.rev ?? 0;
      const kind: DrawingKind = drawing?.kind ?? rec?.drawing?.kind ?? pending?.kind ?? 'ink';
      await drawings.put({ id, chart, drawing, deleted, rev, updatedAt: now });
      const prevOpIds = pending ? (pending.sent ? [...pending.prevOpIds, pending.opId] : [...pending.prevOpIds]).slice(-MAX_PREV_OP_IDS) : [];
      await outbox.put({
        id,
        chart,
        key,
        kind,
        opId: uuid(),
        baseRev: pending ? pending.baseRev : rev,
        drawing,
        deleted,
        queuedAt: pending?.queuedAt ?? now,
        owner: pending?.owner ?? owner,
        sent: false,
        prevOpIds,
      });
    }
    await tx.done;
  }

  /** Oldest pending changes the given user may send (their own and signed-out ones). */
  async pendingFor(owner: string | null, limit = 50): Promise<OutboxEntry[]> {
    const db = await this.dbPromise;
    const out: OutboxEntry[] = [];
    let cursor = await db.transaction('outbox').store.index('queuedAt').openCursor();
    while (cursor && out.length < limit) {
      if (cursor.value.owner === null || cursor.value.owner === owner) out.push(cursor.value);
      cursor = await cursor.continue();
    }
    return out;
  }

  /** Number of pending changes visible to the given user (all of them when `owner` is undefined). */
  async pendingCount(owner?: string | null): Promise<number> {
    const db = await this.dbPromise;
    if (owner === undefined) return db.count('outbox');
    let n = 0;
    let cursor = await db.transaction('outbox').store.openCursor();
    while (cursor) {
      if (cursor.value.owner === null || cursor.value.owner === owner) n++;
      cursor = await cursor.continue();
    }
    return n;
  }

  /** Records that these entries are about to be sent (so later edits keep their op ids). */
  async markSent(entries: readonly OutboxEntry[], owner: string): Promise<void> {
    const db = await this.dbPromise;
    const tx = db.transaction('outbox', 'readwrite');
    for (const e of entries) {
      const current = await tx.store.get(e.id);
      if (current && current.opId === e.opId) await tx.store.put({ ...current, sent: true, owner: current.owner ?? owner });
    }
    await tx.done;
  }

  /**
   * Records the server's answer for a sent change.
   * - applied/duplicate: record takes the server rev; the outbox entry is removed if it is still
   *   the one that was sent, or rebased (baseRev := rev) if a newer local edit replaced it.
   * - conflict/rejected: the server version wins (returned so open documents can be updated).
   * - invalid: the change can never be stored remotely; it is dropped from the outbox and the
   *   drawing stays on this device only.
   */
  async acknowledge(sent: OutboxEntry, status: AckStatus, row: RemoteRow | null): Promise<RemoteChanges> {
    const db = await this.dbPromise;
    const tx = db.transaction(['drawings', 'outbox'], 'readwrite');
    const drawings = tx.objectStore('drawings');
    const outbox = tx.objectStore('outbox');
    const changes: RemoteChanges = new Map();
    const current = await outbox.get(sent.id);
    if (status === 'applied' || status === 'duplicate') {
      const rev = row?.rev ?? sent.baseRev + 1;
      const rec = await drawings.get(sent.id);
      const successor = current !== undefined && current.opId !== sent.opId && current.baseRev === sent.baseRev;
      if (successor) {
        // A newer local edit was queued on top of the change we just sent: keep it, rebase it.
        if (rec) await drawings.put({ ...rec, rev });
        await outbox.put({ ...current, baseRev: rev, prevOpIds: current.prevOpIds.filter((op) => op !== sent.opId) });
      } else {
        if (current && current.opId === sent.opId) await outbox.delete(sent.id);
        if (status === 'duplicate' && row && (!rec || row.rev > rec.rev)) {
          // Our change was applied earlier (lost response) and the row may have moved on since:
          // adopt the server state rather than assuming it still equals what we sent.
          const m = await this.adoptRow(drawings, row);
          if (m) push(changes, m.chart, m.mutation);
        } else if (rec) {
          await drawings.put({ ...rec, rev });
        }
      }
    } else if (status === 'invalid') {
      if (current && current.opId === sent.opId) await outbox.delete(sent.id);
    } else {
      // Conflict or rejection: drop our queued change(s) for this drawing, adopt the server state.
      await outbox.delete(sent.id);
      if (row) {
        const m = await this.adoptRow(drawings, row);
        if (m) push(changes, m.chart, m.mutation);
      } else {
        const rec = await drawings.get(sent.id);
        if (rec && rec.rev === 0) {
          await drawings.delete(sent.id);
          push(changes, rec.chart, { op: 'delete', id: sent.id });
        }
      }
    }
    await tx.done;
    return changes;
  }

  /**
   * Merges rows pulled from the server or received via realtime. Rows are ignored when the local
   * record already has that revision or when a local change for the drawing is pending (our
   * compare-and-swap will resolve it).
   */
  async mergeRemote(rows: readonly RemoteRow[]): Promise<RemoteChanges> {
    const db = await this.dbPromise;
    const tx = db.transaction(['drawings', 'outbox'], 'readwrite');
    const drawings = tx.objectStore('drawings');
    const outbox = tx.objectStore('outbox');
    const changes: RemoteChanges = new Map();
    for (const row of rows) {
      if (await outbox.get(row.id)) continue;
      const rec = await drawings.get(row.id);
      if (rec && rec.rev >= row.rev) continue;
      const m = await this.adoptRow(drawings, row);
      if (m) push(changes, m.chart, m.mutation);
    }
    await tx.done;
    return changes;
  }

  async getMeta<T>(key: string): Promise<T | undefined> {
    return (await (await this.dbPromise).get('meta', key)) as T | undefined;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    await (await this.dbPromise).put('meta', value, key);
  }

  async close(): Promise<void> {
    (await this.dbPromise).close();
  }

  private async adoptRow(
    drawings: { put(v: StoredDrawing): Promise<unknown> },
    row: RemoteRow,
  ): Promise<{ chart: string; mutation: Mutation } | null> {
    const chart = chartKeyString({ provider: row.provider, symbol: row.symbol, timeframe: row.timeframe as TimeframeId });
    const drawing = row.deleted ? null : parseDrawing(row.data);
    if (!row.deleted && !drawing) return null; // corrupt/unsupported row: ignore
    await drawings.put({ id: row.id, chart, drawing, deleted: row.deleted, rev: row.rev, updatedAt: Date.now() });
    return { chart, mutation: drawing ? { op: 'put', drawing } : { op: 'delete', id: row.id } };
  }
}

function push(changes: RemoteChanges, chart: string, m: Mutation): void {
  const list = changes.get(chart);
  if (list) list.push(m);
  else changes.set(chart, [m]);
}
