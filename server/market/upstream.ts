/** A failed upstream request. `status` 0 = no HTTP answer (network error or timeout). */
export class UpstreamError extends Error {
  readonly status: number;
  readonly upstream: string;
  constructor(upstream: string, status: number, message: string) {
    super(`${upstream}: ${message}`);
    this.status = status;
    this.upstream = upstream;
  }
}

export interface HttpClientOptions {
  /** Name used in errors and logs, e.g. 'Alpaca'. */
  readonly name: string;
  /** Sustained request rate. */
  readonly perSecond: number;
  /** Requests allowed back to back before the rate applies. */
  readonly burst: number;
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const sleepReal = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * JSON GET client for one upstream provider: a token bucket keeps it below the provider's rate
 * limit, and failures that can succeed later (429, 5xx, network, timeout) are retried with
 * backoff, honouring `Retry-After`. Other client errors fail at once.
 */
export class HttpClient {
  private readonly o: Required<HttpClientOptions>;
  private tokens: number;
  private refilledAt: number;
  private pausedUntil = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: HttpClientOptions) {
    this.o = {
      maxAttempts: 3,
      timeoutMs: 20_000,
      fetchImpl: (input, init) => fetch(input, init),
      now: () => Date.now(),
      sleep: sleepReal,
      ...options,
    };
    this.tokens = options.burst;
    this.refilledAt = this.o.now();
  }

  async getJson(url: string, headers: Readonly<Record<string, string>> = {}): Promise<unknown> {
    let lastError: UpstreamError | null = null;
    for (let attempt = 0; attempt < this.o.maxAttempts; attempt++) {
      await this.slot();
      let res: Response;
      try {
        // No redirects: they would carry the credential headers to wherever they point.
        res = await this.o.fetchImpl(url, { headers, redirect: 'error', signal: AbortSignal.timeout(this.o.timeoutMs) });
      } catch (err) {
        const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
        lastError = new UpstreamError(this.o.name, 0, timedOut ? 'no answer in time' : 'unreachable');
        await this.backoff(attempt, null);
        continue;
      }
      if (res.ok) {
        try {
          return (await res.json()) as unknown;
        } catch {
          throw new UpstreamError(this.o.name, res.status, 'answer is not JSON');
        }
      }
      const reason = await errorReason(res);
      lastError = new UpstreamError(this.o.name, res.status, reason);
      if (res.status !== 429 && res.status < 500) throw lastError; // bad request, auth, not found, IP ban (418)
      await this.backoff(attempt, res.headers.get('retry-after'));
    }
    throw lastError ?? new UpstreamError(this.o.name, 0, 'request failed');
  }

  /** Waits for a token (requests are served in order). */
  private slot(): Promise<void> {
    const run = this.queue.then(async () => {
      for (;;) {
        const now = this.o.now();
        if (now < this.pausedUntil) {
          await this.o.sleep(this.pausedUntil - now);
          continue;
        }
        this.tokens = Math.min(this.o.burst, this.tokens + ((now - this.refilledAt) / 1000) * this.o.perSecond);
        this.refilledAt = now;
        if (this.tokens >= 1) {
          this.tokens -= 1;
          return;
        }
        await this.o.sleep(Math.ceil(((1 - this.tokens) / this.o.perSecond) * 1000));
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async backoff(attempt: number, retryAfter: string | null): Promise<void> {
    if (attempt + 1 >= this.o.maxAttempts) return;
    const seconds = retryAfter !== null ? Number(retryAfter) : NaN;
    const wait = Number.isFinite(seconds) && seconds >= 0 ? Math.min(60_000, seconds * 1000) : 1_000 * 2 ** attempt;
    // Every request pauses: a rate limit is per account/IP, not per request.
    this.pausedUntil = Math.max(this.pausedUntil, this.o.now() + wait);
  }
}

async function errorReason(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const body = JSON.parse(text) as { message?: unknown; msg?: unknown; chart?: { error?: { description?: unknown } } };
    // Alpaca: message; Binance: msg; Yahoo: chart.error.description.
    const yahoo = body.chart?.error?.description;
    const message = typeof body.message === 'string' ? body.message : typeof body.msg === 'string' ? body.msg : typeof yahoo === 'string' ? yahoo : null;
    if (message) return `HTTP ${res.status} (${message.slice(0, 200)})`;
  } catch {
    // not JSON
  }
  return `HTTP ${res.status}`;
}
