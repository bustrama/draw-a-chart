/**
 * Wire protocol of the market-data API (`/api/market/*`) between the app and the self-hosted
 * server. Types only, and no imports: the server imports this file with `import type`, which
 * Node's type stripping erases.
 *
 * Markets: 'binance' (crypto spot pairs, around the clock), 'us' (US stocks and ETFs, regular
 * hours, consolidated volume) and 'futures' (continuous front-month contracts, CME Globex hours).
 * The server caches closed bars and fetches only what is missing from the upstream provider; the
 * forming bar is always fetched fresh.
 */

/** [open time (Unix ms), open, high, low, close, volume, closed (1) or still forming (0)] */
export type WireBar = readonly [number, number, number, number, number, number, 0 | 1];

/**
 * `GET /api/market/bars?market&symbol&tf&limit[&start][&end]`, like Binance's klines:
 * - no start/end: the latest `limit` bars (the last one may still be forming);
 * - end only: the `limit` bars that open at or before `end`;
 * - start (and end): up to `limit` bars that open at or after `start` (and at or before `end`).
 * Bars are sorted by time. A range the upstream has no bars for (e.g. before a listing) is empty.
 */
export interface BarsResponse {
  readonly bars: readonly WireBar[];
}

export interface WireSymbol {
  readonly market: string;
  readonly symbol: string;
  readonly name: string;
  readonly base: string;
  readonly quote: string;
  /** Listing exchange (stocks) or '' */
  readonly exchange: string;
  readonly pricePrecision: number;
  readonly minMove: number;
  /** IANA time zone of the exchange (the chart's time axis). */
  readonly timeZone: string;
  /** How far the data lags real time (ms); 0 = real time. */
  readonly delayMs: number;
  /** True when the market trades in sessions (get them from /api/market/calendar), false = 24/7. */
  readonly sessions: boolean;
}

/** `GET /api/market/symbol?market&symbol`; 404 when the symbol is unknown. */
export interface SymbolResponse {
  readonly symbol: WireSymbol;
}

export interface SymbolMatch {
  readonly market: string;
  readonly symbol: string;
  readonly name: string;
  /** Exchange (stocks) or quote asset (crypto). */
  readonly detail: string;
}

/** `GET /api/market/search?q&limit`: best matches first, across all available markets. */
export interface SearchResponse {
  readonly results: readonly SymbolMatch[];
}

/**
 * One regular session: [day (midnight of the trade date, exchange time), open, close], Unix ms.
 * Futures sessions open the evening before their trade date (open < day).
 */
export type WireSession = readonly [number, number, number];

/** `GET /api/market/calendar?market`: the market's regular sessions, oldest first. */
export interface CalendarResponse {
  readonly sessions: readonly WireSession[];
}

export interface MarketStatus {
  readonly id: string;
  readonly label: string;
  /** False when the server is not set up for it (e.g. no Alpaca key for 'us'). */
  readonly available: boolean;
}

/** `GET /api/market/markets` */
export interface MarketsResponse {
  readonly markets: readonly MarketStatus[];
}
