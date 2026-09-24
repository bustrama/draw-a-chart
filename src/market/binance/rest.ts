import type { Candle, CandleRequest } from '../types';
import { parseRestKline } from './normalize';

export interface RestClientOptions {
  /** Base URLs tried in order; later ones are used only after a failure. */
  readonly baseUrls: readonly string[];
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Minimum spacing between requests (ms). Keeps us far below Binance's per-IP weight budget. */
  readonly minSpacingMs?: number;
  readonly maxAttempts?: number;
  readonly random?: () => number;
}

export class HttpStatusError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const id = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(id);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Public-market-data REST client.
 *
 * Browser constraints (verified against the live API): successful responses carry
 * `Access-Control-Allow-Origin: *`, but error responses (400/429/418) carry no CORS headers,
 * so in a browser they surface as an opaque `TypeError`. We therefore cannot read
 * `Retry-After` or the weight header, and must treat every failure as a possible rate limit:
 * requests are serialized and paced, and failures back off exponentially with jitter
 * (2 s .. 60 s) before rotating to the next base URL. The weight counter is shared across all
 * Binance hosts, so host rotation helps with outages/geo-blocks, not with rate limits.
 */
export class BinanceRestClient {
  private readonly opts: Required<Omit<RestClientOptions, 'fetchImpl'>> & { fetchImpl: typeof fetch };
  private queue: Promise<unknown> = Promise.resolve();
  private nextSlotAt = 0;
  private pausedUntil = 0;
  private hostIndex = 0;

  constructor(options: RestClientOptions) {
    if (options.baseUrls.length === 0) throw new Error('at least one base URL is required');
    this.opts = {
      baseUrls: options.baseUrls,
      fetchImpl: options.fetchImpl ?? ((input, init) => fetch(input, init)),
      now: options.now ?? (() => Date.now()),
      sleep: options.sleep ?? defaultSleep,
      minSpacingMs: options.minSpacingMs ?? 250,
      maxAttempts: options.maxAttempts ?? 4,
      random: options.random ?? Math.random,
    };
  }

  fetchKlines(req: CandleRequest): Promise<Candle[]> {
    const params = new URLSearchParams({ symbol: req.symbol, interval: req.timeframe, limit: String(req.limit) });
    if (req.startTime !== undefined) params.set('startTime', String(Math.floor(req.startTime)));
    if (req.endTime !== undefined) params.set('endTime', String(Math.floor(req.endTime)));
    return this.enqueue(async () => {
      const body = await this.getJson(`/api/v3/klines?${params.toString()}`, req.signal);
      if (!Array.isArray(body)) throw new Error('Unexpected klines response');
      const now = this.opts.now();
      const out: Candle[] = [];
      for (const row of body) {
        const c = parseRestKline(row, now);
        if (c) out.push(c);
      }
      return out;
    });
  }

  /** Serializes requests so pacing and backoff apply globally. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async getJson(path: string, signal?: AbortSignal): Promise<unknown> {
    const { baseUrls, maxAttempts } = this.opts;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await this.waitForSlot(signal);
      const base = baseUrls[this.hostIndex % baseUrls.length];
      try {
        const res = await this.opts.fetchImpl(base + path, { signal, credentials: 'omit' });
        if (res.ok) {
          this.pausedUntil = 0;
          return (await res.json()) as unknown;
        }
        if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 418 && res.status !== 429) {
          // Readable client error (bad symbol/params): retrying cannot help.
          throw new HttpStatusError(res.status, `HTTP ${res.status}`);
        }
        lastError = new HttpStatusError(res.status, `HTTP ${res.status}`);
      } catch (err) {
        if (signal?.aborted) throw signal.reason ?? err;
        if (err instanceof HttpStatusError && err.status < 500 && err.status !== 408 && err.status !== 418 && err.status !== 429) {
          throw err;
        }
        lastError = err;
      }
      // Possible rate limit or outage: back off globally, then try the next host.
      const backoff = Math.min(60_000, 2_000 * 2 ** attempt);
      const jittered = backoff / 2 + this.opts.random() * (backoff / 2);
      this.pausedUntil = Math.max(this.pausedUntil, this.opts.now() + jittered);
      this.hostIndex++;
    }
    throw lastError instanceof Error ? lastError : new Error('Request failed');
  }

  private async waitForSlot(signal?: AbortSignal): Promise<void> {
    const now = this.opts.now();
    const at = Math.max(this.nextSlotAt, this.pausedUntil, now);
    this.nextSlotAt = at + this.opts.minSpacingMs;
    if (at > now) await this.opts.sleep(at - now, signal);
  }
}
