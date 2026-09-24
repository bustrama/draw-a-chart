import { getTimeframe, barOpenTime } from '../timeframes';
import type { Candle, CandleRequest, LiveCandleListener, MarketDataProvider, SymbolInfo, TimeframeId } from '../types';

export interface MockProviderOptions {
  /** Clock for "now"; fix it for fully reproducible data. */
  readonly now?: () => number;
  /** Emit live updates at this period (ms); null disables live updates. */
  readonly liveIntervalMs?: number | null;
  /** How many bars of history exist before "now" (lets tests reach the end of history). */
  readonly historyBars?: number;
  readonly seed?: number;
}

const SYMBOLS: readonly SymbolInfo[] = [
  { symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT', pricePrecision: 2, minMove: 0.01 },
  { symbol: 'ETHUSDT', base: 'ETH', quote: 'USDT', pricePrecision: 2, minMove: 0.01 },
];

const BASE_PRICE: Record<string, number> = { BTCUSDT: 64_000, ETHUSDT: 3_200 };

/**
 * Deterministic synthetic market data. Prices are a pure function of (symbol, time), so any
 * page of history can be generated independently and repeated requests return identical bars.
 */
export class MockProvider implements MarketDataProvider {
  readonly id = 'mock';
  readonly name = 'Mock data';
  readonly maxCandlesPerRequest = 1000;
  private readonly now: () => number;
  private readonly liveIntervalMs: number | null;
  private readonly historyBars: number;
  private readonly seed: number;

  constructor(options: MockProviderOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.liveIntervalMs = options.liveIntervalMs === undefined ? 1000 : options.liveIntervalMs;
    this.historyBars = options.historyBars ?? 5000;
    this.seed = options.seed ?? 7;
  }

  symbols(): readonly SymbolInfo[] {
    return SYMBOLS;
  }

  async fetchCandles(req: CandleRequest): Promise<Candle[]> {
    const tf = getTimeframe(req.timeframe);
    const now = this.now();
    const lastOpen = barOpenTime(now, tf.ms);
    const firstOpen = lastOpen - (this.historyBars - 1) * tf.ms;
    const limit = Math.min(req.limit, this.maxCandlesPerRequest);
    let from: number;
    let to: number;
    if (req.startTime !== undefined) {
      from = Math.max(firstOpen, Math.ceil(req.startTime / tf.ms) * tf.ms);
      to = Math.min(lastOpen, req.endTime !== undefined ? barOpenTime(req.endTime, tf.ms) : lastOpen, from + (limit - 1) * tf.ms);
    } else {
      to = Math.min(lastOpen, req.endTime !== undefined ? barOpenTime(req.endTime, tf.ms) : lastOpen);
      from = Math.max(firstOpen, to - (limit - 1) * tf.ms);
    }
    const out: Candle[] = [];
    for (let t = from; t <= to; t += tf.ms) out.push(this.bar(req.symbol, t, tf.ms, now));
    return out;
  }

  subscribeCandles(symbol: string, timeframe: TimeframeId, listener: LiveCandleListener): () => void {
    listener.onStatus?.('live');
    if (this.liveIntervalMs === null) return () => undefined;
    const tf = getTimeframe(timeframe);
    let lastOpen = barOpenTime(this.now(), tf.ms);
    const id = setInterval(() => {
      const now = this.now();
      const open = barOpenTime(now, tf.ms);
      if (open > lastOpen) {
        listener.onCandle(this.bar(symbol, lastOpen, tf.ms, lastOpen + tf.ms));
        lastOpen = open;
      }
      listener.onCandle(this.bar(symbol, open, tf.ms, now));
    }, this.liveIntervalMs);
    return () => clearInterval(id);
  }

  /** Bar at open time `t`, as it looked at time `asOf` (the forming bar is partial). */
  private bar(symbol: string, t: number, intervalMs: number, asOf: number): Candle {
    const base = BASE_PRICE[symbol] ?? 100;
    const end = Math.min(t + intervalMs, Math.max(t, asOf));
    const open = this.price(base, t);
    const close = this.price(base, end);
    const wick = base * 0.0009 * (0.3 + this.noise(t * 3 + 1));
    const closed = asOf >= t + intervalMs;
    const progress = Math.min(1, Math.max(0, (asOf - t) / intervalMs));
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

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
