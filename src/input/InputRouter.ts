import type { ChartController, PaneRect } from '../chart/ChartController';
import type { DrawingEngine, StrokeInput } from '../drawing/DrawingEngine';
import type { PalmPolicy } from './palmPolicy';
import type { TouchNavigator } from './TouchNavigator';

export interface InputRouterOptions {
  /** Element containing the chart; all listeners are capture-phase listeners on it. */
  readonly host: HTMLElement;
  readonly chart: ChartController;
  readonly engine: DrawingEngine;
  readonly navigator: TouchNavigator;
  readonly palm: PalmPolicy;
}

interface ActiveStroke {
  readonly pointerId: number;
  readonly type: 'pen' | 'mouse';
  readonly pane: PaneRect;
}

/** Pen eraser end (buttons bit 32 / button 5) or barrel button (bit 2 / button 2). */
export function isEraserInput(e: PointerEvent): boolean {
  return (e.buttons & 32) !== 0 || e.button === 5 || (e.buttons & 2) !== 0 || e.button === 2;
}

/**
 * The single gatekeeper between the DOM and the chart/drawing engine (capture phase, so it runs
 * before any Lightweight Charts listener):
 *
 * - pointerType 'pen'   -> drawing engine. Never reaches the chart. Its compatibility mouse
 *                          events and click/contextmenu are suppressed.
 * - pointerType 'touch' -> TouchNavigator (custom pan / pinch / crosshair / axis gestures with
 *                          palm rejection). Never draws.
 * - pointerType 'mouse' -> native chart navigation, unless mouse-draw mode is on.
 * - Touch Events        -> always blocked. The chart library consumes Touch Events (not Pointer
 *                          Events) and tracks `event.touches`, so a partially filtered touch
 *                          stream would leave it in a stuck state; blocking all of them and
 *                          navigating via the public API is the only robust split. Blocking
 *                          touchstart/touchmove also suppresses iOS text selection, the loupe,
 *                          Scribble interference and synthetic mouse events.
 */
export class InputRouter {
  private readonly o: InputRouterOptions;
  private readonly disposers: Array<() => void> = [];
  private stroke: ActiveStroke | null = null;
  private readonly penContacts = new Set<number>();
  private hostRect: DOMRect | null = null;
  private temporaryNavigate = false;
  /** Timestamp of the latest pen pointer event (hover included): its compat mouse events follow it. */
  private lastPenEventAt = -Infinity;
  private readonly resizeObserver: ResizeObserver | null = null;

  constructor(options: InputRouterOptions) {
    this.o = options;
    const host = options.host;
    const capture = { capture: true, passive: false } as const;

    this.listen(host, 'pointerdown', this.onPointerDown as EventListener, capture);
    this.listen(host, 'pointermove', this.onPointerMove as EventListener, capture);
    this.listen(host, 'pointerup', this.onPointerUp as EventListener, capture);
    this.listen(host, 'pointercancel', this.onPointerCancel as EventListener, capture);
    this.listen(host, 'lostpointercapture', this.onLostCapture as EventListener, capture);
    // Hover entry fires pointerover/enter, then mouseover/enter, and only then the first
    // pointermove, so pen activity must be recorded from the enter/over events too.
    for (const type of ['pointerover', 'pointerenter', 'pointerout', 'pointerleave']) {
      this.listen(host, type, this.notePenActivity as EventListener, capture);
    }

    for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
      this.listen(host, type, this.blockTouch as EventListener, capture);
    }
    // Press/click compat events from pen or touch must never reach the chart (they could start a
    // chart drag). Hover events (enter/leave/move) are left alone so the chart's hover state stays
    // consistent across pen -> mouse hand-offs; the crosshair is hidden while the pen is in use.
    for (const type of ['mousedown', 'mousemove', 'mouseup', 'click', 'dblclick', 'auxclick']) {
      this.listen(host, type, this.onMouseEvent as EventListener, capture);
    }
    this.listen(host, 'contextmenu', this.onContextMenu as EventListener, capture);
    this.listen(host, 'wheel', this.onWheel as EventListener, capture);
    this.listen(host, 'selectstart', this.preventDefault, capture);
    this.listen(host, 'dragstart', this.preventDefault, capture);

    // Safari's proprietary pinch events would otherwise zoom the page.
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
      this.listen(document, type, this.preventDefault, { passive: false });
    }
    // Safety net: a pen that lifts outside the host without delivering pointerup there (capture
    // unavailable or refused) must not stay "down" and lock out fingers and the mouse.
    this.listen(window, 'pointerup', this.onWindowPenEnd as EventListener, { capture: true, passive: true });
    this.listen(window, 'pointercancel', this.onWindowPenEnd as EventListener, { capture: true, passive: true });
    this.listen(window, 'blur', this.interruptAll, { passive: true });
    this.listen(document, 'visibilitychange', this.onVisibility, { passive: true });
    this.listen(window, 'resize', this.invalidateRect, { passive: true });
    this.listen(window, 'scroll', this.invalidateRect, { passive: true, capture: true });

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(this.invalidateRect);
      this.resizeObserver.observe(host);
    }
  }

  /** While true (e.g. Space held), mouse drags navigate even in mouse-draw mode. */
  setTemporaryNavigate(on: boolean): void {
    this.temporaryNavigate = on;
  }

  get activeStrokePointer(): number | null {
    return this.stroke?.pointerId ?? null;
  }

  dispose(): void {
    this.interruptAll();
    for (const d of this.disposers.splice(0)) d();
    this.resizeObserver?.disconnect();
  }

  // ---- pointer events ------------------------------------------------------------------------

  private readonly onPointerDown = (e: PointerEvent): void => {
    const now = e.timeStamp;
    this.trackPointerKind(e);
    this.hostRect = null; // refresh geometry once per gesture
    const { x, y } = this.local(e);
    const pane = this.o.chart.paneRect();
    const inPane = x >= pane.left && x <= pane.left + pane.width && y >= pane.top && y <= pane.top + pane.height;

    if (e.pointerType === 'pen') {
      e.preventDefault(); // suppresses compatibility mouse events for this contact
      e.stopPropagation();
      // A pen has a single contact: any id still recorded belongs to a pen-up we never saw.
      if (!this.stroke) this.penContacts.clear();
      this.penContacts.add(e.pointerId);
      this.o.palm.penDown();
      this.o.navigator.freezeForPen(now);
      // Capture every contact (also on the axes) so its pen-up reaches us wherever it lifts;
      // WebKit does not capture Apple Pencil pointers implicitly.
      this.capture(e.pointerId);
      if (!inPane || this.stroke) return;
      this.stroke = { pointerId: e.pointerId, type: 'pen', pane };
      this.o.engine.beginStroke(e.pointerId, this.sample(e, pane), { pointerType: 'pen', eraser: isEraserInput(e) });
      return;
    }

    if (e.pointerType === 'touch') {
      this.capture(e.pointerId);
      this.o.navigator.down(e.pointerId, { x, y, width: e.width, height: e.height }, now);
      return;
    }

    // Mouse (or unknown pointer types, treated like a mouse).
    this.o.navigator.stopKinetic();
    const drawMode = this.o.engine.getState().mouseDraw && !this.temporaryNavigate;
    if (drawMode && e.button === 0 && inPane && !this.stroke) {
      e.preventDefault();
      e.stopPropagation();
      this.capture(e.pointerId);
      this.stroke = { pointerId: e.pointerId, type: 'mouse', pane };
      this.o.engine.beginStroke(e.pointerId, this.sample(e, pane), { pointerType: 'mouse', eraser: false });
    }
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    this.trackPointerKind(e);
    const stroke = this.stroke;
    if (stroke && e.pointerId === stroke.pointerId) {
      e.preventDefault();
      e.stopPropagation();
      if (stroke.type === 'mouse' && (e.buttons & 1) === 0) {
        // Button released outside the window without a pointerup.
        this.finishStroke(e, false);
        return;
      }
      const coalesced = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
      const samples = (coalesced.length > 0 ? coalesced : [e]).map((ev) => this.sample(ev, stroke.pane));
      const predicted = typeof e.getPredictedEvents === 'function' ? e.getPredictedEvents().map((ev) => this.sample(ev, stroke.pane)) : [];
      this.o.engine.extendStroke(stroke.pointerId, samples, predicted);
      return;
    }

    if (e.pointerType === 'pen') {
      if (e.buttons === 0) {
        // Hover (Apple Pencil hover / S Pen Air View): the hand is about to land.
        this.o.palm.penHover(e.timeStamp);
        const pane = this.o.chart.paneRect();
        const s = this.sample(e, pane);
        this.o.engine.hover(s, isEraserInput(e));
      } else {
        e.stopPropagation();
      }
      return;
    }

    if (e.pointerType === 'touch') {
      const { x, y } = this.local(e);
      this.o.navigator.move(e.pointerId, x, y, e.timeStamp);
      return;
    }

    if (this.o.engine.getState().mouseDraw) {
      const s = this.sample(e, this.o.chart.paneRect());
      this.o.engine.hover(s);
    }
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    this.trackPointerKind(e);
    if (this.stroke && e.pointerId === this.stroke.pointerId) {
      e.preventDefault();
      e.stopPropagation();
      this.finishStroke(e, false);
    }
    if (e.pointerType === 'pen') {
      e.stopPropagation();
      this.releasePen(e.pointerId, e.timeStamp);
    } else if (e.pointerType === 'touch') {
      this.o.navigator.up(e.pointerId, e.timeStamp);
    }
  };

  private readonly onPointerCancel = (e: PointerEvent): void => {
    if (this.stroke && e.pointerId === this.stroke.pointerId) this.finishStroke(e, true);
    if (e.pointerType === 'pen') this.releasePen(e.pointerId, e.timeStamp);
    else if (e.pointerType === 'touch') this.o.navigator.cancel(e.pointerId, e.timeStamp);
  };

  private readonly notePenActivity = (e: PointerEvent): void => {
    this.trackPointerKind(e);
    // The hovering pen/mouse left the chart: drop the eraser cursor.
    if (e.type === 'pointerleave' && e.target === this.o.host && e.pointerType !== 'touch') this.o.engine.hover(null);
  };

  private readonly onWindowPenEnd = (e: PointerEvent): void => {
    if (e.pointerType !== 'pen' || !this.penContacts.has(e.pointerId)) return;
    if (this.o.host.contains(e.target as Node)) return; // handled by the host listeners
    if (this.stroke?.pointerId === e.pointerId) this.finishStroke(e, e.type === 'pointercancel');
    this.releasePen(e.pointerId, e.timeStamp);
  };

  /** Pen in use -> crosshair hidden; a real mouse moving -> crosshair back. */
  private trackPointerKind(e: PointerEvent): void {
    if (e.pointerType === 'pen') {
      this.lastPenEventAt = e.timeStamp;
      this.o.chart.setCrosshairSuppressed(true);
    } else if (e.pointerType === 'mouse' && e.type === 'pointermove') {
      this.o.chart.setCrosshairSuppressed(false);
    }
  }

  private readonly onLostCapture = (e: PointerEvent): void => {
    // Capture lost without pointerup/pointercancel (element removed, OS interruption).
    if (this.stroke && e.pointerId === this.stroke.pointerId) {
      this.finishStroke(e, true);
      if (e.pointerType === 'pen') this.releasePen(e.pointerId, e.timeStamp);
    }
  };

  private finishStroke(e: PointerEvent, cancelled: boolean): void {
    const stroke = this.stroke;
    if (!stroke) return;
    this.stroke = null;
    if (cancelled) this.o.engine.cancelStroke(stroke.pointerId);
    else this.o.engine.endStroke(stroke.pointerId, this.sample(e, stroke.pane));
    try {
      if (this.o.host.hasPointerCapture(stroke.pointerId)) this.o.host.releasePointerCapture(stroke.pointerId);
    } catch {
      // pointer already gone
    }
  }

  private releasePen(pointerId: number, now: number): void {
    this.penContacts.delete(pointerId);
    if (this.penContacts.size === 0) this.o.palm.penUp(now);
  }

  // ---- other events --------------------------------------------------------------------------

  private readonly blockTouch = (e: TouchEvent): void => {
    e.stopPropagation();
    if (e.cancelable) e.preventDefault();
  };

  private readonly onMouseEvent = (e: MouseEvent): void => {
    const pointerType = (e as PointerEvent).pointerType;
    const penContact = this.o.palm.penRecentlyActive(e.timeStamp);
    // Compat events follow their pointer event immediately (same timestamp).
    const followsPen = e.timeStamp - this.lastPenEventAt < 50;
    const isHoverMove = e.type === 'mousemove' && (e.buttons & 1) === 0;
    const fromPen = pointerType === 'pen' || penContact || (followsPen && !isHoverMove);
    const fromTouch = pointerType === 'touch';
    const duringMouseStroke = this.stroke?.type === 'mouse';
    if (fromPen || fromTouch || duringMouseStroke) {
      e.stopPropagation();
      if (e.cancelable) e.preventDefault();
    }
  };

  private readonly onContextMenu = (e: Event): void => {
    // Long-press menus and pen side-button "right clicks" must never open on the chart.
    e.preventDefault();
    e.stopPropagation();
  };

  private readonly onWheel = (e: WheelEvent): void => {
    this.o.navigator.stopKinetic();
    if (this.stroke) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  private readonly preventDefault = (e: Event): void => {
    if (e.cancelable) e.preventDefault();
  };

  private readonly onVisibility = (): void => {
    if (document.visibilityState === 'hidden') this.interruptAll();
  };

  /** App lost focus/visibility mid-interaction: finish cleanly so nothing stays stuck. */
  private readonly interruptAll = (): void => {
    const stroke = this.stroke;
    if (stroke) {
      this.stroke = null;
      this.o.engine.cancelStroke(stroke.pointerId);
    }
    if (this.penContacts.size > 0) {
      this.penContacts.clear();
      this.o.palm.penUp(performance.now());
    }
    this.o.navigator.reset();
  };

  private readonly invalidateRect = (): void => {
    this.hostRect = null;
  };

  // ---- helpers -------------------------------------------------------------------------------

  private listen(target: EventTarget, type: string, fn: EventListener, options: AddEventListenerOptions): void {
    target.addEventListener(type, fn, options);
    this.disposers.push(() => target.removeEventListener(type, fn, options));
  }

  private capture(pointerId: number): void {
    // WebKit does not implicitly capture Apple Pencil pointers, so capture explicitly.
    try {
      this.o.host.setPointerCapture(pointerId);
    } catch {
      // synthetic/unknown pointer ids cannot be captured; events still bubble through the host
    }
  }

  private local(e: MouseEvent): { x: number; y: number } {
    if (!this.hostRect) this.hostRect = this.o.host.getBoundingClientRect();
    return { x: e.clientX - this.hostRect.left, y: e.clientY - this.hostRect.top };
  }

  private sample(e: PointerEvent, pane: PaneRect): StrokeInput {
    const { x, y } = this.local(e);
    return { x: x - pane.left, y: y - pane.top, pressure: e.pressure, time: e.timeStamp };
  }
}
