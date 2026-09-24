import type { NavState, PaneRect, PriceView, TimeView } from '../chart/ChartController';
import type { Viewport } from '../chart/viewport';
import type { ContactInfo, PalmPolicy } from './palmPolicy';

/** The subset of ChartController the navigator drives (lets tests use a fake). */
export interface NavTarget {
  /** Bars currently loaded (older history may be prepended during a gesture). */
  readonly barCount: number;
  viewport(): Viewport | null;
  paneRect(): PaneRect;
  navState(): NavState;
  setTimeView(view: TimeView): void;
  timeViewAnchored(anchorLogical: number, anchorX: number, barSpacing: number): TimeView;
  logicalAt(view: TimeView, x: number): number;
  setPriceView(view: PriceView | null): void;
  restoreNav(state: NavState): void;
  resetView(): void;
  setAutoScale(on: boolean): void;
  showCrosshairAt(x: number, y: number): void;
  hideCrosshair(): void;
}

export interface NavigatorCallbacks {
  onTwoFingerTap?(): void;
  onThreeFingerTap?(): void;
}

export interface NavScheduler {
  now(): number;
  requestFrame(fn: () => void): number;
  cancelFrame(id: number): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export const NAV = {
  tapSlopPx: 8,
  longPressMs: 450,
  tapMaxMs: 300,
  multiTapMaxMs: 350,
  multiTapSlopPx: 14,
  doubleTapMs: 320,
  verticalPanDeadZonePx: 28,
  kineticMinVelocity: 0.3,
  kineticStopVelocity: 0.02,
  kineticTimeConstantMs: 325,
  axisSensitivity: 0.006,
  minBarSpacing: 0.5,
  maxBarSpacing: 80,
  /** An OS-cancelled touch gesture younger than this is rolled back (palm cancel). */
  cancelRollbackMs: 1500,
} as const;

type Region = 'pane' | 'price' | 'time' | 'outside';

interface TouchState {
  readonly id: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  readonly startAt: number;
  readonly region: Region;
  samples: Array<{ x: number; t: number }>;
}

interface PriceBase {
  readonly y: number;
  readonly from: number;
  readonly to: number;
  /** dY/dPrice at the time the base was taken (negative for a normal price scale). */
  readonly slope: number;
}

type Gesture =
  | { kind: 'pending'; id: number; startNav: NavState; startedAt: number }
  | { kind: 'pan'; id: number; startNav: NavState; startedAt: number; view0: TimeView; x0: number; y0: number; priceFree: boolean; priceBase: PriceBase | null }
  // Zoom anchors are stored relative to the LAST bar (logical - (barCount - 1)): prepending older
  // history mid-gesture shifts every absolute index, but not distances from the last bar.
  | { kind: 'pinch'; ids: [number, number]; startNav: NavState; startedAt: number; view0: TimeView; dist0: number; anchorFromEnd: number; priceBase: PriceBase | null }
  | { kind: 'crosshair'; id: number; startNav: NavState; startedAt: number }
  | { kind: 'priceAxis'; id: number; startNav: NavState; startedAt: number; center: number; half: number; y0: number }
  | { kind: 'timeAxis'; id: number; startNav: NavState; startedAt: number; view0: TimeView; anchorFromEnd: number; anchorX: number; x0: number }
  | { kind: 'multi'; startNav: NavState; startedAt: number };

interface TapSession {
  readonly startedAt: number;
  readonly startNav: NavState;
  maxTouches: number;
  moved: boolean;
}

/**
 * Finger navigation implemented on Pointer Events + the chart's public API. The chart never
 * receives touch events itself, which is what makes palm rejection (including rolling back a
 * pan the palm started just before the pen landed) and pen/finger separation deterministic.
 * All positions passed in are relative to the chart container.
 */
export class TouchNavigator {
  private readonly touches = new Map<number, TouchState>();
  private gesture: Gesture | null = null;
  private tapSession: TapSession | null = null;
  private lastTap: { at: number; region: Region } | null = null;
  private longPressTimer: unknown = null;
  private kineticFrame: number | null = null;
  private crosshairVisible = false;
  /** Last time view we requested (the chart applies it on its next frame). */
  private lastTarget: { view: TimeView; at: number } | null = null;
  private readonly chart: NavTarget;
  private readonly palm: PalmPolicy;
  private readonly callbacks: NavigatorCallbacks;
  private readonly s: NavScheduler;

  constructor(chart: NavTarget, palm: PalmPolicy, callbacks: NavigatorCallbacks, scheduler?: NavScheduler) {
    this.chart = chart;
    this.palm = palm;
    this.callbacks = callbacks;
    this.s = scheduler ?? {
      now: () => performance.now(),
      requestFrame: (fn) => requestAnimationFrame(fn),
      cancelFrame: (id) => cancelAnimationFrame(id),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    };
  }

  get activeTouchCount(): number {
    return this.touches.size;
  }

  get gestureKind(): Gesture['kind'] | null {
    return this.gesture?.kind ?? null;
  }

  get isCrosshairVisible(): boolean {
    return this.crosshairVisible;
  }

  // ---- pointer entry points ------------------------------------------------------------------

  down(id: number, contact: ContactInfo, now: number): void {
    this.stopKinetic();
    if (!this.palm.acceptTouch(id, now, contact)) return;
    const region = this.regionOf(contact.x, contact.y);
    const t: TouchState = {
      id,
      x: contact.x,
      y: contact.y,
      startX: contact.x,
      startY: contact.y,
      startAt: now,
      region,
      samples: [{ x: contact.x, t: now }],
    };
    this.touches.set(id, t);

    if (this.touches.size === 1) {
      this.tapSession = { startedAt: now, startNav: this.chart.navState(), maxTouches: 1, moved: false };
    } else if (this.tapSession) {
      this.tapSession.maxTouches = Math.max(this.tapSession.maxTouches, this.touches.size);
    }

    if (this.touches.size === 1) {
      this.beginSingle(t, now);
    } else if (this.touches.size === 2) {
      this.beginPinchOrIgnore(now);
    } else {
      this.clearLongPress();
      this.gesture = { kind: 'multi', startNav: this.gesture?.startNav ?? this.chart.navState(), startedAt: this.gesture?.startedAt ?? now };
    }
  }

  move(id: number, x: number, y: number, now: number): void {
    if (this.palm.isRejected(id)) {
      this.palm.moveRejected(id, x, y);
      return;
    }
    const t = this.touches.get(id);
    if (!t) return;
    t.x = x;
    t.y = y;
    t.samples.push({ x, t: now });
    while (t.samples.length > 2 && now - t.samples[0].t > 120) t.samples.shift();
    if (this.tapSession && Math.hypot(x - t.startX, y - t.startY) > NAV.multiTapSlopPx) this.tapSession.moved = true;

    const g = this.gesture;
    if (!g) return;
    switch (g.kind) {
      case 'pending':
        if (g.id === id && Math.hypot(x - t.startX, y - t.startY) > NAV.tapSlopPx) this.startPan(t, g.startNav, g.startedAt);
        break;
      case 'pan':
        if (g.id === id) this.updatePan(g, t);
        break;
      case 'pinch':
        if (g.ids.includes(id)) this.updatePinch(g);
        break;
      case 'crosshair':
        if (g.id === id) this.chart.showCrosshairAt(x - this.chart.paneRect().left, y - this.chart.paneRect().top);
        break;
      case 'priceAxis':
        if (g.id === id) this.updatePriceAxis(g, t);
        break;
      case 'timeAxis':
        if (g.id === id) this.updateTimeAxis(g, t);
        break;
      case 'multi':
        break;
    }
  }

  up(id: number, now: number): void {
    if (this.palm.isRejected(id)) {
      this.palm.release(id);
      return;
    }
    const t = this.touches.get(id);
    if (!t) return;
    const g = this.gesture;
    this.touches.delete(id);

    if (this.touches.size === 0) {
      this.clearLongPress();
      this.finishTapSession(g, t, now);
      if (g?.kind === 'pan' && g.id === id) this.maybeStartKinetic(g, t, now);
      this.gesture = null;
      return;
    }
    // Some fingers remain.
    if (g?.kind === 'pinch' && g.ids.includes(id)) {
      const remaining = [...this.touches.values()].find((o) => o.region === 'pane');
      if (remaining) {
        remaining.startX = remaining.x;
        remaining.startY = remaining.y;
        // Its movement so far belonged to the pinch: it must not become fling velocity when the
        // second finger lifts a moment later.
        remaining.samples = [{ x: remaining.x, t: now }];
        this.startPan(remaining, g.startNav, g.startedAt);
      } else {
        this.gesture = null;
      }
    } else if (g && 'id' in g && g.id === id) {
      this.gesture = null;
    } else if (g?.kind === 'multi' && this.touches.size === 2) {
      // Back to two fingers after a 3-finger contact: keep ignoring until everything lifts.
    }
  }

  /** The OS cancelled this touch (on iPadOS typically: it was a palm). */
  cancel(id: number, now: number): void {
    if (this.palm.isRejected(id)) {
      this.palm.release(id);
      return;
    }
    if (!this.touches.has(id)) return;
    const g = this.gesture;
    const involved = g !== null && (('id' in g && g.id === id) || (g.kind === 'pinch' && g.ids.includes(id)) || g.kind === 'multi');
    if (involved && g && g.kind !== 'crosshair' && now - g.startedAt <= NAV.cancelRollbackMs) this.chart.restoreNav(g.startNav);
    this.touches.delete(id);
    for (const other of this.touches.values()) this.palm.reject(other.id, other.x, other.y);
    this.touches.clear();
    this.gesture = null;
    this.tapSession = null;
    this.clearLongPress();
  }

  /**
   * The pen touched down: stop all finger navigation. A gesture that began shortly before is
   * almost certainly the writing hand landing first, so its effect is undone.
   */
  freezeForPen(now: number): void {
    this.stopKinetic();
    this.clearLongPress();
    // A crosshair left over from finger/mouse use would clutter the writing surface.
    this.chart.hideCrosshair();
    this.crosshairVisible = false;
    const g = this.gesture;
    if (g && g.kind !== 'crosshair' && this.palm.shouldRollback(g.startedAt, now)) this.chart.restoreNav(g.startNav);
    for (const t of this.touches.values()) this.palm.reject(t.id, t.x, t.y);
    this.touches.clear();
    this.gesture = null;
    this.tapSession = null;
  }

  stopKinetic(): void {
    if (this.kineticFrame !== null) {
      this.s.cancelFrame(this.kineticFrame);
      this.kineticFrame = null;
    }
  }

  hideCrosshair(): void {
    if (this.crosshairVisible) {
      this.chart.hideCrosshair();
      this.crosshairVisible = false;
    }
  }

  reset(): void {
    this.stopKinetic();
    this.clearLongPress();
    this.touches.clear();
    this.gesture = null;
    this.tapSession = null;
  }

  dispose(): void {
    this.reset();
  }

  // ---- gestures ------------------------------------------------------------------------------

  private beginSingle(t: TouchState, now: number): void {
    const startNav = this.currentNav();
    switch (t.region) {
      case 'pane':
        this.gesture = { kind: 'pending', id: t.id, startNav, startedAt: now };
        this.clearLongPress();
        this.longPressTimer = this.s.setTimeout(() => {
          this.longPressTimer = null;
          const g = this.gesture;
          if (g?.kind === 'pending' && g.id === t.id && this.touches.size === 1) {
            this.gesture = { kind: 'crosshair', id: t.id, startNav: g.startNav, startedAt: g.startedAt };
            this.crosshairVisible = true;
            const pane = this.chart.paneRect();
            this.chart.showCrosshairAt(t.x - pane.left, t.y - pane.top);
          }
        }, NAV.longPressMs);
        break;
      case 'price': {
        const price = startNav.price;
        if (!price) return;
        this.gesture = {
          kind: 'priceAxis',
          id: t.id,
          startNav,
          startedAt: now,
          center: (price.from + price.to) / 2,
          half: (price.to - price.from) / 2,
          y0: t.y,
        };
        break;
      }
      case 'time': {
        const pane = this.chart.paneRect();
        const anchorX = pane.width - 1; // zoom around the right edge, like the library's own axis drag
        this.gesture = {
          kind: 'timeAxis',
          id: t.id,
          startNav,
          startedAt: now,
          view0: startNav.time,
          anchorFromEnd: this.chart.logicalAt(startNav.time, anchorX) - (this.chart.barCount - 1),
          anchorX,
          x0: t.x,
        };
        break;
      }
      case 'outside':
        this.gesture = null;
        break;
    }
  }

  private beginPinchOrIgnore(now: number): void {
    this.clearLongPress();
    const [a, b] = [...this.touches.values()];
    if (a.region !== 'pane' || b.region !== 'pane') {
      // A second finger on an axis (or during an axis drag) is ignored.
      if (this.gesture?.kind === 'pending') this.gesture = null;
      return;
    }
    const prev = this.gesture;
    const view0 = this.currentView();
    const pane = this.chart.paneRect();
    const midX = (a.x + b.x) / 2 - pane.left;
    const midY = (a.y + b.y) / 2 - pane.top;
    this.hideCrosshair();
    this.gesture = {
      kind: 'pinch',
      ids: [a.id, b.id],
      startNav: prev?.startNav ?? this.chart.navState(),
      startedAt: prev?.startedAt ?? now,
      view0,
      dist0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      anchorFromEnd: this.chart.logicalAt(view0, midX) - (this.chart.barCount - 1),
      priceBase: this.chart.navState().price?.auto === false ? this.priceBaseAt(midY) : null,
    };
  }

  private startPan(t: TouchState, startNav: NavState, startedAt: number): void {
    this.clearLongPress();
    this.hideCrosshair();
    const price = this.chart.navState().price;
    const priceFree = price !== null && !price.auto;
    this.gesture = {
      kind: 'pan',
      id: t.id,
      startNav,
      startedAt,
      view0: this.currentView(),
      x0: t.x,
      y0: t.y,
      priceFree,
      priceBase: priceFree ? this.priceBaseAt(t.y - this.chart.paneRect().top) : null,
    };
    this.updatePan(this.gesture, t);
  }

  private updatePan(g: Extract<Gesture, { kind: 'pan' }>, t: TouchState): void {
    const dx = t.x - g.x0;
    const dy = t.y - g.y0;
    this.applyTimeView({ barSpacing: g.view0.barSpacing, rightOffset: g.view0.rightOffset - dx / g.view0.barSpacing });
    if (!g.priceFree && Math.abs(dy) > NAV.verticalPanDeadZonePx && Math.abs(dy) > Math.abs(dx) * 0.5) {
      // Deliberate vertical drag: switch to free price panning (disables auto-scale),
      // starting from the current position so nothing jumps.
      g.priceFree = true;
      g.priceBase = this.priceBaseAt(t.y - this.chart.paneRect().top);
    }
    if (g.priceFree && g.priceBase) this.applyPriceShift(g.priceBase, t.y - this.chart.paneRect().top);
  }

  private updatePinch(g: Extract<Gesture, { kind: 'pinch' }>): void {
    const a = this.touches.get(g.ids[0]);
    const b = this.touches.get(g.ids[1]);
    if (!a || !b) return;
    const pane = this.chart.paneRect();
    const dist = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    const barSpacing = clamp(g.view0.barSpacing * (dist / g.dist0), NAV.minBarSpacing, NAV.maxBarSpacing);
    const midX = (a.x + b.x) / 2 - pane.left;
    this.applyTimeView(this.chart.timeViewAnchored(this.chart.barCount - 1 + g.anchorFromEnd, midX, barSpacing));
    if (g.priceBase) this.applyPriceShift(g.priceBase, (a.y + b.y) / 2 - pane.top);
  }

  private updatePriceAxis(g: Extract<Gesture, { kind: 'priceAxis' }>, t: TouchState): void {
    // Drag down = compress (show a wider price range), drag up = expand.
    const factor = Math.exp((t.y - g.y0) * NAV.axisSensitivity);
    const half = g.half * factor;
    this.chart.setPriceView({ from: g.center - half, to: g.center + half, auto: false });
  }

  private updateTimeAxis(g: Extract<Gesture, { kind: 'timeAxis' }>, t: TouchState): void {
    // Drag right = zoom in (wider bars), drag left = zoom out.
    const barSpacing = clamp(g.view0.barSpacing * Math.exp((t.x - g.x0) * NAV.axisSensitivity), NAV.minBarSpacing, NAV.maxBarSpacing);
    this.applyTimeView(this.chart.timeViewAnchored(this.chart.barCount - 1 + g.anchorFromEnd, g.anchorX, barSpacing));
  }

  private finishTapSession(g: Gesture | null, t: TouchState, now: number): void {
    const session = this.tapSession;
    this.tapSession = null;
    if (!session || session.moved) return;
    const duration = now - session.startedAt;
    if (session.maxTouches >= 2) {
      if (duration > NAV.multiTapMaxMs) return;
      // Undo any tiny zoom the fingers caused, then run the command.
      this.chart.restoreNav(session.startNav);
      if (session.maxTouches === 2) this.callbacks.onTwoFingerTap?.();
      else if (session.maxTouches === 3) this.callbacks.onThreeFingerTap?.();
      return;
    }
    // Axis drags start immediately (no pending phase), so a still axis touch also counts as a tap.
    const tapLike = g?.kind === 'pending' || g?.kind === 'priceAxis' || g?.kind === 'timeAxis';
    if (!tapLike || duration > NAV.tapMaxMs) return;
    const pane = this.chart.paneRect();
    if (t.region === 'pane') {
      if (this.crosshairVisible) {
        this.hideCrosshair();
      } else {
        this.crosshairVisible = true;
        this.chart.showCrosshairAt(t.x - pane.left, t.y - pane.top);
      }
      return;
    }
    const isDouble = this.lastTap !== null && this.lastTap.region === t.region && now - this.lastTap.at <= NAV.doubleTapMs;
    this.lastTap = isDouble ? null : { at: now, region: t.region };
    if (!isDouble) return;
    if (t.region === 'price') this.chart.setAutoScale(true);
    else if (t.region === 'time') this.chart.resetView();
  }

  // ---- kinetic scrolling ---------------------------------------------------------------------

  private maybeStartKinetic(g: Extract<Gesture, { kind: 'pan' }>, t: TouchState, now: number): void {
    const recent = t.samples.filter((s) => now - s.t <= 100);
    if (recent.length < 2) return;
    const first = recent[0];
    const last = recent[recent.length - 1];
    const dt = last.t - first.t;
    if (dt <= 0) return;
    let v = (last.x - first.x) / dt; // px per ms, positive = finger moving right
    if (Math.abs(v) < NAV.kineticMinVelocity) return;
    const barSpacing = g.view0.barSpacing;
    let rightOffset = g.view0.rightOffset - (t.x - g.x0) / barSpacing;
    let prev = now;
    const step = (): void => {
      const time = this.s.now();
      const elapsed = Math.max(0, time - prev);
      prev = time;
      rightOffset -= (v * elapsed) / barSpacing;
      this.applyTimeView({ barSpacing, rightOffset });
      v *= Math.exp(-elapsed / NAV.kineticTimeConstantMs);
      this.kineticFrame = Math.abs(v) < NAV.kineticStopVelocity ? null : this.s.requestFrame(step);
    };
    this.kineticFrame = this.s.requestFrame(step);
  }

  // ---- helpers -------------------------------------------------------------------------------

  private applyTimeView(view: TimeView): void {
    this.lastTarget = { view, at: this.s.now() };
    this.chart.setTimeView(view);
  }

  /** The view the chart is at or is about to apply (our last request wins for ~2 frames). */
  private currentView(): TimeView {
    if (this.lastTarget && this.s.now() - this.lastTarget.at < 100) return this.lastTarget.view;
    return this.chart.navState().time;
  }

  private currentNav(): NavState {
    const nav = this.chart.navState();
    return { time: this.currentView(), price: nav.price };
  }

  private priceBaseAt(paneY: number): PriceBase | null {
    const price = this.chart.navState().price;
    const v = this.chart.viewport();
    if (!price || !v) return null;
    const slope = v.priceToY(1) - v.priceToY(0);
    if (!Number.isFinite(slope) || slope === 0) return null;
    return { y: paneY, from: price.from, to: price.to, slope };
  }

  private applyPriceShift(base: PriceBase, paneY: number): void {
    const shift = -(paneY - base.y) / base.slope;
    this.chart.setPriceView({ from: base.from + shift, to: base.to + shift, auto: false });
  }

  private regionOf(x: number, y: number): Region {
    const pane = this.chart.paneRect();
    const inX = x >= pane.left && x <= pane.left + pane.width;
    const inY = y >= pane.top && y <= pane.top + pane.height;
    if (inX && inY) return 'pane';
    if (inY && x > pane.left + pane.width) return 'price';
    if (inX && y > pane.top + pane.height) return 'time';
    return 'outside';
  }

  private clearLongPress(): void {
    if (this.longPressTimer !== null) {
      this.s.clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
