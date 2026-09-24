import {
  CandlestickSeries,
  ColorType,
  createChart,
  createTextWatermark,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type ISeriesPrimitive,
  type ITextWatermarkPluginApi,
  type Logical,
  type LogicalRange,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { CandleSeries, SeriesChange } from '../market/candleSeries';
import type { Candle, SymbolInfo } from '../market/types';
import { THEME } from './theme';
import { TimeIndex } from './timeIndex';
import { LinearPriceMapping, Viewport } from './viewport';

export interface TimeView {
  /** CSS px between bar centres. */
  readonly barSpacing: number;
  /** Lightweight Charts right offset: bars between the last bar and the right edge. */
  readonly rightOffset: number;
}

export interface PriceView {
  readonly from: number;
  readonly to: number;
  readonly auto: boolean;
}

export interface NavState {
  readonly time: TimeView;
  readonly price: PriceView | null;
}

export interface PaneRect {
  /** Offset of the pane inside the chart container (CSS px). */
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface ChartControllerOptions {
  readonly intervalMs: number;
  readonly symbol: SymbolInfo;
  readonly watermark: string;
  /** Called when the visible range approaches the oldest loaded bar. */
  readonly onNeedOlder?: () => void;
}

const LOAD_OLDER_THRESHOLD_BARS = 60;

/**
 * Owns the Lightweight Charts instance. Responsibilities:
 * - keeps chart data in lockstep with a CandleSeries (incremental or full sync), including
 *   deferring updates while the pen is down so the surface never moves under the stylus;
 * - maintains the TimeIndex that corresponds exactly to the bars the chart displays;
 * - exposes an immutable Viewport snapshot and view-change notifications for the drawing layers;
 * - exposes absolute navigation setters used by the custom touch navigator.
 * Touch input never reaches the chart (see InputRouter); mouse input stays native.
 */
export class ChartController {
  readonly chart: IChartApi;
  readonly candles: ISeriesApi<'Candlestick'>;
  readonly volume: ISeriesApi<'Histogram'>;
  private readonly container: HTMLElement;
  private intervalMs: number;
  private timeIndex = TimeIndex.EMPTY;
  private timeVersion = 0;
  private displayedTimes: number[] = [];
  private deferDepth = 0;
  private pendingTails: Candle[] = [];
  private pendingFull = false;
  private source: CandleSeries | null = null;
  private readonly viewListeners = new Set<() => void>();
  private viewNotifyQueued = false;
  private readonly watermark: ITextWatermarkPluginApi<Time>;
  private readonly onNeedOlder?: () => void;
  private pendingJump = false;
  private crosshairSuppressed = false;
  /** A requested view change has not been painted yet (the library applies it next frame). */
  private settling = false;
  private readonly settleWaiters: Array<() => void> = [];
  private disposed = false;

  constructor(container: HTMLElement, options: ChartControllerOptions) {
    this.container = container;
    this.intervalMs = options.intervalMs;
    this.onNeedOlder = options.onNeedOlder;
    this.chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: THEME.background },
        textColor: THEME.text,
        fontFamily: THEME.fontFamily,
        fontSize: 11,
      },
      grid: {
        vertLines: { color: THEME.grid },
        horzLines: { color: THEME.grid },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: THEME.crosshair, style: LineStyle.Dashed, labelBackgroundColor: '#2a3140' },
        horzLine: { color: THEME.crosshair, style: LineStyle.Dashed, labelBackgroundColor: '#2a3140' },
      },
      rightPriceScale: {
        borderColor: THEME.border,
        scaleMargins: { top: 0.08, bottom: 0.2 },
      },
      timeScale: {
        borderColor: THEME.border,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 12,
        barSpacing: 8,
        minBarSpacing: 0.5,
        // Explicit: the default (half the chart width) is 0 before the first layout, which
        // clamps any bar spacing applied before then to the minimum.
        maxBarSpacing: 80,
      },
      // Touch never reaches the chart; these only matter for mouse/trackpad.
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: false, vertTouchDrag: false },
      handleScale: {
        mouseWheel: true,
        pinch: false,
        axisPressedMouseMove: { time: true, price: true },
        axisDoubleClickReset: { time: true, price: true },
      },
      kineticScroll: { mouse: false, touch: false },
    });

    // Volume first so candles (and the drawings attached to them) paint on top.
    this.volume = this.chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      lastValueVisible: false,
      priceLineVisible: false,
    });
    this.volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    this.candles = this.chart.addSeries(CandlestickSeries, {
      upColor: THEME.up,
      downColor: THEME.down,
      borderVisible: false,
      wickUpColor: THEME.up,
      wickDownColor: THEME.down,
      priceFormat: { type: 'price', precision: options.symbol.pricePrecision, minMove: options.symbol.minMove },
    });
    this.candles.attachPrimitive(new ViewSyncPrimitive(() => this.queueViewNotify()));

    this.watermark = createTextWatermark(this.chart.panes()[0], {
      horzAlign: 'center',
      vertAlign: 'center',
      lines: [{ text: options.watermark, color: THEME.watermark, fontSize: 56, fontStyle: '600' }],
    });

    this.chart.timeScale().subscribeVisibleLogicalRangeChange(this.onVisibleRange);
    this.chart.timeScale().subscribeSizeChange(this.onSizeChange);
  }

  // ---- data -------------------------------------------------------------------------------

  /** Replaces all data (symbol/timeframe switch). Clears any deferred updates. */
  resetData(series: CandleSeries, intervalMs: number, symbol: SymbolInfo, watermark: string): void {
    this.intervalMs = intervalMs;
    this.source = series;
    this.pendingTails = [];
    this.pendingFull = false;
    this.candles.applyOptions({
      priceFormat: { type: 'price', precision: symbol.pricePrecision, minMove: symbol.minMove },
    });
    this.watermark.applyOptions({ lines: [{ text: watermark, color: THEME.watermark, fontSize: 56, fontStyle: '600' }] });
    this.candles.priceScale().setAutoScale(true);
    this.fullSync(series);
    this.jumpToLatest();
  }

  /**
   * Shows the latest bars immediately. (`scrollToRealTime()` animates from the previous
   * position, which briefly exposes the oldest bars and would trigger history pagination.)
   */
  private jumpToLatest(): void {
    const ts = this.chart.timeScale();
    if (this.chart.paneSize(0).width <= 0) {
      // Not laid out yet: apply once the chart receives its first real size.
      this.pendingJump = true;
      return;
    }
    this.pendingJump = false;
    ts.applyOptions({ barSpacing: 8 });
    ts.scrollToPosition(12, false);
  }

  private readonly onSizeChange = (width: number): void => {
    if (width > 0 && this.pendingJump) this.jumpToLatest();
    this.queueViewNotify();
  };

  applyChange(change: SeriesChange, series: CandleSeries): void {
    if (change.kind === 'none' || this.disposed) return;
    this.source = series;
    if (this.deferDepth > 0) {
      if (change.kind === 'tail') this.pendingTails.push(...change.candles);
      else this.pendingFull = true;
      return;
    }
    if (change.kind === 'tail') this.applyTail(change.candles);
    else this.fullSync(series);
  }

  /** While deferred (pen down), market-data updates are queued so the chart does not move. */
  beginDeferUpdates(): void {
    this.deferDepth++;
  }

  endDeferUpdates(): void {
    if (this.deferDepth === 0) return;
    this.deferDepth--;
    if (this.deferDepth > 0 || this.disposed) return;
    if (this.pendingFull && this.source) {
      this.fullSync(this.source);
    } else if (this.pendingTails.length > 0) {
      this.applyTail(this.pendingTails);
    }
    this.pendingTails = [];
    this.pendingFull = false;
  }

  get isDeferring(): boolean {
    return this.deferDepth > 0;
  }

  private fullSync(series: CandleSeries): void {
    const bars = series.all();
    this.candles.setData(bars.map(toCandleData));
    this.volume.setData(bars.map(toVolumeData));
    this.displayedTimes = bars.map((b) => b.time);
    this.rebuildTimeIndex();
    this.pendingTails = [];
    this.pendingFull = false;
  }

  private applyTail(candles: readonly Candle[]): void {
    let appended = false;
    for (const c of candles) {
      const last = this.displayedTimes[this.displayedTimes.length - 1];
      if (last !== undefined && c.time < last) {
        // Out of order relative to what is displayed: fall back to a full re-sync.
        if (this.source) this.fullSync(this.source);
        return;
      }
      this.candles.update(toCandleData(c));
      this.volume.update(toVolumeData(c));
      if (last === undefined || c.time > last) {
        this.displayedTimes.push(c.time);
        appended = true;
      }
    }
    if (appended) this.rebuildTimeIndex();
  }

  private rebuildTimeIndex(): void {
    this.timeIndex = TimeIndex.from(this.displayedTimes, this.intervalMs, ++this.timeVersion);
  }

  get currentTimeIndex(): TimeIndex {
    return this.timeIndex;
  }

  get barCount(): number {
    return this.displayedTimes.length;
  }

  // ---- geometry ---------------------------------------------------------------------------

  /** Pane rectangle relative to the chart container. */
  paneRect(): PaneRect {
    const size = this.chart.paneSize(0);
    const left = this.chart.priceScale('left').width();
    return { left, top: 0, width: size.width, height: size.height };
  }

  /**
   * Immutable transform snapshot, or null while the chart has no data/size.
   * Horizontal: x = x(0) + logical * barSpacing (exact for Lightweight Charts' linear time scale;
   * the library itself only converts integer logicals).
   * Vertical: linear mapping sampled from the candle series' price scale.
   */
  viewport(): Viewport | null {
    if (this.timeIndex.isEmpty || this.disposed) return null;
    const size = this.chart.paneSize(0);
    if (size.width <= 0 || size.height <= 0) return null;
    const ts = this.chart.timeScale();
    const x0 = ts.logicalToCoordinate(0 as Logical);
    const barSpacing = ts.options().barSpacing;
    if (x0 === null || !(barSpacing > 0)) return null;
    const range = this.candles.priceScale().getVisibleRange();
    const p1 = range ? range.from : 0;
    const p2 = range && range.to !== range.from ? range.to : p1 + 1;
    const y1 = this.candles.priceToCoordinate(p1);
    const y2 = this.candles.priceToCoordinate(p2);
    if (y1 === null || y2 === null) return null;
    const price = LinearPriceMapping.fromSamples(p1, y1, p2, y2);
    if (!price) return null;
    return new Viewport({ x0, barSpacing, width: size.width, height: size.height, timeIndex: this.timeIndex, price });
  }

  /** Subscribes to "the chart repainted with a new transform" (coalesced per frame). */
  onViewChange(listener: () => void): () => void {
    this.viewListeners.add(listener);
    return () => this.viewListeners.delete(listener);
  }

  private queueViewNotify(): void {
    if (this.viewNotifyQueued) return;
    this.viewNotifyQueued = true;
    // Microtask: runs after Lightweight Charts finishes painting this frame, before the
    // browser presents it, so overlay layers repaint in the same frame as the chart.
    queueMicrotask(() => {
      this.viewNotifyQueued = false;
      if (this.disposed) return;
      // Any paint after a requested view change has applied it.
      if (this.settling) this.settle();
      for (const l of this.viewListeners) l();
    });
  }

  /**
   * True between a navigation request (setTimeView/setPriceView) and the paint that applies it.
   * Screen -> chart conversions made in that window would use the outgoing view.
   */
  get isSettling(): boolean {
    return this.settling;
  }

  /** Runs `cb` once pending view changes are painted (immediately if none are pending). */
  whenSettled(cb: () => void): void {
    if (!this.settling) {
      cb();
      return;
    }
    this.settleWaiters.push(cb);
    // Fallback: a request equal to the current view may not trigger a repaint.
    requestAnimationFrame(() => requestAnimationFrame(() => this.settle()));
  }

  private markSettling(): void {
    this.settling = true;
  }

  private settle(): void {
    this.settling = false;
    const waiters = this.settleWaiters.splice(0);
    for (const cb of waiters) cb();
  }

  // ---- navigation (absolute setters; applied by the chart on its next frame) --------------

  navState(): NavState {
    const ts = this.chart.timeScale();
    const time = { barSpacing: ts.options().barSpacing, rightOffset: ts.scrollPosition() };
    const ps = this.candles.priceScale();
    const r = ps.getVisibleRange();
    const price = r ? { from: r.from, to: r.to, auto: ps.options().autoScale } : null;
    return { time, price };
  }

  setTimeView(view: TimeView): void {
    const n = this.displayedTimes.length;
    const width = this.chart.paneSize(0).width;
    if (n === 0 || width <= 0 || !(view.barSpacing > 0)) return;
    const to = n - 1 + view.rightOffset;
    const from = to + 1 - width / view.barSpacing;
    this.markSettling();
    this.chart.timeScale().setVisibleLogicalRange({ from, to } as LogicalRange);
  }

  /**
   * Time view that keeps `anchorLogical` under pane x = `anchorX` at the given bar spacing.
   * Mirrors the library's coordinate formula x(L) = width - (to - L + 0.5) * barSpacing - 1.
   */
  timeViewAnchored(anchorLogical: number, anchorX: number, barSpacing: number): TimeView {
    const width = this.chart.paneSize(0).width;
    const to = anchorLogical - 0.5 + (width - 1 - anchorX) / barSpacing;
    return { barSpacing, rightOffset: to - (this.displayedTimes.length - 1) };
  }

  /** Fractional logical index at pane x under the given (possibly not yet applied) time view. */
  logicalAt(view: TimeView, x: number): number {
    const width = this.chart.paneSize(0).width;
    const to = this.displayedTimes.length - 1 + view.rightOffset;
    return to + 0.5 - (width - 1 - x) / view.barSpacing;
  }

  setPriceView(view: PriceView | null): void {
    if (!view) return;
    const ps = this.candles.priceScale();
    this.markSettling();
    if (view.auto) ps.setAutoScale(true);
    else if (view.to > view.from) ps.setVisibleRange({ from: view.from, to: view.to });
  }

  restoreNav(state: NavState): void {
    this.setTimeView(state.time);
    this.setPriceView(state.price);
  }

  resetView(): void {
    this.candles.priceScale().setAutoScale(true);
    this.jumpToLatest();
  }

  get autoScale(): boolean {
    return this.candles.priceScale().options().autoScale;
  }

  setAutoScale(on: boolean): void {
    this.candles.priceScale().setAutoScale(on);
  }

  // ---- crosshair (touch has no hover, so the navigator drives it explicitly) --------------

  /**
   * Hides the crosshair while the pen is in use (a writing surface should not show a crosshair
   * chasing the nib) without interfering with the chart's own mouse hover state.
   */
  setCrosshairSuppressed(suppressed: boolean): void {
    if (suppressed === this.crosshairSuppressed) return;
    this.crosshairSuppressed = suppressed;
    this.chart.applyOptions({ crosshair: { mode: suppressed ? CrosshairMode.Hidden : CrosshairMode.Normal } });
  }

  showCrosshairAt(x: number, y: number): void {
    this.setCrosshairSuppressed(false);
    const v = this.viewport();
    if (!v) return;
    const n = this.displayedTimes.length;
    const idx = Math.max(0, Math.min(n - 1, Math.round(v.xToLogical(x))));
    const time = (this.displayedTimes[idx] / 1000) as UTCTimestamp;
    this.chart.setCrosshairPosition(v.yToPrice(y), time, this.candles);
  }

  hideCrosshair(): void {
    this.chart.clearCrosshairPosition();
  }

  // ---- misc -------------------------------------------------------------------------------

  /** Chart canvas (panes + axes + drawings), without crosshair or other transient layers. */
  takeScreenshot(): HTMLCanvasElement {
    return this.chart.takeScreenshot(false, false);
  }

  get element(): HTMLElement {
    return this.container;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.viewListeners.clear();
    this.chart.timeScale().unsubscribeVisibleLogicalRangeChange(this.onVisibleRange);
    this.chart.timeScale().unsubscribeSizeChange(this.onSizeChange);
    this.chart.remove();
  }

  private readonly onVisibleRange = (range: LogicalRange | null): void => {
    if (range && this.displayedTimes.length > 0 && range.from < LOAD_OLDER_THRESHOLD_BARS) this.onNeedOlder?.();
  };
}

/** Primitive without visuals: tells us whenever the chart recomputes views for a repaint. */
class ViewSyncPrimitive implements ISeriesPrimitive<Time> {
  private readonly notify: () => void;

  constructor(notify: () => void) {
    this.notify = notify;
  }

  updateAllViews(): void {
    this.notify();
  }
}

function toCandleData(c: Candle): CandlestickData<Time> {
  return { time: (c.time / 1000) as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close };
}

function toVolumeData(c: Candle): HistogramData<Time> {
  return {
    time: (c.time / 1000) as UTCTimestamp,
    value: c.volume,
    color: c.close >= c.open ? THEME.upVolume : THEME.downVolume,
  };
}
