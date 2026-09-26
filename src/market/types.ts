/**
 * Provider-agnostic market-data types. Nothing in here may depend on a specific exchange,
 * on the chart library, or on the drawing engine.
 */
import type { BarClock } from '../../shared/sessions.ts';

export type { BarClock };

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
  /** Nominal bar duration in milliseconds (the last bar of a session may be shorter). */
  readonly ms: number;
}

export interface SymbolInfo {
  readonly symbol: string;
  readonly base: string;
  readonly quote: string;
  /** Display name, e.g. "Apple Inc. Common Stock". */
  readonly name?: string;
  /** Number of decimals shown on the price scale. */
  readonly pricePrecision: number;
  /** Minimal price movement shown on the price scale. */
  readonly minMove: number;
  /** IANA time zone of the time axis (the exchange's); UTC when absent. */
  readonly timeZone?: string;
  /** How far the data lags real time (ms), e.g. 15 minutes for delayed US quotes. */
  readonly delayMs?: number;
}

/** What a chart needs before it can load bars: symbol details and which bar times exist. */
export interface PreparedChart {
  readonly info: SymbolInfo;
  readonly clock: BarClock;
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
  /** Namespace of the charts' drawings (e.g. 'binance', 'us', 'futures'). */
  readonly id: string;
  readonly name: string;
  /** Maximum number of candles a single history request may return. */
  readonly maxCandlesPerRequest: number;
  /**
   * History never has holes that a later request could fill (the server's cache guarantees it),
   * so feeds only check for missed bars where live updates join the history.
   */
  readonly completeHistory?: boolean;
  /** Symbols known without a network request (for pickers when no search is available). */
  symbols(): readonly SymbolInfo[];
  /** Symbol details and the bar clock (trading sessions) for a chart; may load them first. */
  prepare(symbol: string, timeframe: TimeframeId, signal?: AbortSignal): Promise<PreparedChart>;
  fetchCandles(req: CandleRequest): Promise<Candle[]>;
  /** Subscribes to live updates of the current (and newly opened) bars. Returns an unsubscribe function. */
  subscribeCandles(symbol: string, timeframe: TimeframeId, listener: LiveCandleListener): () => void;
  /** Releases sockets/timers. The provider must not be used afterwards. */
  dispose?(): void;
}
