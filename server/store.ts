import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { ChangeResult, RemoteRow } from '../src/sync/protocol.ts';
import type { CheckedChange } from './validate.ts';

/** Schema migrations, applied in order and tracked in `PRAGMA user_version`. Never edit a shipped one. */
const MIGRATIONS: readonly string[] = [
  `create table drawings (
     id          text primary key,
     user_id     text not null,
     provider    text not null,
     symbol      text not null,
     timeframe   text not null,
     kind        text not null,
     data        text not null,
     deleted     integer not null default 0,
     rev         integer not null,
     last_op_id  text not null,
     created_at  text not null,
     updated_at  text not null
   ) strict;
   create index drawings_user_chart_updated on drawings (user_id, provider, symbol, timeframe, updated_at);`,
  // The generation identifies this database's history. It changes when the database is replaced by
  // a restore (server/restore.ts); a new database gets a new one anyway. Devices compare it to
  // notice that the server went back in time and resynchronize (see SyncEngine).
  `create table meta (key text primary key, value text not null) strict;
   insert into meta (key, value) values ('generation', lower(hex(randomblob(16))));`,
];

interface DbRow {
  readonly id: string;
  readonly user_id: string;
  readonly provider: string;
  readonly symbol: string;
  readonly timeframe: string;
  readonly kind: string;
  readonly data: string;
  readonly deleted: number;
  readonly rev: number;
  readonly last_op_id: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ChartKeyInput {
  readonly provider: string;
  readonly symbol: string;
  readonly timeframe: string;
}

/**
 * Drawings, one row per drawing, each owned by a user (`user_id`). Writes use optimistic
 * compare-and-swap on `rev`:
 * - unknown id: insert at rev 1;
 * - id owned by another user: rejected (reveals nothing);
 * - same op id as the last applied op: duplicate (idempotent retry after a lost response);
 * - rev = base_rev, or the row was last written by one of this client's own unacknowledged ops
 *   (`prev_op_ids`): applied, rev + 1;
 * - otherwise: conflict, and the server version wins.
 * Deletions are tombstones (`deleted`, previous data kept) so they reach devices that were offline.
 */
export class DrawingStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  /** Last issued updated_at (ms): timestamps strictly increase, so pull cursors never skip a write. */
  private lastStamp: number;
  private closed = false;
  private readonly sql: Readonly<Record<'get' | 'live' | 'insert' | 'update' | 'pull', StatementSync>>;

  constructor(file: string, options: { readonly now?: () => number } = {}) {
    this.db = new DatabaseSync(file);
    try {
      // synchronous=full: a committed write survives a power loss (normal would roll it back,
      // silently desynchronizing devices that already received it).
      this.db.exec('pragma journal_mode = wal; pragma synchronous = full; pragma busy_timeout = 5000;');
      migrate(this.db);
      const problem = this.checkWritable();
      if (problem) throw new Error(problem);
    } catch (err) {
      this.db.close();
      const reason = err instanceof Error ? err.message : String(err);
      if (!/readonly/i.test(reason)) throw err;
      throw new Error(`cannot write to the database ${file} (${reason}). Is the file owned by the user running the server?`, { cause: err });
    }
    this.now = options.now ?? Date.now;
    this.sql = {
      get: this.db.prepare('select * from drawings where id = ?'),
      live: this.db.prepare('select count(*) as n from drawings where user_id = ? and deleted = 0'),
      insert: this.db.prepare(
        `insert into drawings (id, user_id, provider, symbol, timeframe, kind, data, deleted, rev, last_op_id, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      ),
      update: this.db.prepare('update drawings set kind = ?, data = ?, deleted = ?, rev = rev + 1, last_op_id = ?, updated_at = ? where id = ?'),
      pull: this.db.prepare(
        'select * from drawings where user_id = ? and provider = ? and symbol = ? and timeframe = ? and updated_at >= ? order by updated_at, id limit ?',
      ),
    };
    const max = this.db.prepare('select max(updated_at) as t from drawings').get() as { t: string | null } | undefined;
    this.lastStamp = max?.t ? Date.parse(max.t) : 0;
  }

  /** Identifies this database's history (see MIGRATIONS). */
  get generation(): string {
    return (this.db.prepare("select value from meta where key = 'generation'").get() as { value: string }).value;
  }

  /** Marks the database as a different history (after a restore). Returns the new generation. */
  renewGeneration(): string {
    this.db.exec("update meta set value = lower(hex(randomblob(16))) where key = 'generation'");
    return this.generation;
  }

  /**
   * Null when the database accepts writes, else the reason. A read-only file (e.g. owned by
   * another user) opens without error and only fails on the first write, so this writes (and
   * rolls back).
   */
  checkWritable(): string | null {
    try {
      this.db.exec('begin immediate');
      try {
        this.db.exec("update meta set value = value where key = 'generation'");
      } finally {
        this.db.exec('rollback');
      }
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * Applies one batch atomically. Returns a result per change and the rows that changed.
   * `maxRows` limits a user's live (non-deleted) drawings; a change that would exceed it is
   * reported as invalid on its own, so the rest of the batch, and every edit or deletion,
   * still goes through.
   */
  apply(userId: string, changes: readonly CheckedChange[], maxRows: number): { results: ChangeResult[]; changed: RemoteRow[] } {
    const results: ChangeResult[] = [];
    const changed: RemoteRow[] = [];
    const overQuota = (id: string): ChangeResult => ({ id, status: 'invalid', row: null, error: `drawing quota exceeded (max ${maxRows})` });
    this.db.exec('begin immediate');
    try {
      let live = (this.sql.live.get(userId) as { n: number }).n;
      for (const checked of changes) {
        if (!checked.ok) {
          results.push({ id: checked.id, status: 'invalid', row: null, error: checked.error });
          continue;
        }
        const c = checked.change;
        const cur = this.sql.get.get(c.id) as DbRow | undefined;
        if (!cur) {
          if (!c.deleted && live >= maxRows) {
            results.push(overQuota(c.id));
            continue;
          }
          const stamp = this.stamp();
          this.sql.insert.run(c.id, userId, c.provider, c.symbol, c.timeframe, c.kind, c.data ?? '{}', c.deleted ? 1 : 0, c.opId, stamp, stamp);
          if (!c.deleted) live++;
          const row = this.row(c.id);
          changed.push(row);
          results.push({ id: c.id, status: 'applied', row });
        } else if (cur.user_id !== userId) {
          results.push({ id: c.id, status: 'rejected', row: null });
        } else if (cur.last_op_id === c.opId) {
          results.push({ id: c.id, status: 'duplicate', row: toRemote(cur) });
        } else if (cur.rev === c.baseRev || c.prevOpIds.includes(cur.last_op_id)) {
          const revives = cur.deleted === 1 && !c.deleted;
          if (revives && live >= maxRows) {
            results.push(overQuota(c.id));
            continue;
          }
          const data = c.deleted ? cur.data : (c.data ?? cur.data);
          this.sql.update.run(c.kind, data, c.deleted ? 1 : 0, c.opId, this.stamp(), c.id);
          if (revives) live++;
          else if (cur.deleted === 0 && c.deleted) live--;
          const row = this.row(c.id);
          changed.push(row);
          results.push({ id: c.id, status: 'applied', row });
        } else {
          results.push({ id: c.id, status: 'conflict', row: toRemote(cur) });
        }
      }
      this.db.exec('commit');
    } catch (err) {
      this.db.exec('rollback');
      throw err;
    }
    return { results, changed };
  }

  /** Rows of one chart with updated_at >= since, oldest first. */
  pull(userId: string, key: ChartKeyInput, since: string | null, limit: number): RemoteRow[] {
    const rows = this.sql.pull.all(userId, key.provider, key.symbol, key.timeframe, since ?? '', limit) as unknown as DbRow[];
    return rows.map(toRemote);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private row(id: string): RemoteRow {
    return toRemote(this.sql.get.get(id) as unknown as DbRow);
  }

  private stamp(): string {
    this.lastStamp = Math.max(this.now(), this.lastStamp + 1);
    return new Date(this.lastStamp).toISOString();
  }
}

/**
 * Consistent copy of a database file, safe while the server keeps writing to it (VACUUM INTO on a
 * read-only connection). Refuses to overwrite an existing file.
 */
export function backupDatabase(source: string, target: string): void {
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec(`vacuum into '${target.replaceAll("'", "''")}'`);
  } finally {
    db.close();
  }
}

function migrate(db: DatabaseSync): void {
  const { user_version: version } = db.prepare('pragma user_version').get() as { user_version: number };
  if (version > MIGRATIONS.length) throw new Error(`database schema v${version} is newer than this server (v${MIGRATIONS.length})`);
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('begin');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`pragma user_version = ${v + 1}`);
      db.exec('commit');
    } catch (err) {
      db.exec('rollback');
      throw err;
    }
  }
}

function toRemote(r: DbRow): RemoteRow {
  return {
    id: r.id,
    provider: r.provider,
    symbol: r.symbol,
    timeframe: r.timeframe,
    kind: r.kind,
    data: JSON.parse(r.data) as unknown,
    deleted: r.deleted === 1,
    rev: r.rev,
    updated_at: r.updated_at,
  };
}
