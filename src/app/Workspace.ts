import { ChartController } from '../chart/ChartController';
import { DrawingEngine, type EngineHooks } from '../drawing/DrawingEngine';
import { MemoryDocumentSource, type DocumentSource } from '../drawing/documents';
import type { ChartKey } from '../drawing/model';
import { LiveLayer } from '../drawing/render/LiveLayer';
import { InputRouter } from '../input/InputRouter';
import { PalmPolicy } from '../input/palmPolicy';
import { TouchNavigator } from '../input/TouchNavigator';
import { CandleFeed, type FeedState } from '../market/candleFeed';
import { CandleSeries } from '../market/candleSeries';
import type { MarketRegistry } from '../market/registry';
import { clockFor, getTimeframe } from '../market/timeframes';
import type { BarClock, MarketDataProvider, SymbolInfo, Timeframe, TimeframeId } from '../market/types';

export interface MarketSelection {
  /** Market id in the registry ('binance', 'us'). */
  readonly market: string;
  readonly symbol: string;
  readonly timeframe: TimeframeId;
}

export interface WorkspaceStatus {
  readonly market: MarketSelection;
  /** Details of the charted symbol once known (name, time zone, data delay). */
  readonly symbol: SymbolInfo | null;
  readonly feed: FeedState;
}

export interface WorkspaceOptions {
  readonly host: HTMLElement;
  readonly markets: MarketRegistry;
  readonly market: MarketSelection;
  readonly documents?: DocumentSource;
  readonly engineHooks?: EngineHooks;
}

const INITIAL_FEED: FeedState = { live: 'idle', initialLoaded: false, loadingOlder: false, historyExhausted: false, error: null };
/** Retry delay when a chart's symbol details or trading sessions could not be loaded. */
const PREPARE_RETRY_MS = 10_000;

/**
 * Composition root for one chart surface. Framework-agnostic: React only renders controls
 * around it and subscribes to its status.
 */
export class Workspace {
  readonly chart: ChartController;
  readonly live: LiveLayer;
  readonly engine: DrawingEngine;
  readonly palm = new PalmPolicy();
  readonly navigator: TouchNavigator;
  readonly router: InputRouter;
  private readonly markets: MarketRegistry;
  private provider: MarketDataProvider;
  private readonly documents: DocumentSource;
  private feed: CandleFeed | null = null;
  private preparing: AbortController | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private status: WorkspaceStatus;
  private readonly listeners = new Set<() => void>();
  private disposed = false;

  constructor(options: WorkspaceOptions) {
    this.markets = options.markets;
    this.provider = this.providerFor(options.market.market);
    this.documents = options.documents ?? new MemoryDocumentSource();
    const tf = getTimeframe(options.market.timeframe);
    this.status = { market: options.market, symbol: null, feed: INITIAL_FEED };

    this.chart = new ChartController(options.host, {
      clock: clockFor(tf),
      symbol: placeholderInfo(options.market.symbol),
      watermark: watermarkText(options.market),
      onNeedOlder: () => void this.feed?.loadOlder(),
    });
    this.live = new LiveLayer(options.host);
    this.engine = new DrawingEngine(this.chart, this.live, options.engineHooks);
    this.navigator = new TouchNavigator(this.chart, this.palm, {
      onTwoFingerTap: () => this.engine.undo(),
      onThreeFingerTap: () => this.engine.redo(),
    });
    this.router = new InputRouter({ host: options.host, chart: this.chart, engine: this.engine, navigator: this.navigator, palm: this.palm });
    this.setMarket(options.market, true);
  }

  getStatus = (): WorkspaceStatus => this.status;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get market(): MarketSelection {
    return this.status.market;
  }

  get chartKey(): ChartKey {
    return { provider: this.provider.id, symbol: this.status.market.symbol, timeframe: this.status.market.timeframe };
  }

  setMarket(market: MarketSelection, force = false): void {
    if (this.disposed) return;
    const cur = this.status.market;
    const same = market.market === cur.market && market.symbol === cur.symbol && market.timeframe === cur.timeframe;
    if (same && !force) return;
    this.stopFeed();
    this.navigator.reset();
    this.navigator.hideCrosshair();
    this.provider = this.providerFor(market.market);
    const tf = getTimeframe(market.timeframe);
    this.setStatus({ market, symbol: null, feed: INITIAL_FEED });
    // Clear the old bars immediately so drawings of the previous chart never render on the new one.
    const empty = new CandleSeries(clockFor(tf));
    this.chart.resetData(empty, empty.clock, placeholderInfo(market.symbol), watermarkText(market));
    this.engine.setDocument(this.documents.open(this.chartKey));
    this.prepare(market, tf);
  }

  /** Loads one more page of older history (the chart also triggers this near the left edge). */
  loadOlderHistory(): Promise<void> {
    return this.feed?.loadOlder() ?? Promise.resolve();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopFeed();
    this.router.dispose();
    this.navigator.dispose();
    this.engine.dispose();
    this.live.dispose();
    this.chart.dispose();
    this.listeners.clear();
  }

  /** Loads the symbol's details and trading sessions, then starts the feed (retried on failure). */
  private prepare(market: MarketSelection, tf: Timeframe): void {
    const abort = new AbortController();
    this.preparing = abort;
    this.provider.prepare(market.symbol, market.timeframe, abort.signal).then(
      ({ info, clock }) => {
        if (abort.signal.aborted || this.disposed) return;
        this.preparing = null;
        this.startFeed(market, tf, info, clock);
      },
      (err: unknown) => {
        if (abort.signal.aborted || this.disposed) return;
        this.preparing = null;
        const error = err instanceof Error ? err.message : String(err);
        this.setStatus({ market, symbol: null, feed: { ...INITIAL_FEED, error } });
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.prepare(market, tf);
        }, PREPARE_RETRY_MS);
      },
    );
  }

  private startFeed(market: MarketSelection, tf: Timeframe, info: SymbolInfo, clock: BarClock): void {
    let initialized = false;
    const feed = new CandleFeed(
      this.provider,
      market.symbol,
      tf,
      {
        onChange: (change, series) => {
          if (this.feed !== feed) return;
          if (!initialized) {
            if (!feed.currentState.initialLoaded) return;
            initialized = true;
            this.chart.resetData(series, clock, info, watermarkText(market));
            return;
          }
          this.chart.applyChange(change, series);
        },
        onState: (state) => {
          if (this.feed === feed) this.setStatus({ market, symbol: info, feed: state });
        },
      },
      { clock },
    );
    this.feed = feed;
    this.setStatus({ market, symbol: info, feed: INITIAL_FEED });
    this.chart.resetData(feed.series, clock, info, watermarkText(market));
    feed.start();
  }

  private stopFeed(): void {
    this.preparing?.abort();
    this.preparing = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.feed?.dispose();
    this.feed = null;
  }

  /** The market's provider; an unknown market falls back to the first one. */
  private providerFor(market: string): MarketDataProvider {
    const provider = this.markets.provider(market) ?? this.markets.markets[0]?.provider;
    if (!provider) throw new Error('no market data provider');
    return provider;
  }

  private setStatus(status: WorkspaceStatus): void {
    this.status = status;
    for (const l of this.listeners) l();
  }
}

/** Shown until the provider has told us the symbol's details. */
function placeholderInfo(symbol: string): SymbolInfo {
  return { symbol, base: symbol, quote: '', pricePrecision: 2, minMove: 0.01 };
}

function watermarkText(m: MarketSelection): string {
  return `${m.symbol} · ${getTimeframe(m.timeframe).label}`;
}
