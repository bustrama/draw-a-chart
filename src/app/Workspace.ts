import { ChartController } from '../chart/ChartController';
import { DrawingEngine, type EngineHooks } from '../drawing/DrawingEngine';
import { MemoryDocumentSource, type DocumentSource } from '../drawing/documents';
import type { ChartKey } from '../drawing/model';
import { LiveLayer } from '../drawing/render/LiveLayer';
import { InputRouter } from '../input/InputRouter';
import { PalmPolicy } from '../input/palmPolicy';
import { TouchNavigator } from '../input/TouchNavigator';
import { CandleFeed, type FeedState } from '../market/candleFeed';
import { getTimeframe } from '../market/timeframes';
import type { MarketDataProvider, SymbolInfo, TimeframeId } from '../market/types';

export interface MarketSelection {
  readonly symbol: string;
  readonly timeframe: TimeframeId;
}

export interface WorkspaceStatus {
  readonly market: MarketSelection;
  readonly feed: FeedState;
}

export interface WorkspaceOptions {
  readonly host: HTMLElement;
  readonly provider: MarketDataProvider;
  readonly market: MarketSelection;
  readonly documents?: DocumentSource;
  readonly engineHooks?: EngineHooks;
}

const INITIAL_FEED: FeedState = { live: 'idle', initialLoaded: false, loadingOlder: false, historyExhausted: false, error: null };

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
  private readonly provider: MarketDataProvider;
  private readonly documents: DocumentSource;
  private feed: CandleFeed | null = null;
  private status: WorkspaceStatus;
  private readonly listeners = new Set<() => void>();
  private disposed = false;

  constructor(options: WorkspaceOptions) {
    this.provider = options.provider;
    this.documents = options.documents ?? new MemoryDocumentSource();
    const symbol = this.symbolInfo(options.market.symbol);
    const tf = getTimeframe(options.market.timeframe);
    this.status = { market: options.market, feed: INITIAL_FEED };

    this.chart = new ChartController(options.host, {
      intervalMs: tf.ms,
      symbol,
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
    const same = market.symbol === this.status.market.symbol && market.timeframe === this.status.market.timeframe;
    if (same && !force) return;
    this.feed?.dispose();
    this.navigator.reset();
    this.navigator.hideCrosshair();
    const symbol = this.symbolInfo(market.symbol);
    const tf = getTimeframe(market.timeframe);
    this.setStatus({ market, feed: INITIAL_FEED });

    let initialized = false;
    const feed = new CandleFeed(this.provider, market.symbol, tf, {
      onChange: (change, series) => {
        if (this.feed !== feed) return;
        if (!initialized) {
          if (!feed.currentState.initialLoaded) return;
          initialized = true;
          this.chart.resetData(series, tf.ms, symbol, watermarkText(market));
          return;
        }
        this.chart.applyChange(change, series);
      },
      onState: (state) => {
        if (this.feed === feed) this.setStatus({ market, feed: state });
      },
    });
    this.feed = feed;
    // Clear the old bars immediately so drawings of the previous chart never render on the new one.
    this.chart.resetData(feed.series, tf.ms, symbol, watermarkText(market));
    this.engine.setDocument(this.documents.open(this.chartKey));
    feed.start();
  }

  /** Loads one more page of older history (the chart also triggers this near the left edge). */
  loadOlderHistory(): Promise<void> {
    return this.feed?.loadOlder() ?? Promise.resolve();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.feed?.dispose();
    this.router.dispose();
    this.navigator.dispose();
    this.engine.dispose();
    this.live.dispose();
    this.chart.dispose();
    this.listeners.clear();
  }

  private symbolInfo(symbol: string): SymbolInfo {
    const info = this.provider.symbols().find((s) => s.symbol === symbol);
    return info ?? { symbol, base: symbol, quote: '', pricePrecision: 2, minMove: 0.01 };
  }

  private setStatus(status: WorkspaceStatus): void {
    this.status = status;
    for (const l of this.listeners) l();
  }
}

function watermarkText(m: MarketSelection): string {
  return `${m.symbol} · ${getTimeframe(m.timeframe).label}`;
}
