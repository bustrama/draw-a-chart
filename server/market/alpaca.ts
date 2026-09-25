import type { Bar } from './cache.ts';
import { HttpClient, UpstreamError } from './upstream.ts';

/**
 * Alpaca data feeds: 'delayed_sip' = every US exchange, 15 minutes late (the free plan);
 * 'sip' = every exchange in real time (paid); 'iex' = one exchange in real time (free, a few
 * percent of the volume).
 */
export type AlpacaFeed = 'delayed_sip' | 'sip' | 'iex';

export type AlpacaTimeframe = '1Min' | '5Min' | '15Min' | '30Min' | '1Day';

export interface AlpacaConfig {
  readonly keyId: string;
  readonly secretKey: string;
  readonly feed?: AlpacaFeed;
  readonly dataUrl?: string;
  /** Trading API host (calendar, assets). Default: the paper host for paper keys (PK…). */
  readonly tradingUrl?: string;
}

export interface CalendarRow {
  readonly date: string;
  readonly open: string;
  readonly close: string;
}

export interface StockSymbol {
  readonly symbol: string;
  readonly name: string;
  readonly exchange: string;
}

/** Alpaca's history starts in 2016. */
export const ALPACA_HISTORY_START = Date.UTC(2016, 0, 1);
const DELAYED_MS = 15 * 60_000;

/**
 * Alpaca's market-data and trading APIs (read only): US stock bars (split-adjusted), the trading
 * calendar, the asset list and stock splits. The free plan allows 200 requests a minute and no
 * data from the last 15 minutes of the consolidated feed; callers keep `end` older than that.
 */
export class AlpacaUpstream {
  readonly feed: AlpacaFeed;
  /** How far behind real time this feed's data is. */
  readonly delayMs: number;
  private readonly http: HttpClient;
  private readonly headers: Readonly<Record<string, string>>;
  private readonly dataUrl: string;
  private readonly tradingUrl: string;

  constructor(config: AlpacaConfig, http?: HttpClient) {
    this.feed = config.feed ?? 'delayed_sip';
    this.delayMs = this.feed === 'delayed_sip' ? DELAYED_MS : 0;
    this.http = http ?? new HttpClient({ name: 'Alpaca', perSecond: 3, burst: 12 });
    this.headers = { 'APCA-API-KEY-ID': config.keyId, 'APCA-API-SECRET-KEY': config.secretKey };
    this.dataUrl = (config.dataUrl ?? 'https://data.alpaca.markets').replace(/\/+$/, '');
    this.tradingUrl = (config.tradingUrl ?? (config.keyId.startsWith('PK') ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets')).replace(/\/+$/, '');
  }

  /** Bars opening in [start, end] (every page), oldest first; split-adjusted, extended hours included. */
  async bars(symbol: string, timeframe: AlpacaTimeframe, start: number, end: number): Promise<Bar[]> {
    const out: Bar[] = [];
    let token: string | null = null;
    do {
      const params = new URLSearchParams({
        timeframe,
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        // The delayed plan reads the consolidated feed, keeping `end` 15 minutes old.
        feed: this.feed === 'iex' ? 'iex' : 'sip',
        adjustment: 'split',
        limit: '10000',
        sort: 'asc',
      });
      if (token) params.set('page_token', token);
      const body = (await this.http.getJson(`${this.dataUrl}/v2/stocks/${encodeURIComponent(symbol)}/bars?${params.toString()}`, this.headers)) as {
        bars?: unknown;
        next_page_token?: unknown;
      };
      if (body.bars !== null && body.bars !== undefined && !Array.isArray(body.bars)) throw new UpstreamError('Alpaca', 200, 'unexpected bars answer');
      for (const raw of (body.bars as Array<Record<string, unknown>> | null) ?? []) {
        const t = typeof raw.t === 'string' ? Date.parse(raw.t) : NaN;
        const bar = { t, o: Number(raw.o), h: Number(raw.h), l: Number(raw.l), c: Number(raw.c), v: Number(raw.v) };
        if ([bar.t, bar.o, bar.h, bar.l, bar.c, bar.v].every(Number.isFinite)) out.push(bar);
      }
      token = typeof body.next_page_token === 'string' && body.next_page_token ? body.next_page_token : null;
    } while (token);
    return out;
  }

  /** Trading days between two dates (`YYYY-MM-DD`), with regular open and close times (New York). */
  async calendar(start: string, end: string): Promise<CalendarRow[]> {
    const params = new URLSearchParams({ start, end });
    const rows = await this.http.getJson(`${this.tradingUrl}/v2/calendar?${params.toString()}`, this.headers);
    if (!Array.isArray(rows)) throw new UpstreamError('Alpaca', 200, 'unexpected calendar answer');
    return (rows as Array<Record<string, unknown>>)
      .filter((r) => typeof r.date === 'string' && typeof r.open === 'string' && typeof r.close === 'string')
      .map((r) => ({ date: r.date as string, open: r.open as string, close: r.close as string }));
  }

  /** Active, tradable US stocks and ETFs on the national exchanges (no OTC). */
  async assets(): Promise<StockSymbol[]> {
    const rows = await this.http.getJson(`${this.tradingUrl}/v2/assets?status=active&asset_class=us_equity`, this.headers);
    if (!Array.isArray(rows)) throw new UpstreamError('Alpaca', 200, 'unexpected assets answer');
    const out: StockSymbol[] = [];
    for (const a of rows as Array<Record<string, unknown>>) {
      if (a.tradable !== true || a.exchange === 'OTC' || typeof a.symbol !== 'string') continue;
      out.push({ symbol: a.symbol, name: typeof a.name === 'string' ? a.name : a.symbol, exchange: typeof a.exchange === 'string' ? a.exchange : '' });
    }
    return out;
  }

  /** Ex-dates of the symbol's splits (forward and reverse) between two dates. */
  async splits(symbol: string, start: string, end: string): Promise<string[]> {
    const params = new URLSearchParams({ symbols: symbol, types: 'forward_split,reverse_split', start, end });
    const body = (await this.http.getJson(`${this.dataUrl}/v1/corporate-actions?${params.toString()}`, this.headers)) as { corporate_actions?: Record<string, unknown> };
    const actions = body.corporate_actions ?? {};
    const out: string[] = [];
    for (const kind of ['forward_splits', 'reverse_splits']) {
      const list = actions[kind];
      if (!Array.isArray(list)) continue;
      for (const s of list as Array<Record<string, unknown>>) if (s.symbol === symbol && typeof s.ex_date === 'string') out.push(s.ex_date);
    }
    return out;
  }
}
