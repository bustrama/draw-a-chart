import { DatabaseSync, type StatementSync } from 'node:sqlite';

/** One bar as stored: open time (Unix ms) and OHLCV. */
export interface Bar {
  readonly t: number;
  readonly o: number;
  readonly h: number;
  readonly l: number;
  readonly c: number;
  readonly v: number;
}

/** Schema migrations, applied in order and tracked in `PRAGMA user_version`. Never edit a shipped one. */
const MIGRATIONS: readonly string[] = [
  `create table series (
     id      integer primary key,
     market  text not null,
     symbol  text not null,
     tf      text not null,
     unique (market, symbol, tf)
   ) strict;
   create table bars (
     series  integer not null,
     t       integer not null,
     o real not null, h real not null, l real not null, c real not null, v real not null,
     primary key (series, t)
   ) strict, without rowid;
   create table coverage (
     series   integer not null,
     first_t  integer not null,
     last_t   integer not null,
     primary key (series, first_t)
   ) strict, without rowid;
   create table meta (key text primary key, value text not null) strict;`,
];

/**
 * The market-data cache: closed bars per series (market + symbol + timeframe) and, per series,
 * the time ranges known to be complete ("coverage": every bar the upstream has with an open time
 * in the range is stored). Requests fetch only what is not covered. Ranges the upstream has no
 * bars for (nights, before a listing, exchange outages) are covered too, so they are never
 * requested again.
 *
 * It is a cache: its own file, never backed up, safe to delete (it refills on demand).
 */
export class BarCache {
  private readonly db: DatabaseSync;
  private readonly ids = new Map<string, number>();
  private readonly sql: Readonly<Record<'seriesGet' | 'seriesAdd' | 'put' | 'range' | 'coverage' | 'uncover' | 'cover' | 'metaGet' | 'metaSet', StatementSync>>;
  private closed = false;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    try {
      // A cache: losing the last writes in a power cut only means fetching them again.
      this.db.exec('pragma journal_mode = wal; pragma synchronous = normal; pragma busy_timeout = 5000;');
      migrate(this.db);
    } catch (err) {
      this.db.close();
      throw err;
    }
    this.sql = {
      seriesGet: this.db.prepare('select id from series where market = ? and symbol = ? and tf = ?'),
      seriesAdd: this.db.prepare('insert into series (market, symbol, tf) values (?, ?, ?)'),
      put: this.db.prepare('insert or replace into bars (series, t, o, h, l, c, v) values (?, ?, ?, ?, ?, ?, ?)'),
      range: this.db.prepare('select t, o, h, l, c, v from bars where series = ? and t between ? and ? order by t'),
      coverage: this.db.prepare('select first_t, last_t from coverage where series = ? order by first_t'),
      uncover: this.db.prepare('delete from coverage where series = ? and first_t = ?'),
      cover: this.db.prepare('insert into coverage (series, first_t, last_t) values (?, ?, ?)'),
      metaGet: this.db.prepare('select value from meta where key = ?'),
      metaSet: this.db.prepare('insert or replace into meta (key, value) values (?, ?)'),
    };
  }

  /** Id of a series, created on first use. */
  series(market: string, symbol: string, tf: string): number {
    const key = `${market}\u0000${symbol}\u0000${tf}`;
    const cached = this.ids.get(key);
    if (cached !== undefined) return cached;
    let row = this.sql.seriesGet.get(market, symbol, tf) as { id: number } | undefined;
    if (!row) {
      this.sql.seriesAdd.run(market, symbol, tf);
      row = this.sql.seriesGet.get(market, symbol, tf) as { id: number };
    }
    this.ids.set(key, row.id);
    return row.id;
  }

  /** Stored bars with open times in [from, to], oldest first. */
  range(series: number, from: number, to: number): Bar[] {
    return this.sql.range.all(series, from, to) as unknown as Bar[];
  }

  /** Complete ranges of a series, sorted and merged. */
  coverage(series: number): Array<[number, number]> {
    return (this.sql.coverage.all(series) as Array<{ first_t: number; last_t: number }>).map((r) => [r.first_t, r.last_t]);
  }

  /** Parts of [from, to] (inclusive, integer ms) that are not covered, oldest first. */
  missing(series: number, from: number, to: number): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    let cursor = from;
    for (const [a, b] of this.coverage(series)) {
      if (b < cursor) continue;
      if (a > to) break;
      if (a > cursor) out.push([cursor, a - 1]);
      cursor = Math.max(cursor, b + 1);
      if (cursor > to) break;
    }
    if (cursor <= to) out.push([cursor, to]);
    return out;
  }

  /**
   * Stores bars fetched for [from, to] and marks the range complete, in one transaction: coverage
   * never claims bars that were not stored. `bars` must be every bar the upstream has in the range.
   */
  store(series: number, bars: readonly Bar[], from: number, to: number): void {
    this.db.exec('begin immediate');
    try {
      for (const b of bars) {
        if (b.t < from || b.t > to) continue;
        this.sql.put.run(series, b.t, b.o, b.h, b.l, b.c, b.v);
      }
      // Merge with every range that overlaps or touches [from, to].
      let first = from;
      let last = to;
      for (const [a, b] of this.coverage(series)) {
        if (b < from - 1 || a > to + 1) continue;
        first = Math.min(first, a);
        last = Math.max(last, b);
        this.sql.uncover.run(series, a);
      }
      this.sql.cover.run(series, first, last);
      this.db.exec('commit');
    } catch (err) {
      this.db.exec('rollback');
      throw err;
    }
  }

  /** Forgets every series of a symbol (e.g. after a stock split changed its adjusted history). */
  purgeSymbol(market: string, symbol: string): void {
    this.db.exec('begin immediate');
    try {
      const ids = (this.db.prepare('select id from series where market = ? and symbol = ?').all(market, symbol) as Array<{ id: number }>).map((r) => r.id);
      for (const id of ids) {
        this.db.prepare('delete from bars where series = ?').run(id);
        this.db.prepare('delete from coverage where series = ?').run(id);
      }
      this.db.exec('commit');
    } catch (err) {
      this.db.exec('rollback');
      throw err;
    }
  }

  getMeta(key: string): string | null {
    return (this.sql.metaGet.get(key) as { value: string } | undefined)?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.sql.metaSet.run(key, value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

function migrate(db: DatabaseSync): void {
  const { user_version: version } = db.prepare('pragma user_version').get() as { user_version: number };
  if (version > MIGRATIONS.length) throw new Error(`market cache schema v${version} is newer than this server (v${MIGRATIONS.length})`);
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
