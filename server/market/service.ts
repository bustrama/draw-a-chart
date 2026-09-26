import { fixedClock, globexSessions, NEW_YORK, SessionCalendar, sessionsFromCalendar, stepBack, stepForward, zonedDate, type BarClock } from '../../shared/sessions.ts';
import type { MarketStatus, SymbolMatch, WireSession, WireSymbol } from '../../src/market/protocol.ts';
import type { TimeframeId } from '../../src/market/types.ts';
import { ALPACA_HISTORY_START, type AlpacaTimeframe, type CalendarRow, type StockSymbol } from './alpaca.ts';
import { tickDecimals, type CryptoSymbol } from './binance.ts';
import type { Bar, BarCache } from './cache.ts';
import { FUTURES, FUTURES_BY_SYMBOL } from './futures.ts';
import { toSessionBars } from './sessionBars.ts';
import type { YahooInterval } from './yahoo.ts';

export type MarketId = 'binance' | 'us' | 'futures';

export const TIMEFRAME_MS: Readonly<Record<TimeframeId, number>> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 3_600_000,
  '4h': 4 * 3_600_000,
  '1d': 86_400_000,
};

export function isTimeframe(value: string): value is TimeframeId {
  return Object.hasOwn(TIMEFRAME_MS, value);
}

/** Alpaca bars each timeframe is built from (hourly bars from 30-minute ones, to start at 9:30). */
const US_SOURCE: Readonly<Record<TimeframeId, AlpacaTimeframe>> = { '1m': '1Min', '5m': '5Min', '15m': '15Min', '1h': '30Min', '4h': '30Min', '1d': '1Day' };
/**
 * Yahoo bars each futures timeframe is built from. 4-hour and daily bars come from hourly ones, so
 * every timeframe shows the same contract at every moment (Yahoo's own daily bars switch to the
 * next contract on another day); Yahoo's daily bars only serve dates its hourly history misses.
 */
const FUTURES_SOURCE: Readonly<Record<TimeframeId, YahooInterval>> = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '60m', '4h': '60m', '1d': '60m' };
/** Yahoo's futures history starts in 2000 (so does the futures calendar). */
const FUTURES_HISTORY_START = Date.UTC(2000, 0, 3);
/** Futures bars are final this long after they end, on top of Yahoo's delay (it may report late). */
const FUTURES_SETTLE_MS = 10 * 60_000;
/** Sessions sent to the app start here: it only needs them around the bars it shows. */
const WIRE_SESSIONS_FROM = Date.UTC(2015, 11, 1);

const BINANCE_HISTORY_START = Date.UTC(2017, 6, 14);
const DAY = 86_400_000;
/** Symbol lists and the calendar are refreshed in the background when older than this. */
const SYMBOLS_MAX_AGE = DAY;
const CALENDAR_MAX_AGE = 7 * DAY;
/** The forming bar is fetched fresh, but reused this long (several devices polling at once). */
const FORMING_TTL_MS = 15_000;
/** Chunks per request when the upstream has fewer bars than slots (thinly traded stocks). */
const MAX_ROUNDS = 4;
/** A failed upstream load (symbol list, calendar, split check) is not retried sooner than this. */
const RETRY_AFTER_FAILURE_MS = 2 * 60_000;
/** Bars wait this long at most for the daily split check (it goes on in the background). */
const SPLIT_CHECK_WAIT_MS = 2_000;
/**
 * A US daily bar is final after the extended session (20:00, 4 hours after the regular close): its
 * volume counts pre- and post-market trades.
 */
const US_DAILY_SETTLE_MS = 4 * 3_600_000 + 60_000;
export const MAX_LIMIT = 1500;

/** A request the service refuses: 400 bad input, 404 unknown symbol, 503 market not set up. */
export class MarketError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface BarsRequest {
  readonly market: string;
  readonly symbol: string;
  readonly tf: TimeframeId;
  readonly limit: number;
  readonly start?: number;
  readonly end?: number;
}

export interface OutBar extends Bar {
  /** False for the bar still forming (and for the last one when it may still get late trades). */
  readonly closed: boolean;
}

/** What the service needs from a crypto upstream (BinanceUpstream). */
export interface CryptoUpstream {
  klines(symbol: string, interval: string, from: number, to: number): Promise<Bar[]>;
  symbols(): Promise<CryptoSymbol[]>;
}

/** What the service needs from a US stock upstream (AlpacaUpstream). */
export interface StockUpstream {
  readonly delayMs: number;
  bars(symbol: string, timeframe: AlpacaTimeframe, start: number, end: number): Promise<Bar[]>;
  calendar(start: string, end: string): Promise<CalendarRow[]>;
  assets(): Promise<StockSymbol[]>;
  splits(symbol: string, start: string, end: string): Promise<string[]>;
}

/** What the service needs from a futures upstream (YahooUpstream). */
export interface FuturesUpstream {
  readonly delayMs: number;
  /** Earliest time bars of `interval` can still be fetched; null = all history. */
  historyStart(interval: YahooInterval): number | null;
  /** Bars opening in [start, end], oldest first (nothing older than the history start). */
  bars(ticker: string, interval: YahooInterval, start: number, end: number): Promise<Bar[]>;
}

/** How one market's upstream behaves. */
interface Source {
  readonly market: MarketId;
  readonly historyStart: number;
  /** A bar is final once its end is this much older than the data time. */
  settle(tf: TimeframeId): number;
  /** Newest time the upstream has data for (now minus its delay). */
  dataTime(now: number): number;
  /** Every upstream bar opening in [first, last] (bar opens of `clock`), oldest first. */
  fetch(symbol: string, tf: TimeframeId, clock: BarClock, first: number, last: number): Promise<Bar[]>;
}

/** Markets whose symbols come from their upstream (futures have a fixed list). */
type ListedMarket = 'binance' | 'us';
const LISTED: readonly ListedMarket[] = ['binance', 'us'];

interface SymbolList<T> {
  readonly at: number;
  readonly items: ReadonlyMap<string, T>;
}

export interface MarketServiceOptions {
  readonly cache: BarCache;
  readonly binance?: CryptoUpstream | null;
  readonly alpaca?: StockUpstream | null;
  readonly yahoo?: FuturesUpstream | null;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
  /** How long bars wait for the daily split check (tests shorten it). */
  readonly splitCheckWaitMs?: number;
}

/**
 * Market data for the app: symbol search and details, the US trading calendar, and bars served
 * from the cache (server/market/cache.ts). Closed bars are fetched from upstream once, only the
 * ranges the cache does not cover; the forming bar is always fetched fresh (briefly reused).
 *
 * Bar slots follow each market's clock: every interval around the clock for crypto; regular
 * hours for US stocks (9:30-16:00 New York, the calendar's holidays and early closes); CME Globex
 * hours for futures (18:00-17:00 New York, Sunday evening to Friday). Nights, breaks and weekends
 * never count as missing data.
 */
export class MarketService {
  private readonly cache: BarCache;
  private readonly binance: CryptoUpstream | null;
  private readonly alpaca: StockUpstream | null;
  private readonly yahoo: FuturesUpstream | null;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly sources = new Map<MarketId, Source>();
  private readonly lists = new Map<MarketId, SymbolList<unknown>>();
  private readonly listLoads = new Map<MarketId, Promise<SymbolList<unknown>>>();
  private calendarState: { at: number; rows: CalendarRow[]; calendar: SessionCalendar } | null = null;
  private calendarLoad: Promise<SessionCalendar> | null = null;
  private futures: { year: number; calendar: SessionCalendar } | null = null;
  private readonly locks = new Map<number, Promise<unknown>>();
  private readonly forming = new Map<number, { at: number; first: number; last: number; bars: Bar[] }>();
  private readonly splitChecks = new Map<string, Promise<void>>();
  /** When a failed load (by key) may be tried again. */
  private readonly retryAt = new Map<string, number>();
  private readonly splitCheckWaitMs: number;

  constructor(options: MarketServiceOptions) {
    this.splitCheckWaitMs = options.splitCheckWaitMs ?? SPLIT_CHECK_WAIT_MS;
    this.cache = options.cache;
    this.binance = options.binance ?? null;
    this.alpaca = options.alpaca ?? null;
    this.yahoo = options.yahoo ?? null;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? ((m) => console.log(m));
    const binance = this.binance;
    if (binance) {
      this.sources.set('binance', {
        market: 'binance',
        historyStart: BINANCE_HISTORY_START,
        // Margin for clock skew and for the exchange finishing the bar: never cache it too early.
        settle: () => 10_000,
        dataTime: (now) => now,
        fetch: (symbol, tf, _clock, first, last) => binance.klines(symbol, tf, first, last),
      });
    }
    const alpaca = this.alpaca;
    if (alpaca) {
      this.sources.set('us', {
        market: 'us',
        historyStart: ALPACA_HISTORY_START,
        // Trades may still be reported for a minute or so after a bar ends.
        settle: (tf) => (tf === '1d' ? US_DAILY_SETTLE_MS : 60_000),
        dataTime: (now) => now - alpaca.delayMs,
        fetch: async (symbol, tf, clock, first, last) => {
          // The upstream serves nothing newer than its delay (the free plan refuses to); 30 s of
          // margin for clock skew between this server and the upstream.
          const end = Math.min(clock.end(last) - 1, this.now() - alpaca.delayMs - (alpaca.delayMs > 0 ? 30_000 : 0));
          if (end < first) return [];
          const source = await alpaca.bars(symbol, US_SOURCE[tf], first, end);
          return toSessionBars(source, clock).filter((b) => b.t >= first && b.t <= last);
        },
      });
    }
    const yahoo = this.yahoo;
    if (yahoo) {
      this.sources.set('futures', {
        market: 'futures',
        historyStart: FUTURES_HISTORY_START,
        settle: () => FUTURES_SETTLE_MS,
        dataTime: (now) => now - yahoo.delayMs,
        fetch: (symbol, tf, clock, first, last) => this.futuresBars(yahoo, symbol, tf, clock, first, last),
      });
    }
  }

  markets(): MarketStatus[] {
    return [
      { id: 'binance', label: 'Crypto', available: this.sources.has('binance') },
      { id: 'us', label: 'US stocks', available: this.sources.has('us') },
      { id: 'futures', label: 'Futures', available: this.sources.has('futures') },
    ];
  }

  /** Loads symbol lists and the calendar ahead of the first request (errors are only logged). */
  warmUp(): void {
    for (const market of LISTED) if (this.sources.has(market)) void this.symbolList(market).catch((err: unknown) => this.log(`[market] ${market} symbols: ${message(err)}`));
    if (this.alpaca) void this.calendar().catch((err: unknown) => this.log(`[market] calendar: ${message(err)}`));
  }

  // ---- symbols ------------------------------------------------------------------------------

  /** Symbols matching `query` across the available markets, best first. */
  async search(query: string, limit = 30): Promise<SymbolMatch[]> {
    const q = query.toUpperCase().replace(/[\s/-]+/g, '');
    const words = query.trim().toUpperCase();
    if (!q) return [];
    const found: Array<{ m: SymbolMatch; rank: number; tie: number }> = [];
    const lists = await Promise.allSettled([this.listOf<CryptoSymbol>('binance'), this.listOf<StockSymbol>('us')]);
    const crypto = lists[0].status === 'fulfilled' ? lists[0].value : null;
    const stocks = lists[1].status === 'fulfilled' ? lists[1].value : null;
    // Ranks: 0 the symbol itself (or a coin's pairs: "btc" means Bitcoin), 1 symbols starting with
    // the query, 2 names starting with it, 3 names with a word starting with it, 4 names containing it.
    // Futures first among equals: "ES" is the E-mini before the utility stock.
    if (this.sources.has('futures')) {
      for (const f of FUTURES) {
        let rank = f.symbol === q ? 0 : f.symbol.startsWith(q) ? 1 : -1;
        if (rank < 0 && words.length >= 2) rank = nameRank(f.name, words);
        if (rank >= 0) found.push({ m: { market: 'futures', symbol: f.symbol, name: f.name, detail: 'Futures' }, rank, tie: -1 });
      }
    }
    for (const s of crypto?.items.values() ?? []) {
      const rank = s.symbol === q || s.base === q ? 0 : s.symbol.startsWith(q) ? 1 : -1;
      if (rank >= 0) found.push({ m: { market: 'binance', symbol: s.symbol, name: `${s.base}/${s.quote}`, detail: 'Crypto' }, rank, tie: quoteRank(s.quote) });
    }
    for (const s of stocks?.items.values() ?? []) {
      let rank = s.symbol === q ? 0 : s.symbol.startsWith(q) ? 1 : -1;
      if (rank < 0 && words.length >= 2) rank = nameRank(s.name, words);
      if (rank >= 0) found.push({ m: { market: 'us', symbol: s.symbol, name: s.name, detail: s.exchange }, rank, tie: 10 + s.symbol.length });
    }
    found.sort((a, b) => a.rank - b.rank || a.tie - b.tie || a.m.symbol.length - b.m.symbol.length || a.m.symbol.localeCompare(b.m.symbol));
    return found.slice(0, limit).map((f) => f.m);
  }

  /** Details of one symbol, or null when the market does not list it. */
  async symbol(market: string, symbol: string): Promise<WireSymbol | null> {
    const source = this.source(market);
    if (source.market === 'futures') {
      const f = FUTURES_BY_SYMBOL.get(symbol);
      if (!f) return null;
      return {
        market: 'futures',
        symbol,
        name: f.name,
        base: symbol,
        quote: 'USD',
        exchange: f.exchange,
        pricePrecision: f.pricePrecision,
        minMove: f.minMove,
        timeZone: NEW_YORK,
        delayMs: this.yahoo?.delayMs ?? 0,
        sessions: true,
      };
    }
    if (source.market === 'binance') {
      const s = (await this.listOf<CryptoSymbol>('binance'))?.items.get(symbol);
      if (!s) return null;
      return {
        market: 'binance',
        symbol,
        name: `${s.base}/${s.quote}`,
        base: s.base,
        quote: s.quote,
        exchange: 'Binance',
        pricePrecision: tickDecimals(s.tickSize),
        minMove: Number(s.tickSize) || 0.01,
        timeZone: 'UTC',
        delayMs: 0,
        sessions: false,
      };
    }
    const s = (await this.listOf<StockSymbol>('us'))?.items.get(symbol);
    if (!s) return null;
    return {
      market: 'us',
      symbol,
      name: s.name,
      base: symbol,
      quote: 'USD',
      exchange: s.exchange,
      pricePrecision: 2,
      minMove: 0.01,
      timeZone: NEW_YORK,
      delayMs: this.alpaca?.delayMs ?? 0,
      sessions: true,
    };
  }

  /** A market's symbols (null when its upstream is not configured). */
  private async listOf<T>(market: ListedMarket): Promise<SymbolList<T> | null> {
    if (!this.sources.has(market)) return null;
    return (await this.symbolList(market)) as SymbolList<T>;
  }

  /** Memory, else the copy stored in the cache, else the upstream; refreshed daily in the background. */
  private async symbolList(market: ListedMarket): Promise<SymbolList<unknown>> {
    let list = this.lists.get(market);
    if (!list) {
      const stored = this.cache.getMeta(`symbols:${market}`);
      if (stored) {
        try {
          const parsed = JSON.parse(stored) as { at: number; items: Array<{ symbol: string }> };
          list = { at: parsed.at, items: new Map(parsed.items.map((x) => [x.symbol, x])) };
          this.lists.set(market, list);
        } catch {
          // corrupt copy: load it again
        }
      }
    }
    if (!list) return this.loadList(market);
    if (this.now() - list.at > SYMBOLS_MAX_AGE && this.mayRetry(`symbols:${market}`)) {
      void this.loadList(market).catch((err: unknown) => this.log(`[market] ${market} symbols: ${message(err)}`));
    }
    return list;
  }

  private loadList(market: ListedMarket): Promise<SymbolList<unknown>> {
    let pending = this.listLoads.get(market);
    if (!pending) {
      const key = `symbols:${market}`;
      if (!this.mayRetry(key)) return Promise.reject(new MarketError(503, `the ${market} symbol list is unavailable; retrying shortly`));
      pending = (async () => {
        const items: Array<{ symbol: string }> = await this.failureNoted<Array<{ symbol: string }>>(key, () => (market === 'binance' ? this.binance!.symbols() : this.alpaca!.assets()));
        const list: SymbolList<unknown> = { at: this.now(), items: new Map(items.map((x) => [x.symbol, x])) };
        this.lists.set(market, list);
        this.cache.setMeta(`symbols:${market}`, JSON.stringify({ at: list.at, items }));
        return list;
      })();
      this.listLoads.set(market, pending);
      void pending.then(
        () => this.listLoads.delete(market),
        () => this.listLoads.delete(market),
      );
    }
    return pending;
  }

  // ---- calendar -----------------------------------------------------------------------------

  /** A market's sessions for the app: [day, open, close]. */
  async sessions(market: string): Promise<WireSession[]> {
    const source = this.source(market);
    if (source.market === 'binance') throw new MarketError(404, `${market} trades around the clock`);
    const calendar = source.market === 'us' ? await this.calendar() : this.futuresCalendar();
    return calendar.sessions.filter((s) => s.day >= WIRE_SESSIONS_FROM).map((s) => [s.day, s.open, s.close] as const);
  }

  /** CME Globex sessions from 2000 to the end of the year after next (computed: no upstream). */
  private futuresCalendar(): SessionCalendar {
    const year = new Date(this.now()).getUTCFullYear();
    if (this.futures?.year !== year) this.futures = { year, calendar: new SessionCalendar(globexSessions('2000-01-03', `${year + 2}-12-31`)) };
    return this.futures.calendar;
  }

  /** The US trading calendar: memory, else stored copy, else the upstream; refreshed weekly. */
  private async calendar(): Promise<SessionCalendar> {
    if (!this.calendarState) {
      const stored = this.cache.getMeta('calendar:us');
      if (stored) {
        try {
          const parsed = JSON.parse(stored) as { at: number; rows: CalendarRow[] };
          this.calendarState = { at: parsed.at, rows: parsed.rows, calendar: new SessionCalendar(sessionsFromCalendar(parsed.rows, NEW_YORK)) };
        } catch {
          // corrupt copy: load it again
        }
      }
    }
    const state = this.calendarState;
    if (!state) return this.loadCalendar();
    if (this.now() - state.at > CALENDAR_MAX_AGE && this.mayRetry('calendar')) {
      void this.loadCalendar().catch((err: unknown) => this.log(`[market] calendar: ${message(err)}`));
    }
    return state.calendar;
  }

  private loadCalendar(): Promise<SessionCalendar> {
    if (!this.calendarLoad && !this.mayRetry('calendar')) return Promise.reject(new MarketError(503, 'the trading calendar is unavailable; retrying shortly'));
    this.calendarLoad ??= (async () => {
      try {
        const year = new Date(this.now()).getUTCFullYear();
        const rows = await this.failureNoted('calendar', () => this.alpaca!.calendar('2015-12-01', `${year + 4}-12-31`));
        const calendar = new SessionCalendar(sessionsFromCalendar(rows, NEW_YORK));
        this.calendarState = { at: this.now(), rows, calendar };
        this.cache.setMeta('calendar:us', JSON.stringify({ at: this.calendarState.at, rows }));
        return calendar;
      } finally {
        this.calendarLoad = null;
      }
    })();
    return this.calendarLoad;
  }

  // ---- bars ---------------------------------------------------------------------------------

  async bars(req: BarsRequest): Promise<OutBar[]> {
    const source = this.source(req.market);
    if (!(req.limit >= 1 && req.limit <= MAX_LIMIT)) throw new MarketError(400, `limit must be 1-${MAX_LIMIT}`);
    // Unknown symbols never reach the upstream (or the cache). If the list itself cannot be
    // loaded, requests still go through: bars must not depend on the symbol list's upstream.
    const known = await this.symbol(req.market, req.symbol).catch(() => undefined);
    if (known === null) throw new MarketError(404, `unknown symbol ${req.symbol}`);
    const clock = await this.clockOf(source.market, req.tf);
    // A slow or failing split check must not hold the chart: it goes on in the background.
    if (source.market === 'us') await waitAtMost(this.checkSplits(req.symbol), this.splitCheckWaitMs);
    const series = this.cache.series(source.market, req.symbol, req.tf);
    return this.withLock(series, () => this.collect(source, series, req, clock));
  }

  private async collect(source: Source, series: number, req: BarsRequest, clock: BarClock): Promise<OutBar[]> {
    const dataTime = source.dataTime(this.now());
    const newest = clock.latest(dataTime);
    if (newest === null) return [];
    const lastClosed = lastClosedBar(clock, dataTime - source.settle(req.tf));
    const firstBar = atOrAfter(clock, source.historyStart);
    const out: OutBar[] = [];
    if (req.start !== undefined) {
      let from = atOrAfter(clock, Math.max(req.start, firstBar));
      const last = Math.min(req.end !== undefined ? atOrBefore(clock, req.end) : newest, newest);
      for (let round = 0; round < MAX_ROUNDS && out.length < req.limit && from <= last; round++) {
        const to = Math.min(last, stepForward(clock, from, req.limit - out.length - 1));
        out.push(...(await this.slice(source, series, req.symbol, req.tf, clock, from, to, lastClosed)));
        from = clock.next(to);
      }
      return out.slice(0, req.limit);
    }
    let to = Math.min(req.end !== undefined ? atOrBefore(clock, req.end) : newest, newest);
    const parts: OutBar[][] = [];
    let count = 0;
    for (let round = 0; round < MAX_ROUNDS && count < req.limit && to >= firstBar; round++) {
      const from = Math.max(firstBar, stepBack(clock, to, req.limit - count - 1));
      const part = await this.slice(source, series, req.symbol, req.tf, clock, from, to, lastClosed);
      parts.unshift(part);
      count += part.length;
      if (from <= firstBar || (part.length === 0 && count > 0)) break; // the start of the data
      to = clock.prev(from);
    }
    return parts.flat().slice(-req.limit);
  }

  /** Bars opening in [from, to] (bar opens): closed ones via the cache, forming ones fresh. */
  private async slice(source: Source, series: number, symbol: string, tf: TimeframeId, clock: BarClock, from: number, to: number, lastClosed: number | null): Promise<OutBar[]> {
    const closedTo = lastClosed === null ? from - 1 : Math.min(to, lastClosed);
    let fresh: Bar[] | null = null;
    if (closedTo >= from) {
      for (const [a, b] of this.cache.missing(series, from, closedTo)) {
        const first = atOrAfter(clock, a);
        const last = atOrBefore(clock, b);
        // The range reaching the newest closed bar also brings the forming bars in the same request.
        const withForming = b === closedTo && to > closedTo;
        const fetchLast = withForming ? to : last;
        const bars = first <= fetchLast ? await source.fetch(symbol, tf, clock, first, fetchLast) : [];
        this.cache.store(series, bars, a, b);
        if (withForming) {
          fresh = bars.filter((x) => x.t > closedTo && x.t <= to);
          this.forming.set(series, { at: this.now(), first: clock.next(closedTo), last: to, bars: fresh });
        }
      }
    }
    const out: OutBar[] = closedTo >= from ? this.cache.range(series, from, closedTo).map((b) => ({ ...b, closed: true })) : [];
    if (to > closedTo) {
      const first = closedTo >= from ? clock.next(closedTo) : from;
      const bars = fresh ?? (await this.formingBars(source, series, symbol, tf, clock, first, to));
      for (const b of bars) if (b.t >= first && b.t <= to) out.push({ ...b, closed: false });
    }
    return out;
  }

  /** Which bar open times exist for a market and timeframe. */
  private async clockOf(market: MarketId, tf: TimeframeId): Promise<BarClock> {
    const ms = TIMEFRAME_MS[tf];
    if (market === 'us') return (await this.calendar()).clock(ms, tf === '1d');
    if (market === 'futures') return this.futuresCalendar().clock(ms, tf === '1d');
    return fixedClock(ms);
  }

  /**
   * Futures bars opening in [first, last] from Yahoo, built per FUTURES_SOURCE. A trade date's
   * daily bar takes the hourly bars from its session's evening open on; dates older than Yahoo's
   * hourly history come from its daily bars.
   */
  private async futuresBars(yahoo: FuturesUpstream, symbol: string, tf: TimeframeId, clock: BarClock, from: number, last: number): Promise<Bar[]> {
    const contract = FUTURES_BY_SYMBOL.get(symbol);
    if (!contract) return [];
    const ticker = contract.yahoo;
    // Nothing before the contract's data (Yahoo answers with an error); no 4-hour bar from before
    // Yahoo's hourly history (some of its hours would be missing).
    let first = Math.max(from, atOrAfter(clock, Date.parse(`${contract.dataFrom}T00:00:00Z`)));
    const hourly = yahoo.historyStart('60m');
    if (tf === '4h' && hourly !== null) first = Math.max(first, atOrAfter(clock, hourly));
    if (first > last) return [];
    const end = clock.end(last) - 1;
    const source: Bar[] = [];
    if (tf !== '1d') {
      source.push(...(await yahoo.bars(ticker, FUTURES_SOURCE[tf], first, end)));
    } else {
      // The first trade date whose whole session is within the hourly history.
      const inSession = hourly === null ? null : clock.bucket(hourly);
      const split = hourly === null ? first : clock.next(inSession ?? hourly);
      if (first < split) source.push(...(await yahoo.bars(ticker, '1d', first, Math.min(last, split - 1))));
      const fromHourly = Math.max(first, split);
      if (fromHourly <= last) source.push(...(await yahoo.bars(ticker, '60m', this.futuresCalendar().sessionAt(fromHourly)?.open ?? fromHourly, end)));
    }
    return toSessionBars(source, clock).filter((b) => b.t >= first && b.t <= last);
  }

  /**
   * Yahoo serves intraday history for a while only (1-minute bars 30 days, 5 and 15 minutes 60
   * days, hourly two years): fetch what the cache is missing of it, every timeframe of each futures
   * symbol charted so far, so the cache keeps what Yahoo drops. Runs a few times a day.
   */
  async archiveFutures(signal?: AbortSignal): Promise<void> {
    const source = this.sources.get('futures');
    const yahoo = this.yahoo;
    if (!source || !yahoo) return;
    for (const symbol of this.cache.symbols('futures')) {
      if (!FUTURES_BY_SYMBOL.has(symbol)) continue;
      for (const tf of Object.keys(TIMEFRAME_MS) as TimeframeId[]) {
        if (signal?.aborted) return;
        const from = yahoo.historyStart(FUTURES_SOURCE[tf]);
        if (from === null) continue;
        try {
          const clock = await this.clockOf('futures', tf);
          const series = this.cache.series('futures', symbol, tf);
          await this.archive(source, series, symbol, tf, clock, from, signal);
        } catch (err) {
          this.log(`[market] futures archive ${symbol} ${tf}: ${message(err)}`);
        }
      }
    }
  }

  /**
   * Closed bars from `from` on that the cache is missing, MAX_LIMIT bar slots per step; then the
   * last day's bars again, stored over the cached ones: Yahoo may have been late with them (a bar
   * is final 20 minutes after it ends, by the clock alone) or revised them since. Each step holds
   * the series lock on its own, so charts and polls get in between.
   */
  private async archive(source: Source, series: number, symbol: string, tf: TimeframeId, clock: BarClock, from: number, signal?: AbortSignal): Promise<void> {
    const lastClosed = lastClosedBar(clock, source.dataTime(this.now()) - source.settle(tf));
    if (lastClosed === null) return;
    for (let first = atOrAfter(clock, from); first <= lastClosed && !signal?.aborted; ) {
      const last = Math.min(lastClosed, stepForward(clock, first, MAX_LIMIT - 1));
      await this.withLock(series, () => this.slice(source, series, symbol, tf, clock, first, last, lastClosed));
      const next = clock.next(last);
      // No bar opens between two steps: complete as well, so the coverage stays one range.
      if (last < lastClosed && next - 1 > last) this.cache.store(series, [], last + 1, next - 1);
      first = next;
    }
    const recheck = Math.max(atOrAfter(clock, from), atOrAfter(clock, lastClosed - DAY));
    if (signal?.aborted || recheck > lastClosed) return;
    await this.withLock(series, async () => this.cache.store(series, await source.fetch(symbol, tf, clock, recheck, lastClosed), recheck, lastClosed));
  }

  private async formingBars(source: Source, series: number, symbol: string, tf: TimeframeId, clock: BarClock, first: number, last: number): Promise<Bar[]> {
    const hit = this.forming.get(series);
    if (hit && this.now() - hit.at < FORMING_TTL_MS && hit.first <= first && hit.last >= last) return hit.bars;
    const bars = await source.fetch(symbol, tf, clock, first, last);
    this.forming.set(series, { at: this.now(), first, last, bars });
    return bars;
  }

  /**
   * Split-adjusted history changes when a stock splits: once a day per symbol, look for splits
   * since the last check (with 2 days of margin, in case the upstream adjusted its history late)
   * and drop the symbol's cached bars if there was one.
   */
  private checkSplits(symbol: string): Promise<void> {
    const today = zonedDate(this.now(), NEW_YORK);
    const key = `splits:${symbol}`;
    const last = this.cache.getMeta(key);
    if (last === today || !this.mayRetry(key)) return Promise.resolve();
    let pending = this.splitChecks.get(symbol);
    if (!pending) {
      const check = (async () => {
        try {
          if (last !== null) {
            const exDates = await this.alpaca!.splits(symbol, shiftDate(last, -2), today);
            if (exDates.length > 0) {
              this.cache.purgeSymbol('us', symbol);
              this.forming.clear();
              this.log(`[market] ${symbol} split (ex-date ${exDates.join(', ')}): cached bars dropped`);
            }
          }
          this.cache.setMeta(key, today);
        } catch (err) {
          this.retryAt.set(key, this.now() + RETRY_AFTER_FAILURE_MS);
          this.log(`[market] split check for ${symbol} failed (${message(err)}); retrying in a few minutes`);
        }
      })();
      // Registered before it can settle: a check with nothing to await finishes synchronously.
      pending = check;
      this.splitChecks.set(symbol, check);
      void check.then(() => {
        if (this.splitChecks.get(symbol) === check) this.splitChecks.delete(symbol);
      });
    }
    return pending;
  }

  /** Whether a load that failed (by key) may be tried again already. */
  private mayRetry(key: string): boolean {
    const at = this.retryAt.get(key);
    if (at === undefined) return true;
    if (this.now() < at) return false;
    this.retryAt.delete(key);
    return true;
  }

  /** Runs an upstream load; a failure blocks further attempts for a while. */
  private async failureNoted<T>(key: string, load: () => Promise<T>): Promise<T> {
    try {
      return await load();
    } catch (err) {
      this.retryAt.set(key, this.now() + RETRY_AFTER_FAILURE_MS);
      throw err;
    }
  }

  private source(market: string): Source {
    const source = this.sources.get(market as MarketId);
    if (source) return source;
    if (market === 'us') throw new MarketError(503, 'US market data is not set up on the server (APCA_API_KEY_ID / APCA_API_SECRET_KEY)');
    if (market === 'binance') throw new MarketError(503, 'crypto market data is turned off on the server');
    if (market === 'futures') throw new MarketError(503, 'futures market data is turned off on the server (FUTURES_DATA=off)');
    throw new MarketError(404, `unknown market ${market}`);
  }

  /** Requests for one series run one at a time: overlapping fetches would duplicate upstream calls. */
  private withLock<T>(series: number, fn: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(series) ?? Promise.resolve()).then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(series, tail);
    void tail.then(() => {
      if (this.locks.get(series) === tail) this.locks.delete(series);
    });
    return run;
  }
}

/** Resolves when `task` settles or after `ms`, whichever comes first (the task goes on). */
function waitAtMost(task: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void task.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** The newest bar whose end is at or before `asOf` (null: none yet). */
function lastClosedBar(clock: BarClock, asOf: number): number | null {
  const latest = clock.latest(asOf);
  if (latest === null) return null;
  return clock.end(latest) <= asOf ? latest : clock.prev(latest);
}

/** The bar opening at `t`, else the first bar opening after it. */
function atOrAfter(clock: BarClock, t: number): number {
  return clock.bucket(t) === t ? t : clock.next(t);
}

/** The bar opening at `t`, else the last bar opening before it. */
function atOrBefore(clock: BarClock, t: number): number {
  return clock.bucket(t) === t ? t : clock.prev(t);
}

/** Rank of a name match (2 starts with the query, 3 a word does, 4 contains it), -1 none. */
function nameRank(name: string, words: string): number {
  const upper = name.toUpperCase();
  const at = upper.indexOf(words);
  return at === 0 ? 2 : at > 0 && !/[A-Z0-9]/.test(upper[at - 1]) ? 3 : at > 0 ? 4 : -1;
}

/** Preferred quote assets first (the pairs most people chart). */
function quoteRank(quote: string): number {
  const i = ['USDT', 'USDC', 'FDUSD', 'BTC', 'ETH', 'EUR'].indexOf(quote);
  return i < 0 ? 9 : i;
}

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
