/**
 * Provider-agnostic market-data types. Nothing in here may depend on a specific exchange,
 * on the chart library, or on the drawing engine.
 */

export interface Candle {
  /** Bar open time, Unix epoch milliseconds (UTC). */
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  /** Trade count when the provider reports it; used to order competing versions of an open bar. */
  readonly trades?: number;
  /** True when the bar is final (its interval ended and the provider marked it closed). */
  readonly closed: boolean;
}

export type TimeframeId = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

export interface Timeframe {
  readonly id: TimeframeId;
  readonly label: string;
  /** Fixed bar duration in milliseconds. All supported timeframes are UTC-aligned fixed intervals. */
  readonly ms: number;
}

export interface SymbolInfo {
  readonly symbol: string;
  readonly base: string;
  readonly quote: string;
  /** Number of decimals shown on the price scale. */
  readonly pricePrecision: number;
  /** Minimal price movement shown on the price scale. */
  readonly minMove: number;
}

export type LiveStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'offline' | 'error';

export interface CandleRequest {
  readonly symbol: string;
  readonly timeframe: TimeframeId;
  /** Inclusive lower bound on bar open time (ms). */
  readonly startTime?: number;
  /** Inclusive upper bound on bar open time (ms). */
  readonly endTime?: number;
  readonly limit: number;
  readonly signal?: AbortSignal;
}

export interface LiveCandleListener {
  onCandle(candle: Candle): void;
  /**
   * Called when the live connection re-opened after an interruption. Updates may have been
   * missed while it was down, so the consumer must backfill from REST.
   */
  onResync?(): void;
  onStatus?(status: LiveStatus): void;
}

export interface MarketDataProvider {
  readonly id: string;
  readonly name: string;
  /** Maximum number of candles a single history request may return. */
  readonly maxCandlesPerRequest: number;
  symbols(): readonly SymbolInfo[];
  fetchCandles(req: CandleRequest): Promise<Candle[]>;
  /** Subscribes to live updates of the current (and newly opened) bars. Returns an unsubscribe function. */
  subscribeCandles(symbol: string, timeframe: TimeframeId, listener: LiveCandleListener): () => void;
  /** Releases sockets/timers. The provider must not be used afterwards. */
  dispose?(): void;
}
