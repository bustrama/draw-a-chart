import type { Bar } from './cache.ts';
import { HttpClient, UpstreamError } from './upstream.ts';

/** Yahoo chart intervals the app's futures timeframes are built from. */
export type YahooInterval = '1m' | '5m' | '15m' | '60m' | '1d';

const MIN = 60_000;
const DAY = 86_400_000;
const INTERVAL_MS: Readonly<Record<YahooInterval, number>> = { '1m': MIN, '5m': 5 * MIN, '15m': 15 * MIN, '60m': 60 * MIN, '1d': DAY };
/**
 * How far back Yahoo serves each interval: 1-minute bars 30 days, 5 and 15 minutes 60 days, hourly
 * 730 days, daily all of them. It refuses requests reaching further (HTTP 422).
 */
const LIMIT_DAYS: Readonly<Record<YahooInterval, number | null>> = { '1m': 30, '5m': 60, '15m': 60, '60m': 730, '1d': null };
/** Requests stay this far inside Yahoo's limit (clocks differ). */
const LIMIT_MARGIN_MS = 60 * MIN;
/** At most this many days per request (Yahoo serves 8 days of 1-minute bars at a time). */
const SPAN_DAYS: Readonly<Record<YahooInterval, number>> = { '1m': 7, '5m': 60, '15m': 60, '60m': 730, '1d': 36_500 };
/**
 * Yahoo reports no volume for the first row of an answer: intraday requests start this many bars
 * early, and the rows before the range are dropped. (It also reports none for the first bar after
 * the daily break, 18:00 New York on Monday to Thursday evenings, wherever it is: nothing to do
 * about that.)
 */
const LEAD_BARS = 30;
/** CME data on Yahoo is 10 minutes late. */
const CME_DELAY_MS = 10 * MIN;
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; draw-a-chart)', Accept: 'application/json' } as const;

export interface YahooOptions {
  readonly baseUrl?: string;
  readonly http?: HttpClient;
  readonly now?: () => number;
}

interface ChartResult {
  readonly timestamp?: unknown;
  readonly indicators?: { readonly quote?: ReadonlyArray<Record<string, unknown>> };
}

/**
 * Yahoo Finance's chart API: continuous front-month futures, 10 minutes late, no key. It is
 * unofficial (no agreement, it may change or block without notice), so the server caches every
 * bar and keeps what Yahoo stops serving (see MarketService.archiveFutures).
 */
export class YahooUpstream {
  readonly delayMs = CME_DELAY_MS;
  private readonly http: HttpClient;
  private readonly baseUrl: string;
  private readonly now: () => number;

  constructor(options: YahooOptions = {}) {
    // No published limit: stay polite.
    this.http = options.http ?? new HttpClient({ name: 'Yahoo', perSecond: 2, burst: 8 });
    this.baseUrl = (options.baseUrl ?? 'https://query1.finance.yahoo.com').replace(/\/+$/, '');
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Earliest time bars of `interval` can be counted on (null = all history): a day inside Yahoo's
   * limit, so a range planned from it is still served when its request goes out, however late.
   */
  historyStart(interval: YahooInterval): number | null {
    const limit = this.limit(interval);
    return limit === null ? null : limit + DAY - LIMIT_MARGIN_MS;
  }

  /**
   * Bars opening in [start, end], oldest first; nothing for the part Yahoo no longer serves or
   * never had (before a contract's first trading day). Intraday bars open on the interval; daily
   * bars at midnight New York time.
   */
  async bars(ticker: string, interval: YahooInterval, start: number, end: number): Promise<Bar[]> {
    const from = Math.max(start, this.limit(interval) ?? start);
    const span = SPAN_DAYS[interval] * DAY;
    const out: Bar[] = [];
    for (let a = from; a <= end; a += span) out.push(...(await this.chunk(ticker, interval, a, Math.min(end, a + span - 1))));
    return out;
  }

  /** The oldest time Yahoo still serves for `interval`, with a margin; null = all history. */
  private limit(interval: YahooInterval): number | null {
    const days = LIMIT_DAYS[interval];
    return days === null ? null : this.now() - days * DAY + LIMIT_MARGIN_MS;
  }

  private async chunk(ticker: string, interval: YahooInterval, start: number, end: number): Promise<Bar[]> {
    const ms = INTERVAL_MS[interval];
    const lead = interval === '1d' ? 0 : LEAD_BARS * ms;
    const params = new URLSearchParams({
      interval,
      period1: String(Math.floor(Math.max(start - lead, this.limit(interval) ?? -Infinity) / 1000)),
      // Past the last bar's open: the latest trade comes as a row of its own, after it.
      period2: String(Math.ceil((end + ms) / 1000)),
    });
    let body: { chart?: { result?: unknown; error?: { description?: unknown } | null } };
    try {
      body = (await this.http.getJson(`${this.baseUrl}/v8/finance/chart/${encodeURIComponent(ticker)}?${params.toString()}`, HEADERS)) as typeof body;
    } catch (err) {
      // "Data doesn't exist for startDate = …": all of the range is before the contract's data.
      if (err instanceof UpstreamError && err.status === 400 && /doesn.t exist/i.test(err.message)) return [];
      throw err;
    }
    const result = Array.isArray(body?.chart?.result) ? (body.chart.result[0] as ChartResult | undefined) : undefined;
    if (!result || typeof result !== 'object') {
      const reason = body?.chart?.error?.description;
      throw new UpstreamError('Yahoo', 200, typeof reason === 'string' ? reason.slice(0, 200) : 'unexpected chart answer');
    }
    return parseRows(result, interval === '1d' ? null : ms, start, end);
  }
}

/**
 * Chart rows to bars opening in [start, end]. Rows without prices (breaks, weekends) are skipped.
 * The range filter matters: an answer ending before today also carries today's price at 23:59 New
 * York the evening before, after the range.
 * Intraday rows are put on the interval's grid (in UTC too: New York is whole hours off UTC): the
 * newest row may be the latest trade, between two opens, which belongs to the bar it falls in.
 */
function parseRows(result: ChartResult, intervalMs: number | null, start: number, end: number): Bar[] {
  const times = Array.isArray(result.timestamp) ? (result.timestamp as unknown[]) : [];
  const quote = result.indicators?.quote?.[0] ?? {};
  const column = (name: string): unknown[] => (Array.isArray(quote[name]) ? (quote[name] as unknown[]) : []);
  const [open, high, low, close, volume] = ['open', 'high', 'low', 'close', 'volume'].map(column);
  const out: Array<{ t: number; o: number; h: number; l: number; c: number; v: number }> = [];
  for (let i = 0; i < times.length; i++) {
    const raw = Number(times[i]) * 1000;
    const o = open[i];
    const h = high[i];
    const l = low[i];
    const c = close[i];
    if (!Number.isFinite(raw) || !isPrice(o) || !isPrice(h) || !isPrice(l) || !isPrice(c)) continue;
    const v = typeof volume[i] === 'number' && Number.isFinite(volume[i]) ? (volume[i] as number) : 0;
    const t = intervalMs === null ? raw : Math.floor(raw / intervalMs) * intervalMs;
    if (t < start || t > end) continue;
    const prev = out[out.length - 1];
    if (prev && t < prev.t) continue; // out of order: never seen, never trusted
    if (prev && t === prev.t) {
      prev.h = Math.max(prev.h, h);
      prev.l = Math.min(prev.l, l);
      prev.c = c;
      prev.v += v;
    } else {
      out.push({ t, o, h, l, c, v });
    }
  }
  return out;
}

/** Any finite number: crude oil traded below zero in April 2020. */
function isPrice(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}
