import { CandleSeries, type SeriesChange } from './candleSeries';
import { clockFor } from './timeframes';
import type { BarClock, Candle, LiveStatus, MarketDataProvider, Timeframe } from './types';

export interface FeedState {
  readonly live: LiveStatus;
  readonly initialLoaded: boolean;
  readonly loadingOlder: boolean;
  readonly historyExhausted: boolean;
  readonly error: string | null;
}

export interface FeedListener {
  onChange(change: SeriesChange, series: CandleSeries): void;
  onState?(state: FeedState): void;
}

export interface CandleFeedOptions {
  /** Which bar open times exist (trading sessions); default: every interval around the clock. */
  readonly clock?: BarClock;
  readonly initialBars?: number;
  readonly pageSize?: number;
  readonly now?: () => number;
  readonly retryDelayMs?: number;
  /** Delay before re-fetching a bar whose final (closed) update we did not receive. */
  readonly finalizeDelayMs?: number;
  readonly onError?: (err: unknown) => void;
}

/**
 * Keeps one symbol + timeframe in sync: initial history, live updates, pagination into the past,
 * gap detection/backfill and recovery after reconnects. Provider-agnostic and chart-agnostic:
 * it only mutates a CandleSeries and reports what changed.
 */
export class CandleFeed {
  readonly series: CandleSeries;
  private state: FeedState = { live: 'idle', initialLoaded: false, loadingOlder: false, historyExhausted: false, error: null };
  private ready = false;
  private buffer: Candle[] = [];
  private unsubscribe: (() => void) | null = null;
  private readonly abort = new AbortController();
  private disposed = false;
  private backfillChain: Promise<void> = Promise.resolve();
  /** Gaps confirmed to exist at the exchange (e.g. historical outages); never re-fetched. */
  private readonly knownGaps = new Set<string>();
  private finalizeTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly provider: MarketDataProvider;
  readonly symbol: string;
  readonly timeframe: Timeframe;
  private readonly listener: FeedListener;
  private readonly clock: BarClock;
  private readonly o: Required<Omit<CandleFeedOptions, 'onError' | 'clock'>> & Pick<CandleFeedOptions, 'onError'>;

  constructor(provider: MarketDataProvider, symbol: string, timeframe: Timeframe, listener: FeedListener, options: CandleFeedOptions = {}) {
    this.provider = provider;
    this.symbol = symbol;
    this.timeframe = timeframe;
    this.listener = listener;
    this.clock = options.clock ?? clockFor(timeframe);
    this.series = new CandleSeries(this.clock);
    this.o = {
      initialBars: options.initialBars ?? 1000,
      pageSize: Math.min(options.pageSize ?? 1000, provider.maxCandlesPerRequest),
      now: options.now ?? (() => Date.now()),
      retryDelayMs: options.retryDelayMs ?? 10_000,
      finalizeDelayMs: options.finalizeDelayMs ?? 1_500,
      onError: options.onError,
    };
  }

  get currentState(): FeedState {
    return this.state;
  }

  start(): void {
    if (this.unsubscribe || this.disposed) return;
    // Subscribe before loading history so no update between the two is lost; updates are
    // buffered until the history arrives and then merged (duplicates resolve by open time).
    this.unsubscribe = this.provider.subscribeCandles(this.symbol, this.timeframe.id, {
      onCandle: (c) => this.onLiveCandle(c),
      onResync: () => this.onResync(),
      onStatus: (live) => this.patchState({ live }),
    });
    void this.loadInitial();
  }

  /** Loads one page of older history. Resolves when done (no-op while busy/exhausted). */
  async loadOlder(): Promise<void> {
    const first = this.series.first;
    if (!this.ready || this.disposed || this.state.loadingOlder || this.state.historyExhausted || !first) return;
    this.patchState({ loadingOlder: true });
    try {
      const page = await this.provider.fetchCandles({
        symbol: this.symbol,
        timeframe: this.timeframe.id,
        endTime: first.time - 1,
        limit: this.o.pageSize,
        signal: this.abort.signal,
      });
      if (this.disposed) return;
      if (page.length === 0) this.patchState({ historyExhausted: true });
      else this.emit(this.series.merge(page));
    } catch (err) {
      this.reportError(err);
    } finally {
      if (!this.disposed) this.patchState({ loadingOlder: false });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.finalizeTimer) clearTimeout(this.finalizeTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }

  /** Resolves when all queued backfills have finished (for tests and orderly shutdown). */
  whenIdle(): Promise<void> {
    return this.backfillChain;
  }

  // ---------------------------------------------------------------------------------------

  private async loadInitial(): Promise<void> {
    this.retryTimer = null;
    try {
      const candles = await this.provider.fetchCandles({
        symbol: this.symbol,
        timeframe: this.timeframe.id,
        limit: this.o.initialBars,
        signal: this.abort.signal,
      });
      if (this.disposed) return;
      this.series.merge(candles);
      const buffered = this.buffer;
      this.buffer = [];
      if (buffered.length > 0) this.series.merge(buffered);
      this.ready = true;
      this.patchState({ initialLoaded: true, error: null });
      this.listener.onChange({ kind: 'general' }, this.series);
      // A provider with complete history (the server's cache) has no holes to fill inside it:
      // only where the buffered live updates join it. Minutes without trades stay unrequested.
      const since = candles.length === 0 ? 0 : this.provider.completeHistory ? candles[candles.length - 1].time : candles[0].time;
      this.backfillGaps(since);
      // A bar that closed while the history was loading (REST saw it open, the stream moved on
      // to the next bar) has no final update: re-fetch it.
      const bars = this.series.all();
      for (let i = bars.length - 2; i >= Math.max(0, bars.length - 4); i--) {
        if (!bars[i].closed) {
          this.scheduleFinalize(bars[i].time);
          break;
        }
      }
    } catch (err) {
      if (this.disposed || isAbortError(err)) return;
      this.reportError(err);
      this.retryTimer = setTimeout(() => void this.loadInitial(), this.o.retryDelayMs);
    }
  }

  private onLiveCandle(c: Candle): void {
    if (this.disposed) return;
    if (!this.ready) {
      this.buffer.push(c);
      return;
    }
    const prevLast = this.series.last;
    this.emit(this.series.merge([c]));
    if (!prevLast || c.time <= prevLast.time) return;
    if (c.time > this.clock.next(prevLast.time)) {
      // Missed at least one whole bar (e.g. dropped messages): fetch it and finalize prevLast.
      this.enqueueBackfill(prevLast.time, c.time - 1);
    } else if (!prevLast.closed) {
      // New bar started but we never saw the final update of the previous one.
      this.scheduleFinalize(prevLast.time);
    }
  }

  private onResync(): void {
    if (this.disposed || !this.ready) return;
    const last = this.series.last;
    if (!last) return;
    this.enqueueBackfill(last.time, this.o.now());
  }

  private scheduleFinalize(time: number): void {
    if (this.finalizeTimer) return;
    this.finalizeTimer = setTimeout(() => {
      this.finalizeTimer = null;
      const idx = this.series.indexOfTime(time);
      if (idx >= 0 && !this.series.all()[idx].closed) this.enqueueBackfill(time, this.o.now());
    }, this.o.finalizeDelayMs);
  }

  /** Fetches [from, to] (inclusive open times) page by page. Serialized with other backfills. */
  private enqueueBackfill(from: number, to: number): void {
    this.backfillChain = this.backfillChain.then(() => this.backfill(from, to)).catch((err) => this.reportError(err));
  }

  private async backfill(from: number, to: number): Promise<void> {
    let start = from;
    while (!this.disposed && start <= to) {
      const page = await this.provider.fetchCandles({
        symbol: this.symbol,
        timeframe: this.timeframe.id,
        startTime: start,
        endTime: to,
        limit: this.o.pageSize,
        signal: this.abort.signal,
      });
      if (this.disposed) return;
      if (page.length > 0) this.emit(this.series.merge(page));
      if (page.length < this.o.pageSize) break;
      start = this.clock.next(page[page.length - 1].time);
    }
    if (!this.disposed) this.rememberGaps(from, to);
  }

  /** Gaps inside [from, to] that survived a backfill exist at the exchange; don't retry them. */
  private rememberGaps(from: number, to: number): void {
    for (const g of this.series.findGaps()) {
      if (g.after >= this.clock.prev(from) && g.before <= this.clock.next(to)) this.knownGaps.add(gapKey(g.after, g.before));
    }
  }

  /** After the initial load, fill gaps in the loaded window that we have not confirmed yet. */
  private backfillGaps(since: number): void {
    for (const g of this.series.findGaps()) {
      if (g.after < since || this.knownGaps.has(gapKey(g.after, g.before))) continue;
      this.enqueueBackfill(g.after, g.before - 1);
    }
  }

  private emit(change: SeriesChange): void {
    if (change.kind !== 'none' && !this.disposed) this.listener.onChange(change, this.series);
  }

  private patchState(patch: Partial<FeedState>): void {
    const next = { ...this.state, ...patch };
    if (
      next.live === this.state.live &&
      next.initialLoaded === this.state.initialLoaded &&
      next.loadingOlder === this.state.loadingOlder &&
      next.historyExhausted === this.state.historyExhausted &&
      next.error === this.state.error
    ) {
      return;
    }
    this.state = next;
    this.listener.onState?.(next);
  }

  private reportError(err: unknown): void {
    if (this.disposed || isAbortError(err)) return;
    this.o.onError?.(err);
    this.patchState({ error: err instanceof Error ? err.message : String(err) });
  }
}

function gapKey(after: number, before: number): string {
  return `${after}:${before}`;
}

export function isAbortError(err: unknown): boolean {
  return (
    (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')
  );
}
