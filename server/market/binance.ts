import type { Bar } from './cache.ts';
import { HttpClient, UpstreamError } from './upstream.ts';

/** The market-data-only host first, then the general API host. */
export const BINANCE_URLS = ['https://data-api.binance.vision', 'https://api.binance.com'] as const;

export interface CryptoSymbol {
  readonly symbol: string;
  readonly base: string;
  readonly quote: string;
  /** Minimal price step, e.g. '0.01000000'. */
  readonly tickSize: string;
}

const PAGE = 1000;

/**
 * Binance Spot public market data (no key): klines and the list of trading pairs. Klines cost
 * 2 of the 6000 weight units a minute per IP; the client stays far below that.
 */
export class BinanceUpstream {
  private readonly http: HttpClient;
  private readonly urls: readonly string[];

  constructor(http?: HttpClient, urls: readonly string[] = BINANCE_URLS) {
    this.http = http ?? new HttpClient({ name: 'Binance', perSecond: 8, burst: 20 });
    this.urls = urls;
  }

  /** Bars opening in [from, to] (every page), oldest first. The forming bar, if in range, comes back too. */
  async klines(symbol: string, interval: string, from: number, to: number): Promise<Bar[]> {
    const out: Bar[] = [];
    let start = from;
    while (start <= to) {
      const params = new URLSearchParams({ symbol, interval, startTime: String(start), endTime: String(to), limit: String(PAGE) });
      const rows = await this.get(`/api/v3/klines?${params.toString()}`);
      if (!Array.isArray(rows)) throw new UpstreamError('Binance', 200, 'unexpected klines answer');
      for (const row of rows) {
        const bar = parseKline(row);
        if (bar && bar.t >= start && bar.t <= to) out.push(bar);
      }
      if (rows.length < PAGE) break;
      const last = out[out.length - 1];
      if (!last || last.t < start) break;
      start = last.t + 1;
    }
    return out;
  }

  /** Every spot pair currently trading. */
  async symbols(): Promise<CryptoSymbol[]> {
    const body = (await this.get('/api/v3/exchangeInfo?permissions=SPOT&symbolStatus=TRADING')) as { symbols?: unknown };
    if (!Array.isArray(body.symbols)) throw new UpstreamError('Binance', 200, 'unexpected exchangeInfo answer');
    const out: CryptoSymbol[] = [];
    for (const s of body.symbols as Array<Record<string, unknown>>) {
      if (s.status !== 'TRADING' || typeof s.symbol !== 'string' || typeof s.baseAsset !== 'string' || typeof s.quoteAsset !== 'string') continue;
      const filters = Array.isArray(s.filters) ? (s.filters as Array<Record<string, unknown>>) : [];
      const price = filters.find((f) => f.filterType === 'PRICE_FILTER');
      out.push({ symbol: s.symbol, base: s.baseAsset, quote: s.quoteAsset, tickSize: typeof price?.tickSize === 'string' ? price.tickSize : '0.01' });
    }
    return out;
  }

  /** Tries the hosts in order; only an unreachable host or a server error moves on to the next. */
  private async get(path: string): Promise<unknown> {
    let last: unknown = null;
    for (const url of this.urls) {
      try {
        return await this.http.getJson(url + path);
      } catch (err) {
        last = err;
        if (!(err instanceof UpstreamError) || (err.status !== 0 && err.status < 500)) throw err;
      }
    }
    throw last;
  }
}

/** [openTime, open, high, low, close, volume, closeTime, ...] */
function parseKline(row: unknown): Bar | null {
  if (!Array.isArray(row) || row.length < 6 || typeof row[0] !== 'number') return null;
  const bar = { t: row[0], o: Number(row[1]), h: Number(row[2]), l: Number(row[3]), c: Number(row[4]), v: Number(row[5]) };
  return Number.isFinite(bar.o) && Number.isFinite(bar.h) && Number.isFinite(bar.l) && Number.isFinite(bar.c) && Number.isFinite(bar.v) ? bar : null;
}

/** Decimals of a tick size such as '0.01000000' (2) or '1.00000000' (0). */
export function tickDecimals(tickSize: string): number {
  const [, frac = ''] = tickSize.split('.');
  const trimmed = frac.replace(/0+$/, '');
  return trimmed.length;
}
