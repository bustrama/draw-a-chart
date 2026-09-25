import type { IncomingMessage, ServerResponse } from 'node:http';
import type { BarsResponse, CalendarResponse, MarketsResponse, SearchResponse, SymbolResponse, WireBar } from '../../src/market/protocol.ts';
import type { ErrorResponse } from '../../src/sync/protocol.ts';
import type { Identify } from '../app.ts';
import { allow, HttpError, json } from '../httpUtil.ts';
import { isTimeframe, MarketError, MAX_LIMIT, type MarketService } from './service.ts';
import { UpstreamError } from './upstream.ts';

export interface MarketApp {
  /** Handles `/api/market/*`. Resolves false for any other path. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
}

export interface MarketAppOptions {
  readonly service: MarketService;
  /** Same caller check as the sync API (server/app.ts). */
  readonly identify: Identify;
  readonly log?: (message: string) => void;
}

/**
 * Marks every answer of this API, so the app can tell it from anything else at the same path (a
 * server with market data off, a static host's index.html, a proxy's error page).
 */
export const MARKET_API_HEADER = 'X-Market-Api';

/** Tickers such as AAPL, BRK.B, BTCUSDT. */
const SYMBOL = /^[A-Z0-9][A-Z0-9.-]{0,19}$/;
/** 2000-01-01 .. 2100-01-01: anything else is a malformed timestamp. */
const MIN_TIME = 946_684_800_000;
const MAX_TIME = 4_102_444_800_000;

/**
 * The market-data API (see src/market/protocol.ts):
 * GET /api/market/markets, /search, /symbol, /calendar, /bars.
 */
export function createMarketApp(options: MarketAppOptions): MarketApp {
  const { service, identify } = options;
  const log = options.log ?? ((m: string) => console.log(m));

  async function route(req: IncomingMessage, res: ServerResponse, path: string, q: URLSearchParams): Promise<void> {
    allow(req, 'GET');
    if (!(await identify(req))) throw new HttpError(401, 'not signed in');
    switch (path) {
      case '/api/market/markets':
        return json(res, 200, { markets: service.markets() } satisfies MarketsResponse);
      case '/api/market/search': {
        const query = (q.get('q') ?? '').slice(0, 40);
        const limit = intParam(q, 'limit', 1, 50) ?? 30;
        return json(res, 200, { results: await service.search(query, limit) } satisfies SearchResponse);
      }
      case '/api/market/symbol': {
        const market = required(q, 'market');
        const symbol = symbolParam(q);
        const found = await service.symbol(market, symbol);
        if (!found) throw new HttpError(404, `unknown symbol ${symbol}`);
        return json(res, 200, { symbol: found } satisfies SymbolResponse);
      }
      case '/api/market/calendar':
        return json(res, 200, { sessions: await service.sessions(required(q, 'market')) } satisfies CalendarResponse);
      case '/api/market/bars': {
        const tf = required(q, 'tf');
        if (!isTimeframe(tf)) throw new HttpError(400, `unknown timeframe ${tf}`);
        const bars = await service.bars({
          market: required(q, 'market'),
          symbol: symbolParam(q),
          tf,
          limit: intParam(q, 'limit', 1, MAX_LIMIT) ?? 500,
          start: intParam(q, 'start', MIN_TIME, MAX_TIME),
          end: intParam(q, 'end', MIN_TIME, MAX_TIME),
        });
        const wire: WireBar[] = bars.map((b) => [b.t, b.o, b.h, b.l, b.c, b.v, b.closed ? 1 : 0]);
        return json(res, 200, { bars: wire } satisfies BarsResponse);
      }
      default:
        throw new HttpError(404, 'not found');
    }
  }

  return {
    async handle(req, res) {
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://localhost');
      } catch {
        return false;
      }
      const path = url.pathname;
      if (path !== '/api/market' && !path.startsWith('/api/market/')) return false;
      res.setHeader(MARKET_API_HEADER, '1');
      try {
        await route(req, res, path, url.searchParams);
      } catch (err) {
        const status = err instanceof HttpError || err instanceof MarketError ? err.status : err instanceof UpstreamError ? 502 : 500;
        if (status === 500) log(`[market] ${req.method} ${path} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        else if (status === 502) log(`[market] ${path}: ${(err as Error).message}`);
        if (res.headersSent) {
          res.destroy();
          return true;
        }
        if (err instanceof HttpError) for (const [name, value] of Object.entries(err.headers)) res.setHeader(name, value);
        const text = status === 500 ? 'internal error' : status === 502 ? `market data provider failed: ${(err as Error).message}` : (err as Error).message;
        json(res, status, { error: text } satisfies ErrorResponse);
      }
      return true;
    },
  };
}

function required(q: URLSearchParams, name: string): string {
  const value = q.get(name);
  if (!value) throw new HttpError(400, `${name} is required`);
  return value;
}

function symbolParam(q: URLSearchParams): string {
  const symbol = required(q, 'symbol').toUpperCase();
  if (!SYMBOL.test(symbol)) throw new HttpError(400, 'malformed symbol');
  return symbol;
}

/** An integer parameter in [min, max], or undefined when absent. */
function intParam(q: URLSearchParams, name: string, min: number, max: number): number | undefined {
  const raw = q.get(name);
  if (raw === null || raw === '') return undefined;
  if (!/^\d{1,15}$/.test(raw)) throw new HttpError(400, `${name} must be an integer`);
  const value = Number(raw);
  if (value < min || value > max) throw new HttpError(400, `${name} must be between ${min} and ${max}`);
  return value;
}
