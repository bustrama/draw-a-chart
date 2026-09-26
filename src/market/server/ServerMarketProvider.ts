import { clockFor, getTimeframe } from '../timeframes';
import type { Candle, CandleRequest, LiveCandleListener, MarketDataProvider, PreparedChart, SymbolInfo, TimeframeId } from '../types';
import { MarketApiError, type MarketApi } from './marketApi';

export interface ServerMarketProviderOptions {
  readonly api: MarketApi;
  /** Market id on the server ('binance', 'us', 'futures'); also the drawings' namespace. */
  readonly market: string;
  readonly name: string;
  /** Live updates from this provider (Binance's own stream); otherwise the server is polled. */
  readonly live?: Pick<MarketDataProvider, 'subscribeCandles'>;
  /** Used when the server cannot be reached (Binance's public API from the device). */
  readonly fallback?: MarketDataProvider;
  /** Polling period for live updates from the server (default: every minute, just after it turns). */
  readonly pollMs?: number;
  /**
   * How long after its end the server may still revise a bar (its settle margin): each poll covers
   * that span, so an open chart sees every bar's final version. Default: one minute.
   */
  readonly revisableMs?: number;
  readonly now?: () => number;
  /** For 'visibilitychange': poll right away when the app comes back. */
  readonly documentEvents?: EventTarget & { readonly visibilityState?: string };
}

/** Bars the poller asks for: the forming bar and the two before it. */
const POLL_BARS = 3;
/**
 * Poll this long after each minute boundary: the server's delayed data trails by the delay plus 30 s
 * (clock-skew margin), so this sees the minute that has just ended.
 */
const POLL_OFFSET_MS = 35_000;

/**
 * A market served by the self-hosted server (`/api/market/*`): history comes from the server's
 * bar cache (it fetches only what it is missing upstream), symbol details and trading sessions
 * too. Live updates come from another provider (Binance's stream, straight from the device) or
 * from polling the server once a minute (stocks and futures: the data is delayed anyway).
 */
export class ServerMarketProvider implements MarketDataProvider {
  readonly id: string;
  readonly name: string;
  readonly maxCandlesPerRequest = 1000;
  readonly completeHistory = true;
  private readonly o: ServerMarketProviderOptions;

  constructor(options: ServerMarketProviderOptions) {
    this.o = options;
    this.id = options.market;
    this.name = options.name;
  }

  symbols(): readonly SymbolInfo[] {
    return this.o.fallback?.symbols() ?? [];
  }

  async prepare(symbol: string, timeframe: TimeframeId, signal?: AbortSignal): Promise<PreparedChart> {
    const { api, market, fallback } = this.o;
    try {
      const wire = await api.symbol(market, symbol, signal);
      const calendar = wire.sessions ? await api.calendar(market) : null;
      const info: SymbolInfo = {
        symbol: wire.symbol,
        base: wire.base,
        quote: wire.quote,
        name: wire.name,
        pricePrecision: wire.pricePrecision,
        minMove: wire.minMove,
        timeZone: wire.timeZone,
        delayMs: wire.delayMs,
      };
      return { info, clock: clockFor(getTimeframe(timeframe), calendar) };
    } catch (err) {
      if (fallback && unreachable(err)) return fallback.prepare(symbol, timeframe, signal);
      throw err;
    }
  }

  async fetchCandles(req: CandleRequest): Promise<Candle[]> {
    const { api, market, fallback } = this.o;
    try {
      return await api.bars({ market, symbol: req.symbol, timeframe: req.timeframe, limit: Math.min(req.limit, this.maxCandlesPerRequest), startTime: req.startTime, endTime: req.endTime, signal: req.signal });
    } catch (err) {
      if (fallback && unreachable(err)) return fallback.fetchCandles(req);
      throw err;
    }
  }

  subscribeCandles(symbol: string, timeframe: TimeframeId, listener: LiveCandleListener): () => void {
    if (this.o.live) return this.o.live.subscribeCandles(symbol, timeframe, listener);
    return this.poll(symbol, timeframe, listener);
  }

  /**
   * Polls the latest bars once a minute, just after the minute turns. A failed poll reports
   * 'reconnecting'; the first success after it asks the feed to resynchronize (it backfills
   * whatever it missed). Skipped bars (e.g. the device slept) are caught by the feed itself.
   */
  private poll(symbol: string, timeframe: TimeframeId, listener: LiveCandleListener): () => void {
    const { api, market } = this.o;
    const limit = Math.max(POLL_BARS, Math.ceil((this.o.revisableMs ?? 0) / getTimeframe(timeframe).ms) + 2);
    const now = this.o.now ?? (() => Date.now());
    const documentEvents = this.o.documentEvents ?? (typeof document !== 'undefined' ? document : undefined);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: AbortController | null = null;
    let failed = false;
    listener.onStatus?.('connecting');

    const schedule = () => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      const period = this.o.pollMs ?? 60_000;
      const t = now();
      const delay = this.o.pollMs !== undefined ? period : period - (t % period) + POLL_OFFSET_MS;
      timer = setTimeout(() => void tick(), delay);
    };
    const tick = async () => {
      timer = null;
      if (stopped || inFlight) return;
      const abort = new AbortController();
      inFlight = abort;
      try {
        const bars = await api.bars({ market, symbol, timeframe, limit, signal: abort.signal });
        if (stopped) return;
        if (failed) {
          failed = false;
          listener.onResync?.();
        }
        listener.onStatus?.('live');
        for (const c of bars) listener.onCandle(c);
      } catch {
        if (stopped) return;
        failed = true;
        listener.onStatus?.(typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'reconnecting');
      } finally {
        if (inFlight === abort) inFlight = null;
        schedule();
      }
    };
    const onVisibility = () => {
      if (documentEvents?.visibilityState !== 'hidden') void tick();
    };
    documentEvents?.addEventListener('visibilitychange', onVisibility);
    // The first answer confirms the connection; the feed loads the history itself.
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      inFlight?.abort();
      documentEvents?.removeEventListener('visibilitychange', onVisibility);
    };
  }
}

/**
 * The market-data server could not serve this at all (unreachable, behind an expired login, not
 * there, a gateway error, or the market turned off), as opposed to refusing the request.
 */
function unreachable(err: unknown): boolean {
  return err instanceof MarketApiError && (err.kind !== 'error' || err.status === 502 || err.status === 503 || err.status === 504);
}
