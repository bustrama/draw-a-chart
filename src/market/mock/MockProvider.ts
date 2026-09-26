import { globexSessions, SessionCalendar, sessionsFromCalendar, stepBack, stepForward, NEW_YORK } from '../../../shared/sessions.ts';
import { clockFor, getTimeframe } from '../timeframes';
import type { BarClock, Candle, CandleRequest, LiveCandleListener, MarketDataProvider, PreparedChart, SymbolInfo, TimeframeId } from '../types';

export interface MockProviderOptions {
  /** Drawing namespace (default 'mock'). */
  readonly id?: string;
  /** Clock for "now"; fix it for fully reproducible data. */
  readonly now?: () => number;
  /** Emit live updates at this period (ms); null disables live updates. */
  readonly liveIntervalMs?: number | null;
  /** How many bars of history exist before "now" (lets tests reach the end of history). */
  readonly historyBars?: number;
  readonly seed?: number;
  /** Trading sessions (a stock market): bars exist only inside them. Default: around the clock. */
  readonly calendar?: SessionCalendar;
  readonly symbols?: readonly SymbolInfo[];
}

const CRYPTO_SYMBOLS: readonly SymbolInfo[] = [
  { symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT', pricePrecision: 2, minMove: 0.01 },
  { symbol: 'ETHUSDT', base: 'ETH', quote: 'USDT', pricePrecision: 2, minMove: 0.01 },
];

export const MOCK_STOCK_SYMBOLS: readonly SymbolInfo[] = [
  { symbol: 'SPY', base: 'SPY', quote: 'USD', name: 'Mock S&P 500 ETF', pricePrecision: 2, minMove: 0.01, timeZone: NEW_YORK, delayMs: 15 * 60_000 },
  { symbol: 'AAPL', base: 'AAPL', quote: 'USD', name: 'Mock Apple', pricePrecision: 2, minMove: 0.01, timeZone: NEW_YORK, delayMs: 15 * 60_000 },
];

export const MOCK_FUTURES_SYMBOLS: readonly SymbolInfo[] = [
  { symbol: 'ES', base: 'ES', quote: 'USD', name: 'Mock E-mini S&P 500', pricePrecision: 2, minMove: 0.25, timeZone: NEW_YORK, delayMs: 10 * 60_000 },
];

const BASE_PRICE: Record<string, number> = { BTCUSDT: 64_000, ETHUSDT: 3_200, SPY: 560, AAPL: 230, ES: 5_600 };

/**
 * Deterministic synthetic market data. Prices are a pure function of (symbol, time), so any
 * page of history can be generated independently and repeated requests return identical bars.
 * With a session calendar it behaves like a stock market: no bars at night or on weekends.
 */
export class MockProvider implements MarketDataProvider {
  readonly id: string;
  readonly name = 'Mock data';
  readonly maxCandlesPerRequest = 1000;
  private readonly now: () => number;
  private readonly liveIntervalMs: number | null;
  private readonly historyBars: number;
  private readonly seed: number;
  private readonly calendar: SessionCalendar | null;
  private readonly known: readonly SymbolInfo[];

  constructor(options: MockProviderOptions = {}) {
    this.id = options.id ?? 'mock';
    this.now = options.now ?? (() => Date.now());
    this.liveIntervalMs = options.liveIntervalMs === undefined ? 1000 : options.liveIntervalMs;
    this.historyBars = options.historyBars ?? 5000;
    this.seed = options.seed ?? 7;
    this.calendar = options.calendar ?? null;
    this.known = options.symbols ?? CRYPTO_SYMBOLS;
  }

  symbols(): readonly SymbolInfo[] {
    return this.known;
  }

  async prepare(symbol: string, timeframe: TimeframeId): Promise<PreparedChart> {
    const info = this.known.find((s) => s.symbol === symbol) ?? { symbol, base: symbol, quote: '', pricePrecision: 2, minMove: 0.01 };
    return { info, clock: this.clockOf(timeframe) };
  }

  async fetchCandles(req: CandleRequest): Promise<Candle[]> {
    const clock = this.clockOf(req.timeframe);
    const now = this.now();
    const lastOpen = clock.latest(now);
    if (lastOpen === null) return [];
    const firstOpen = stepBack(clock, lastOpen, this.historyBars - 1);
    const limit = Math.min(req.limit, this.maxCandlesPerRequest);
    let from: number;
    let to: number;
    if (req.startTime !== undefined) {
      from = Math.max(firstOpen, firstOpenAtOrAfter(clock, req.startTime));
      const end = req.endTime !== undefined ? lastOpenAtOrBefore(clock, req.endTime) : lastOpen;
      to = Math.min(lastOpen, end, stepForward(clock, from, limit - 1));
    } else {
      to = Math.min(lastOpen, req.endTime !== undefined ? lastOpenAtOrBefore(clock, req.endTime) : lastOpen);
      from = Math.max(firstOpen, stepBack(clock, to, limit - 1));
    }
    const out: Candle[] = [];
    for (let t = from; t <= to; t = clock.next(t)) out.push(this.bar(req.symbol, t, clock.end(t), now));
    return out;
  }

  subscribeCandles(symbol: string, timeframe: TimeframeId, listener: LiveCandleListener): () => void {
    listener.onStatus?.('live');
    if (this.liveIntervalMs === null) return () => undefined;
    const clock = this.clockOf(timeframe);
    let lastOpen = clock.latest(this.now());
    const id = setInterval(() => {
      const now = this.now();
      const open = clock.latest(now);
      if (open === null) return;
      if (lastOpen !== null && open > lastOpen) listener.onCandle(this.bar(symbol, lastOpen, clock.end(lastOpen), clock.end(lastOpen)));
      lastOpen = open;
      listener.onCandle(this.bar(symbol, open, clock.end(open), now));
    }, this.liveIntervalMs);
    return () => clearInterval(id);
  }

  private clockOf(timeframe: TimeframeId): BarClock {
    return clockFor(getTimeframe(timeframe), this.calendar);
  }

  /** Bar opening at `t` and ending at `end`, as it looked at time `asOf` (the forming bar is partial). */
  private bar(symbol: string, t: number, end: number, asOf: number): Candle {
    const base = BASE_PRICE[symbol] ?? 100;
    const at = Math.min(end, Math.max(t, asOf));
    const open = this.price(base, t);
    const close = this.price(base, at);
    const wick = base * 0.0009 * (0.3 + this.noise(t * 3 + 1));
    const closed = asOf >= end;
    const progress = Math.min(1, Math.max(0, (asOf - t) / (end - t)));
    return {
      time: t,
      open: round2(open),
      high: round2(Math.max(open, close) + wick * this.noise(t + 7)),
      low: round2(Math.min(open, close) - wick * this.noise(t + 11)),
      close: round2(close),
      volume: round2((20 + 80 * this.noise(t + 5)) * (closed ? 1 : progress)),
      closed,
    };
  }

  private price(base: number, t: number): number {
    const h = t / 3_600_000;
    const s = this.seed;
    return base * (1 + 0.06 * Math.sin(h / 97 + s) + 0.025 * Math.sin(h / 17.3 + 2 * s) + 0.008 * Math.sin(h / 3.1 + 3 * s) + 0.004 * Math.sin(h * 1.7 + s) + 0.0015 * (this.noise(Math.floor(t / 60_000)) - 0.5));
  }

  private noise(n: number): number {
    const x = Math.sin(n * 12.9898 + this.seed * 78.233) * 43758.5453;
    return x - Math.floor(x);
  }
}

/**
 * Last bar open at or before `time`. (Not `latest`: a futures daily bar that has started on Sunday
 * evening opens on Monday, after the time.)
 */
function lastOpenAtOrBefore(clock: BarClock, time: number): number {
  return clock.bucket(time) === time ? time : clock.prev(time);
}

/** First bar open at or after `time`. */
function firstOpenAtOrAfter(clock: BarClock, time: number): number {
  return clock.bucket(time) === time ? time : clock.next(time);
}

/**
 * A US-like trading calendar for offline development and browser tests: every weekday from
 * `fromYear` to `toYear`, 9:30-16:00 New York time (no holidays).
 */
export function mockUsCalendar(fromYear = 2025, toYear = 2027): SessionCalendar {
  const rows: { date: string; open: string; close: string }[] = [];
  for (let t = Date.UTC(fromYear, 0, 1); t < Date.UTC(toYear + 1, 0, 1); t += 86_400_000) {
    const d = new Date(t);
    const weekday = d.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    rows.push({ date: d.toISOString().slice(0, 10), open: '09:30', close: '16:00' });
  }
  return new SessionCalendar(sessionsFromCalendar(rows, NEW_YORK));
}

/** CME Globex hours for the mock futures market: 18:00-17:00 New York, Sunday evening to Friday. */
export function mockFuturesCalendar(fromYear = 2015, toYear = 2027): SessionCalendar {
  return new SessionCalendar(globexSessions(`${fromYear}-01-01`, `${toYear}-12-31`));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
