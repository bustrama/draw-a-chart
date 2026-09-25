import { SessionCalendar } from '../../../shared/sessions.ts';
import type { BarsResponse, CalendarResponse, MarketsResponse, MarketStatus, SearchResponse, SymbolMatch, SymbolResponse, WireSymbol } from '../protocol';
import type { Candle, TimeframeId } from '../types';

/**
 * Why a request failed: no answer (network, timeout), a login proxy redirected it, something that
 * is not the market-data API answered ('absent': a server with market data off, a static host),
 * or the API answered with an error ('error', see `status`).
 */
export type MarketApiFailure = 'unreachable' | 'login' | 'absent' | 'error';

export class MarketApiError extends Error {
  readonly status: number;
  readonly kind: MarketApiFailure;
  constructor(message: string, status: number, kind: MarketApiFailure = 'error') {
    super(message);
    this.status = status;
    this.kind = kind;
  }
}

/** Set on every answer of the market-data API (server/market/api.ts). */
const MARKET_API_HEADER = 'x-market-api';

export interface BarsQuery {
  readonly market: string;
  readonly symbol: string;
  readonly timeframe: TimeframeId;
  readonly limit: number;
  readonly startTime?: number;
  readonly endTime?: number;
  readonly signal?: AbortSignal;
}

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Client of the server's market-data API (`/api/market/*`, see ../protocol.ts). `base` is '' when
 * the server also serves the app (same origin). Calendars are loaded once per market.
 */
export class MarketApi {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly calendars = new Map<string, Promise<SessionCalendar>>();

  constructor(base = '', fetchImpl: typeof fetch = (input, init) => fetch(input, init)) {
    this.base = base.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
  }

  async bars(q: BarsQuery): Promise<Candle[]> {
    const params = new URLSearchParams({ market: q.market, symbol: q.symbol, tf: q.timeframe, limit: String(q.limit) });
    if (q.startTime !== undefined) params.set('start', String(Math.floor(q.startTime)));
    if (q.endTime !== undefined) params.set('end', String(Math.floor(q.endTime)));
    const res = await this.get<BarsResponse>(`/api/market/bars?${params.toString()}`, q.signal);
    if (!Array.isArray(res.bars)) throw new MarketApiError('Unexpected answer from the market-data server', 200);
    const out: Candle[] = [];
    for (const b of res.bars) {
      if (!Array.isArray(b) || b.length < 7) continue;
      out.push({ time: b[0], open: b[1], high: b[2], low: b[3], close: b[4], volume: b[5], closed: b[6] === 1 });
    }
    return out;
  }

  async symbol(market: string, symbol: string, signal?: AbortSignal): Promise<WireSymbol> {
    const params = new URLSearchParams({ market, symbol });
    return (await this.get<SymbolResponse>(`/api/market/symbol?${params.toString()}`, signal)).symbol;
  }

  async search(query: string, signal?: AbortSignal): Promise<SymbolMatch[]> {
    const params = new URLSearchParams({ q: query, limit: '30' });
    return [...(await this.get<SearchResponse>(`/api/market/search?${params.toString()}`, signal)).results];
  }

  async markets(signal?: AbortSignal): Promise<MarketStatus[]> {
    return [...(await this.get<MarketsResponse>('/api/market/markets', signal)).markets];
  }

  /** The market's trading sessions; loaded once, retried after a failure. */
  calendar(market: string): Promise<SessionCalendar> {
    let pending = this.calendars.get(market);
    if (!pending) {
      pending = this.get<CalendarResponse>(`/api/market/calendar?${new URLSearchParams({ market }).toString()}`).then((res) =>
        new SessionCalendar(res.sessions.map(([day, open, close]) => ({ day, open, close }))),
      );
      this.calendars.set(market, pending);
      pending.catch(() => this.calendars.delete(market));
    }
    return pending;
  }

  private async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchImpl(this.base + path, {
        // A login proxy (e.g. an expired Cloudflare Access session) answers with a redirect.
        redirect: 'manual',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      if (timeout.aborted) throw new MarketApiError('The market-data server did not answer in time', 0, 'unreachable');
      throw new MarketApiError('The market-data server is unreachable', 0, 'unreachable');
    }
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) throw new MarketApiError('The server needs a new login (open the sync panel)', 0, 'login');
    if (res.headers.get(MARKET_API_HEADER) !== '1') throw new MarketApiError('This server has no market-data API', res.status, 'absent');
    const text = await res.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      // not JSON: e.g. a proxy's HTML error page
    }
    if (!res.ok) {
      const reason = typeof (payload as { error?: unknown } | null)?.error === 'string' ? (payload as { error: string }).error : null;
      throw new MarketApiError(reason ?? `Market data unavailable (HTTP ${res.status})`, res.status);
    }
    if (payload === null || typeof payload !== 'object') throw new MarketApiError('Unexpected answer from the market-data server', res.status);
    return payload as T;
  }
}
