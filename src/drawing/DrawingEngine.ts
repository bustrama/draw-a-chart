import type { ChartController } from '../chart/ChartController';
import { THEME } from '../chart/theme';
import type { Viewport } from '../chart/viewport';
import { uuid } from '../lib/ids';
import { classifyStroke, HANDWRITING, joinsNote } from './classify';
import { bboxOf, pointInPolygon, polylineLength, rdpIndices, segmentPolylineDistance, segmentSegmentDistance, type Pt } from './geometry';
import {
  glyphScale,
  quantizePressure,
  quantizePrice,
  quantizePx,
  quantizeTime,
  type Drawing,
  type GlyphDrawing,
  type InkDrawing,
  type LineDrawing,
  type StrokeStyle,
} from './model';
import { fitLine, HoldTracker, isLineLike, snapLineEnd } from './quickShape';
import { DrawingsPrimitive } from './render/DrawingsPrimitive';
import type { LiveLayer } from './render/LiveLayer';
import { fillOutline, glyphScreenPoints, inkOutline, inkScreenPoints, renderDrawing, screenBox, type ScreenBox, type ScreenPoint } from './render/strokes';
import type { DrawingDocument, Mutation, StoreChange } from './store';

export type Tool = 'pen' | 'eraser' | 'select';

export interface EngineState {
  readonly tool: Tool;
  readonly color: string;
  readonly width: number;
  readonly mouseDraw: boolean;
  readonly handwriting: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly selectionCount: number;
  readonly strokeActive: boolean;
  readonly drawingCount: number;
}

/** One input sample in pane-local CSS px; `time` is the event timestamp (performance.now clock). */
export interface StrokeInput {
  readonly x: number;
  readonly y: number;
  readonly pressure: number;
  readonly time: number;
}

export interface StrokeStartInfo {
  readonly pointerType: 'pen' | 'mouse';
  /** Pen eraser end / barrel button: erase regardless of the selected tool. */
  readonly eraser: boolean;
}

/** Live preview of a stroke being drawn on another device (see sync). */
export interface RemotePreview {
  readonly id: string;
  readonly style: StrokeStyle;
  readonly pts: readonly number[]; // [t, p, pressure] triples
  readonly updatedAt: number;
}

/** The stroke in progress, for live previews. `points()` builds the payload lazily. */
export interface StrokeProgress {
  readonly id: string;
  readonly style: StrokeStyle;
  points(): number[];
}

export interface EngineHooks {
  onStrokeStart?(pointerType: 'pen' | 'mouse'): void;
  onStrokeEnd?(): void;
  /** Whether stroke progress is wanted right now (e.g. previews to other devices are possible). */
  wantsProgress?(): boolean;
  /** Stroke progress; `end` is set once when the stroke is committed or discarded. */
  onStrokeProgress?(progress: StrokeProgress, end: 'commit' | 'discard' | null): void;
}

interface CapturedPoint {
  readonly t: number;
  readonly p: number;
  readonly pr: number;
}

interface DrawSession {
  readonly kind: 'draw';
  readonly pointerId: number;
  readonly pointerType: 'pen' | 'mouse';
  readonly id: string;
  readonly style: StrokeStyle;
  readonly startedAt: number;
  readonly points: CapturedPoint[];
  predicted: CapturedPoint[];
  readonly hold: HoldTracker;
  holdTimer: ReturnType<typeof setTimeout> | null;
  line: { a: CapturedPoint; b: CapturedPoint } | null;
  /** Progress was reported at least once (so an end notice must follow). */
  reported: boolean;
}

interface EraseSession {
  readonly kind: 'erase';
  readonly pointerId: number;
  readonly pointerType: 'pen' | 'mouse';
  last: Pt | null;
  readonly hits: Set<string>;
}

interface SelectSession {
  readonly kind: 'select';
  readonly pointerId: number;
  readonly pointerType: 'pen' | 'mouse';
  readonly mode: 'lasso' | 'move';
  readonly lasso: Pt[];
  readonly start: Pt;
  last: Pt;
  /** Drawings being moved (hidden in the chart while the preview follows the pen). */
  readonly movingIds: readonly string[];
}

type Session = DrawSession | EraseSession | SelectSession;

/** A stroke whose samples are held until the chart has painted a pending view change. */
interface PendingStart {
  readonly pointerId: number;
  readonly info: StrokeStartInfo;
  readonly samples: StrokeInput[];
  ended: { cancelled: boolean; final?: StrokeInput } | null;
}

interface NoteContext {
  readonly group: string;
  readonly at: number;
  readonly ap: number;
  readonly ref: number;
  /** Note-local bounds (CSS px at reference scale, relative to the anchor). */
  box: { minX: number; minY: number; maxX: number; maxY: number };
  lastEndAt: number;
  lineHeight: number;
  readonly style: StrokeStyle;
}

export const ERASER_RADIUS_PX = 10;
const MIN_POINT_SPACING_PX = 0.6;
/** Upper bound for points per stored drawing (keeps rows far below the 256 KB server limit). */
export const MAX_STROKE_POINTS = 2000;
const PREVIEW_TTL_MS = 5_000;

/**
 * Framework-agnostic drawing engine. Owns tool state, stroke sessions, the chart primitive that
 * renders committed drawings and the live layer that renders transient content.
 * Input arrives already classified and in pane coordinates from the InputRouter.
 */
export class DrawingEngine {
  private doc: DrawingDocument | null = null;
  private unsubscribeDoc: (() => void) | null = null;
  private session: Session | null = null;
  private pending: PendingStart | null = null;
  private readonly hiddenIds = new Set<string>();
  private selection = new Set<string>();
  private note: NoteContext | null = null;
  private hoverPoint: { x: number; y: number; eraserButton: boolean } | null = null;
  private liveFrame: number | null = null;
  private readonly remotePreviews = new Map<string, RemotePreview>();
  private previewSweep: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<() => void>();
  private state: EngineState;
  private readonly primitive: DrawingsPrimitive;
  private readonly unsubscribeView: () => void;
  private readonly chart: ChartController;
  private readonly live: LiveLayer;
  private readonly hooks: EngineHooks;

  constructor(chart: ChartController, live: LiveLayer, hooks: EngineHooks = {}) {
    this.chart = chart;
    this.live = live;
    this.hooks = hooks;
    this.state = {
      tool: 'pen',
      color: '#ffd166',
      width: 2.5,
      mouseDraw: false,
      handwriting: true,
      canUndo: false,
      canRedo: false,
      selectionCount: 0,
      strokeActive: false,
      drawingCount: 0,
    };
    this.primitive = new DrawingsPrimitive({
      viewport: () => this.chart.viewport(),
      drawings: () => this.doc?.store.all() ?? [],
      hidden: () => this.hiddenIds,
    });
    chart.candles.attachPrimitive(this.primitive);
    // Keep the live layer glued to the chart: it repaints in the same frame as the chart.
    this.unsubscribeView = chart.onViewChange(() => this.renderLiveNow());
  }

  // ---- document ------------------------------------------------------------------------------

  setDocument(doc: DrawingDocument | null): void {
    if (this.doc === doc) return;
    this.cancelSession();
    this.unsubscribeDoc?.();
    this.doc = doc;
    this.note = null;
    this.selection = new Set();
    this.hiddenIds.clear();
    this.remotePreviews.clear();
    this.unsubscribeDoc = doc ? doc.store.subscribe((c) => this.onStoreChange(c)) : null;
    this.primitive.invalidate();
    this.updateState({});
    this.requestLive();
  }

  get document(): DrawingDocument | null {
    return this.doc;
  }

  private onStoreChange(change: StoreChange): void {
    let selectionChanged = false;
    for (const m of change.mutations) {
      if (m.op === 'delete' && this.selection.delete(m.id)) selectionChanged = true;
      // The durable drawing replaces its live preview from another device.
      if (m.op === 'put') this.remotePreviews.delete(m.drawing.id);
    }
    this.primitive.invalidate();
    if (selectionChanged) this.selection = new Set(this.selection);
    this.updateState({});
    this.requestLive();
  }

  // ---- UI state --------------------------------------------------------------------------------

  getState = (): EngineState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setTool(tool: Tool): void {
    this.abortSelectSession();
    if (tool !== 'select') this.selection = new Set();
    this.updateState({ tool });
    this.requestLive();
  }

  setColor(color: string): void {
    this.updateState({ color });
    this.recolorSelection(color);
  }

  setWidth(width: number): void {
    this.updateState({ width });
  }

  setMouseDraw(on: boolean): void {
    this.updateState({ mouseDraw: on });
  }

  setHandwriting(on: boolean): void {
    this.updateState({ handwriting: on });
  }

  undo(): void {
    if (this.isStrokeActive || !this.doc) return;
    this.doc.undo();
    this.note = null;
  }

  redo(): void {
    if (this.isStrokeActive || !this.doc) return;
    this.doc.redo();
    this.note = null;
  }

  deleteSelection(): void {
    this.abortSelectSession();
    if (!this.doc || this.selection.size === 0) return;
    const ids = [...this.selection];
    this.selection = new Set();
    this.doc.commit('delete', ids.map((id) => ({ op: 'delete', id })));
    this.requestLive();
  }

  clearSelection(): void {
    this.abortSelectSession();
    if (this.selection.size === 0) return;
    this.selection = new Set();
    this.updateState({});
    this.requestLive();
  }

  get isStrokeActive(): boolean {
    return this.session !== null || this.pending !== null;
  }

  activePointerId(): number | null {
    return this.session?.pointerId ?? this.pending?.pointerId ?? null;
  }

  // ---- input -----------------------------------------------------------------------------------

  beginStroke(pointerId: number, s: StrokeInput, info: StrokeStartInfo): void {
    const active = this.activePointerId();
    if (active !== null) this.endStroke(active);
    if (!this.doc) return;
    this.hoverPoint = null;
    this.chart.beginDeferUpdates();
    this.hooks.onStrokeStart?.(info.pointerType);
    this.updateState({ strokeActive: true });
    if (this.chart.isSettling) {
      // A navigation change (e.g. a palm rollback when the nib landed) is requested but not yet
      // painted: converting samples now would use the outgoing view and leave a hook at the
      // start of the stroke. Hold the samples until the chart has repainted.
      const pending: PendingStart = { pointerId, info, samples: [s], ended: null };
      this.pending = pending;
      this.chart.whenSettled(() => {
        if (this.pending === pending) this.activatePending();
      });
      return;
    }
    this.openSession(pointerId, s, info);
  }

  extendStroke(pointerId: number, samples: readonly StrokeInput[], predicted: readonly StrokeInput[] = []): void {
    if (this.pending?.pointerId === pointerId) {
      this.pending.samples.push(...samples);
      return;
    }
    const session = this.session;
    if (!session || session.pointerId !== pointerId || samples.length === 0) return;
    const v = this.chart.viewport();
    if (!v) return;
    switch (session.kind) {
      case 'draw': {
        for (const s of samples) {
          if (session.line) {
            session.line = { a: session.line.a, b: this.snappedEnd(session.line.a, s, v) };
          } else {
            this.addDrawPoint(session, s, v);
            if (session.hold.update({ x: s.x, y: s.y }, s.time, session.points.length - 1)) this.scheduleHold(session, s.time);
          }
        }
        session.predicted = session.line ? [] : predicted.map((s) => ({ t: v.xToTime(s.x), p: v.yToPrice(s.y), pr: s.pressure > 0 ? Math.min(1, s.pressure) : 0.5 }));
        this.emitProgress(session, null);
        break;
      }
      case 'erase':
        for (const s of samples) this.eraseTo({ x: s.x, y: s.y }, v);
        break;
      case 'select': {
        const last = samples[samples.length - 1];
        session.last = { x: last.x, y: last.y };
        if (session.mode === 'lasso') for (const s of samples) session.lasso.push({ x: s.x, y: s.y });
        break;
      }
    }
    this.requestLive();
  }

  endStroke(pointerId: number, final?: StrokeInput): void {
    if (this.pending?.pointerId === pointerId) {
      this.pending.ended = { cancelled: false, final };
      return; // completes as soon as the chart has settled
    }
    const session = this.session;
    if (!session || session.pointerId !== pointerId) return;
    if (final) this.extendStroke(pointerId, [final]);
    this.finish(session, 'commit');
  }

  /** Pointer cancelled/interrupted: keep what the user already saw (consistent with ink on paper). */
  cancelStroke(pointerId: number): void {
    if (this.pending?.pointerId === pointerId) {
      this.pending.ended = { cancelled: true };
      return;
    }
    const session = this.session;
    if (!session || session.pointerId !== pointerId) return;
    this.finish(session, 'commit');
  }

  /** Abandons any session without committing (document switch, disposal). */
  cancelSession(): void {
    if (this.pending) {
      this.pending = null;
      this.releaseStroke();
    }
    if (this.session) this.finish(this.session, 'discard');
  }

  /** Pen/mouse hover (no contact); `null` when the pointer left. Drives the eraser cursor. */
  hover(s: { x: number; y: number } | null, eraserButton = false): void {
    const next = s ? { x: s.x, y: s.y, eraserButton } : null;
    const before = this.hoverPoint;
    this.hoverPoint = next;
    const visibleBefore = before !== null && (before.eraserButton || this.state.tool === 'eraser');
    const visibleNow = next !== null && (next.eraserButton || this.state.tool === 'eraser');
    if (visibleBefore || visibleNow) this.requestLive();
  }

  // ---- remote live previews ------------------------------------------------------------------

  setRemotePreview(preview: RemotePreview | null, id?: string): void {
    if (preview) this.remotePreviews.set(preview.id, preview);
    else if (id) this.remotePreviews.delete(id);
    this.schedulePreviewSweep();
    this.requestLive();
  }

  /** A remote stroke ended: 'discard' removes its ghost now; 'commit' keeps it until the drawing arrives. */
  endRemotePreview(id: string, how: 'commit' | 'discard'): void {
    const p = this.remotePreviews.get(id);
    if (!p) return;
    if (how === 'discard') this.remotePreviews.delete(id);
    else this.remotePreviews.set(id, { ...p, updatedAt: Date.now() });
    this.schedulePreviewSweep();
    this.requestLive();
  }

  private schedulePreviewSweep(): void {
    if (this.previewSweep || this.remotePreviews.size === 0) return;
    // Expired ghosts must disappear even on an idle viewer (nothing else would repaint).
    this.previewSweep = setTimeout(() => {
      this.previewSweep = null;
      this.requestLive();
      this.schedulePreviewSweep();
    }, 1_000);
  }

  // ---- session internals ---------------------------------------------------------------------

  private openSession(pointerId: number, s: StrokeInput, info: StrokeStartInfo): boolean {
    const v = this.chart.viewport();
    if (!v || !this.doc) {
      this.releaseStroke();
      return false;
    }
    const tool: Tool = info.eraser ? 'eraser' : this.state.tool;
    if (tool === 'eraser') {
      this.session = { kind: 'erase', pointerId, pointerType: info.pointerType, last: null, hits: new Set() };
      this.eraseTo({ x: s.x, y: s.y }, v);
    } else if (tool === 'select') {
      const p = { x: s.x, y: s.y };
      const move = this.selection.size > 0 && this.pointInSelection(p, v);
      const movingIds = move ? [...this.selection] : [];
      this.session = { kind: 'select', pointerId, pointerType: info.pointerType, mode: move ? 'move' : 'lasso', lasso: [p], start: p, last: p, movingIds };
      if (move) {
        for (const id of movingIds) this.hiddenIds.add(id);
        this.primitive.invalidate();
      }
    } else {
      const session: DrawSession = {
        kind: 'draw',
        pointerId,
        pointerType: info.pointerType,
        id: uuid(),
        style: { color: this.state.color, width: this.state.width },
        startedAt: s.time,
        points: [],
        predicted: [],
        hold: new HoldTracker(),
        holdTimer: null,
        line: null,
        reported: false,
      };
      this.session = session;
      this.addDrawPoint(session, s, v);
      session.hold.reset({ x: s.x, y: s.y }, s.time, 0);
      this.scheduleHold(session, s.time);
    }
    this.requestLive();
    return true;
  }

  private activatePending(): void {
    const p = this.pending;
    this.pending = null;
    if (!p || !this.openSession(p.pointerId, p.samples[0], p.info)) return;
    if (p.samples.length > 1) this.extendStroke(p.pointerId, p.samples.slice(1));
    if (p.ended?.cancelled) this.cancelStroke(p.pointerId);
    else if (p.ended) this.endStroke(p.pointerId, p.ended.final);
  }

  /** Undoes the side effects of beginStroke when no session will run. */
  private releaseStroke(): void {
    this.chart.endDeferUpdates();
    this.hooks.onStrokeEnd?.();
    this.updateState({ strokeActive: false });
  }

  private abortSelectSession(): void {
    if (this.session?.kind === 'select') this.finish(this.session, 'discard');
  }

  private addDrawPoint(session: DrawSession, s: StrokeInput, v: Viewport): void {
    const prev = session.points[session.points.length - 1];
    const pr = clampPressure(s.pressure, session.pointerType, prev?.pr);
    if (prev) {
      const dx = v.timeToX(prev.t) - s.x;
      const dy = v.priceToY(prev.p) - s.y;
      if (dx * dx + dy * dy < MIN_POINT_SPACING_PX * MIN_POINT_SPACING_PX) return;
    }
    session.points.push({ t: v.xToTime(s.x), p: v.yToPrice(s.y), pr });
  }

  private scheduleHold(session: DrawSession, now: number): void {
    if (session.holdTimer) clearTimeout(session.holdTimer);
    session.holdTimer = setTimeout(() => {
      session.holdTimer = null;
      if (this.session !== session || session.line) return;
      if (!session.hold.isHeld(performance.now())) return;
      this.tryQuickShape(session);
    }, Math.max(0, session.hold.dueAt - now) + 5);
  }

  private tryQuickShape(session: DrawSession): void {
    const v = this.chart.viewport();
    if (!v) return;
    const upto = session.points.slice(0, session.hold.anchorIndex + 1);
    const screen = upto.map((p) => ({ x: v.timeToX(p.t), y: v.priceToY(p.p) }));
    if (!isLineLike(fitLine(screen))) return;
    const a = upto[0];
    const end = upto[upto.length - 1];
    session.line = { a, b: this.snappedEnd(a, { x: v.timeToX(end.t), y: v.priceToY(end.p), pressure: end.pr, time: 0 }, v) };
    session.predicted = [];
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate(8);
      } catch {
        // Haptics are best effort.
      }
    }
    this.emitProgress(session, null);
    this.requestLive();
  }

  private snappedEnd(a: CapturedPoint, s: StrokeInput, v: Viewport): CapturedPoint {
    const start = { x: v.timeToX(a.t), y: v.priceToY(a.p) };
    const { end } = snapLineEnd(start, { x: s.x, y: s.y });
    return { t: v.xToTime(end.x), p: v.yToPrice(end.y), pr: a.pr };
  }

  private eraseTo(p: Pt, v: Viewport): void {
    const session = this.session;
    if (!session || session.kind !== 'erase' || !this.doc) return;
    const a = session.last ?? p;
    session.last = p;
    let changed = false;
    for (const d of this.doc.store.all()) {
      if (session.hits.has(d.id)) continue;
      const tol = ERASER_RADIUS_PX + d.style.width / 2;
      const box = screenBox(d, v);
      if (box.maxX < Math.min(a.x, p.x) - tol || box.minX > Math.max(a.x, p.x) + tol) continue;
      if (box.maxY < Math.min(a.y, p.y) - tol || box.minY > Math.max(a.y, p.y) + tol) continue;
      if (distanceToDrawing(d, v, a, p) <= tol) {
        session.hits.add(d.id);
        this.hiddenIds.add(d.id);
        changed = true;
      }
    }
    if (changed) this.primitive.invalidate();
  }

  private finish(session: Session, mode: 'commit' | 'discard'): void {
    this.session = null;
    try {
      if (session.kind === 'draw') {
        if (session.holdTimer) clearTimeout(session.holdTimer);
        const drawings = mode === 'commit' ? this.buildDrawings(session) : [];
        if (drawings.length > 0 && this.doc) this.doc.commit('draw', drawings.map((drawing): Mutation => ({ op: 'put', drawing })));
        if (session.reported) this.emitProgress(session, drawings.length > 0 ? 'commit' : 'discard');
      } else if (session.kind === 'erase') {
        for (const id of session.hits) this.hiddenIds.delete(id);
        if (mode === 'commit' && session.hits.size > 0 && this.doc) {
          this.doc.commit(
            'erase',
            [...session.hits].map((id): Mutation => ({ op: 'delete', id })),
          );
        } else {
          this.primitive.invalidate();
        }
      } else {
        this.finishSelect(session, mode);
      }
    } finally {
      this.releaseStroke();
      this.requestLive();
    }
  }

  /** Stored drawings for a finished stroke (a very long ink stroke may become several). */
  private buildDrawings(session: DrawSession): Drawing[] {
    const v = this.chart.viewport();
    if (!v) return [];
    const createdAt = Date.now();
    if (session.line) {
      const { a, b } = session.line;
      const line: LineDrawing = {
        id: session.id,
        kind: 'line',
        style: session.style,
        createdAt,
        t1: quantizeTime(a.t),
        p1: quantizePrice(a.p),
        t2: quantizeTime(b.t),
        p2: quantizePrice(b.p),
      };
      return [line];
    }
    if (session.points.length === 0) return [];
    const screen = session.points.map((p) => ({ x: v.timeToX(p.t), y: v.priceToY(p.p), pr: p.pr }));
    const cls = this.state.handwriting ? classifyStroke(screen) : 'ink';
    if (cls === 'glyph') return [this.buildGlyph(session, capGlyphPoints(screen), v, createdAt)];
    const chunks = capPoints(session.points, (p) => v.timeToX(p.t), (p) => v.priceToY(p.p));
    return chunks.map((chunk, i) => {
      const pts: number[] = [];
      for (const p of chunk) pts.push(quantizeTime(p.t), quantizePrice(p.p), quantizePressure(p.pr));
      const ink: InkDrawing = { id: i === 0 ? session.id : uuid(), kind: 'ink', style: session.style, createdAt: createdAt + i, pts };
      return ink;
    });
  }

  private buildGlyph(session: DrawSession, screen: Array<{ x: number; y: number; pr: number }>, v: Viewport, createdAt: number): GlyphDrawing {
    const box = bboxOf(screen);
    const endAt = performance.now();
    let note = this.note;
    if (note && (note.style.color !== session.style.color || note.style.width !== session.style.width)) note = null;
    if (note) {
      const k = glyphScale(note.ref, v.pxPerMs);
      const ax = v.timeToX(note.at);
      const ay = v.priceToY(note.ap);
      const ctx = {
        box: { minX: ax + note.box.minX * k, minY: ay + note.box.minY * k, maxX: ax + note.box.maxX * k, maxY: ay + note.box.maxY * k },
        lastEndAt: note.lastEndAt,
        lineHeight: note.lineHeight * k,
      };
      if (!joinsNote(ctx, box, session.startedAt, HANDWRITING)) note = null;
    }
    if (!note) {
      const cx = (box.minX + box.maxX) / 2;
      const cy = (box.minY + box.maxY) / 2;
      note = {
        group: uuid(),
        at: quantizeTime(v.xToTime(cx)),
        ap: quantizePrice(v.yToPrice(cy)),
        ref: v.pxPerMs,
        box: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
        lastEndAt: endAt,
        lineHeight: 0,
        style: session.style,
      };
      this.note = note;
    }
    const k = glyphScale(note.ref, v.pxPerMs);
    const ax = v.timeToX(note.at);
    const ay = v.priceToY(note.ap);
    const pts: number[] = [];
    for (const p of screen) {
      const lx = (p.x - ax) / k;
      const ly = (p.y - ay) / k;
      pts.push(quantizePx(lx), quantizePx(ly), quantizePressure(p.pr));
      note.box.minX = Math.min(note.box.minX, lx);
      note.box.maxX = Math.max(note.box.maxX, lx);
      note.box.minY = Math.min(note.box.minY, ly);
      note.box.maxY = Math.max(note.box.maxY, ly);
    }
    note.lastEndAt = endAt;
    note.lineHeight = Math.min(HANDWRITING.maxGlyphSizePx, Math.max(note.lineHeight, (box.maxY - box.minY) / k));
    return {
      id: session.id,
      kind: 'glyph',
      style: session.style,
      createdAt,
      group: note.group,
      at: note.at,
      ap: note.ap,
      ref: note.ref,
      pts,
    };
  }

  private finishSelect(session: SelectSession, mode: 'commit' | 'discard'): void {
    const v = this.chart.viewport();
    if (session.mode === 'move') {
      // Restore exactly what this move hid, even if the selection changed meanwhile.
      for (const id of session.movingIds) this.hiddenIds.delete(id);
      const dx = session.last.x - session.start.x;
      const dy = session.last.y - session.start.y;
      if (mode === 'commit' && v && this.doc && Math.hypot(dx, dy) > 1) {
        const moved: Mutation[] = [];
        for (const id of session.movingIds) {
          const d = this.doc.store.get(id);
          if (d) moved.push({ op: 'put', drawing: translateDrawing(d, dx, dy, v) });
        }
        if (!this.doc.commit('move', moved)) this.primitive.invalidate();
      } else {
        this.primitive.invalidate();
      }
      return;
    }
    if (mode !== 'commit' || !v || !this.doc) return;
    const drawings = this.doc.store.all();
    const next = new Set<string>();
    if (polylineLength(session.lasso) < 8) {
      // Tap: select the nearest drawing under the pen.
      const p = session.start;
      let best: { id: string; d: number } | null = null;
      for (const d of drawings) {
        const dist = distanceToDrawing(d, v, p, p);
        if (dist <= 14 + d.style.width / 2 && (!best || dist < best.d)) best = { id: d.id, d: dist };
      }
      if (best) next.add(best.id);
    } else {
      for (const d of drawings) {
        const pts = samplePoints(d, v);
        if (pts.length === 0) continue;
        let inside = 0;
        for (const p of pts) if (pointInPolygon(p, session.lasso)) inside++;
        if (inside / pts.length >= 0.5) next.add(d.id);
      }
    }
    this.selection = next;
    this.updateState({});
  }

  private pointInSelection(p: Pt, v: Viewport): boolean {
    const box = this.selectionBox(v, this.selection);
    return box !== null && p.x >= box.minX - 8 && p.x <= box.maxX + 8 && p.y >= box.minY - 8 && p.y <= box.maxY + 8;
  }

  private selectionBox(v: Viewport, ids: Iterable<string>, dx = 0, dy = 0): ScreenBox | null {
    if (!this.doc) return null;
    let box: ScreenBox | null = null;
    for (const id of ids) {
      const d = this.doc.store.get(id);
      if (!d) continue;
      const b = screenBox(d, v);
      box = box
        ? { minX: Math.min(box.minX, b.minX), minY: Math.min(box.minY, b.minY), maxX: Math.max(box.maxX, b.maxX), maxY: Math.max(box.maxY, b.maxY) }
        : { ...b };
    }
    if (box) {
      box.minX += dx;
      box.maxX += dx;
      box.minY += dy;
      box.maxY += dy;
    }
    return box;
  }

  private recolorSelection(color: string): void {
    if (!this.doc || this.selection.size === 0) return;
    const muts: Mutation[] = [];
    for (const id of this.selection) {
      const d = this.doc.store.get(id);
      if (d && d.style.color !== color) muts.push({ op: 'put', drawing: { ...d, style: { ...d.style, color } } });
    }
    if (muts.length > 0) this.doc.commit('recolor', muts);
  }

  private emitProgress(session: DrawSession, end: 'commit' | 'discard' | null): void {
    const hook = this.hooks.onStrokeProgress;
    if (!hook) return;
    if (end === null && this.hooks.wantsProgress?.() === false) return;
    session.reported = true;
    hook(
      {
        id: session.id,
        style: session.style,
        points: () => {
          const pts: number[] = [];
          const src = session.line ? [session.line.a, session.line.b] : session.points;
          for (const p of src) pts.push(quantizeTime(p.t), quantizePrice(p.p), quantizePressure(p.pr));
          return pts;
        },
      },
      end,
    );
  }

  // ---- live layer ------------------------------------------------------------------------------

  requestLive(): void {
    if (this.liveFrame !== null) return;
    this.liveFrame = requestAnimationFrame(() => {
      this.liveFrame = null;
      this.renderLiveNow();
    });
  }

  private renderLiveNow(): void {
    this.live.setRect(this.chart.paneRect());
    const v = this.chart.viewport();
    this.live.render((ctx) => (v ? this.drawLive(ctx, v) : false));
  }

  private drawLive(ctx: CanvasRenderingContext2D, v: Viewport): boolean {
    let drew = false;
    const now = Date.now();
    for (const [id, preview] of this.remotePreviews) {
      if (now - preview.updatedAt > PREVIEW_TTL_MS) {
        this.remotePreviews.delete(id);
        continue;
      }
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = preview.style.color;
      const pts: ScreenPoint[] = [];
      for (let i = 0; i < preview.pts.length; i += 3) pts.push([v.timeToX(preview.pts[i]), v.priceToY(preview.pts[i + 1]), preview.pts[i + 2]]);
      fillOutline(ctx, inkOutline(pts, preview.style.width, false));
      ctx.globalAlpha = 1;
      drew = true;
    }

    const session = this.session;
    if (session?.kind === 'draw') {
      drew = true;
      if (session.line) {
        const { a, b } = session.line;
        ctx.strokeStyle = session.style.color;
        ctx.lineWidth = session.style.width;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(v.timeToX(a.t), v.priceToY(a.p));
        ctx.lineTo(v.timeToX(b.t), v.priceToY(b.p));
        ctx.stroke();
      } else {
        const pts: ScreenPoint[] = [];
        for (const p of session.points) pts.push([v.timeToX(p.t), v.priceToY(p.p), p.pr]);
        for (const p of session.predicted) pts.push([v.timeToX(p.t), v.priceToY(p.p), p.pr]);
        ctx.fillStyle = session.style.color;
        fillOutline(ctx, inkOutline(pts, session.style.width, false));
      }
    } else if (session?.kind === 'select') {
      drew = true;
      if (session.mode === 'lasso') {
        ctx.save();
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = THEME.selection;
        ctx.lineWidth = 1.25;
        ctx.fillStyle = 'rgba(90, 169, 255, 0.07)';
        ctx.beginPath();
        session.lasso.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      } else if (this.doc) {
        // The move preview is a pure screen translation of the originals.
        ctx.save();
        ctx.translate(session.last.x - session.start.x, session.last.y - session.start.y);
        for (const id of session.movingIds) {
          const d = this.doc.store.get(id);
          if (d) renderDrawing(ctx, d, v);
        }
        ctx.restore();
      }
    }

    const moving = session?.kind === 'select' && session.mode === 'move' ? session : null;
    const outlined = moving ? moving.movingIds : this.selection;
    if ((moving || this.selection.size > 0) && this.doc) {
      const dx = moving ? moving.last.x - moving.start.x : 0;
      const dy = moving ? moving.last.y - moving.start.y : 0;
      const box = this.selectionBox(v, outlined, dx, dy);
      if (box) {
        drew = true;
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = THEME.selection;
        ctx.lineWidth = 1;
        ctx.strokeRect(box.minX - 4, box.minY - 4, box.maxX - box.minX + 8, box.maxY - box.minY + 8);
        ctx.restore();
      }
    }

    const hover = this.hoverPoint;
    const erasing = session?.kind === 'erase' ? session.last : null;
    // Whether the hover shows an eraser is decided now, from the current tool.
    const cursor = erasing ?? (hover && (hover.eraserButton || this.state.tool === 'eraser') ? hover : null);
    if (cursor) {
      drew = true;
      ctx.save();
      ctx.strokeStyle = 'rgba(214, 219, 228, 0.8)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cursor.x, cursor.y, ERASER_RADIUS_PX, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    return drew;
  }

  // ---- misc ------------------------------------------------------------------------------------

  private updateState(patch: Partial<EngineState>): void {
    const next: EngineState = {
      ...this.state,
      ...patch,
      canUndo: this.doc?.history.canUndo ?? false,
      canRedo: this.doc?.history.canRedo ?? false,
      selectionCount: this.selection.size,
      drawingCount: this.doc?.store.size ?? 0,
    };
    const prev = this.state;
    if (
      prev.tool === next.tool &&
      prev.color === next.color &&
      prev.width === next.width &&
      prev.mouseDraw === next.mouseDraw &&
      prev.handwriting === next.handwriting &&
      prev.canUndo === next.canUndo &&
      prev.canRedo === next.canRedo &&
      prev.selectionCount === next.selectionCount &&
      prev.strokeActive === next.strokeActive &&
      prev.drawingCount === next.drawingCount
    ) {
      return;
    }
    this.state = next;
    for (const l of this.listeners) l();
  }

  /** Number of drawings rendered in the last chart paint (diagnostics/tests). */
  get lastRenderedCount(): number {
    return this.primitive.lastDrawnCount;
  }

  dispose(): void {
    this.cancelSession();
    this.unsubscribeDoc?.();
    this.unsubscribeView();
    if (this.liveFrame !== null) cancelAnimationFrame(this.liveFrame);
    if (this.previewSweep) clearTimeout(this.previewSweep);
    try {
      this.chart.candles.detachPrimitive(this.primitive);
    } catch {
      // chart may already be removed
    }
    this.listeners.clear();
  }
}

/**
 * Pressure for a sample. Mouse = constant. Pens report 0 on pointerup (and some devices on
 * contact): keep the previous pressure there instead of jumping to the 0.5 default, which would
 * leave a blob at the end of fast strokes.
 */
export function clampPressure(pressure: number, pointerType: 'pen' | 'mouse', previous?: number): number {
  if (pointerType === 'mouse') return 0.5;
  if (!(pressure > 0)) return previous ?? 0.5;
  return Math.min(1, pressure);
}

/**
 * Limits the points of one stored drawing: simplifies with increasing (sub-pixel to 2 px)
 * tolerance, and splits whatever is still too long into consecutive pieces sharing their joins.
 */
export function capPoints<T>(points: readonly T[], xOf: (p: T) => number, yOf: (p: T) => number, max = MAX_STROKE_POINTS): T[][] {
  if (points.length <= max) return [points.slice()];
  const xs = points.map(xOf);
  const ys = points.map(yOf);
  let kept: T[] = points.slice();
  for (const tolerance of [0.25, 0.5, 1, 2]) {
    kept = rdpIndices(xs, ys, tolerance).map((i) => points[i]);
    if (kept.length <= max) return [kept];
  }
  const chunks: T[][] = [];
  for (let i = 0; i < kept.length - 1; i += max - 1) chunks.push(kept.slice(i, Math.min(kept.length, i + max)));
  return chunks;
}

/** A glyph is one letter-sized shape: simplify, and in the extreme case decimate (never split). */
function capGlyphPoints<T extends { x: number; y: number }>(points: readonly T[]): T[] {
  const chunks = capPoints(points, (p) => p.x, (p) => p.y);
  if (chunks.length === 1) return chunks[0];
  const all = chunks.flat();
  const step = Math.ceil(all.length / MAX_STROKE_POINTS);
  return all.filter((_, i) => i % step === 0 || i === all.length - 1);
}

/** Minimum distance between segment ab and a drawing's centre line, in screen px. */
export function distanceToDrawing(d: Drawing, v: Viewport, a: Pt, b: Pt): number {
  if (d.kind === 'line') {
    return segmentSegmentDistance(a, b, { x: v.timeToX(d.t1), y: v.priceToY(d.p1) }, { x: v.timeToX(d.t2), y: v.priceToY(d.p2) });
  }
  const pts = d.kind === 'ink' ? inkScreenPoints(d, v) : glyphScreenPoints(d, v);
  return segmentPolylineDistance(
    a,
    b,
    pts.map(([x, y]) => ({ x, y })),
  );
}

function samplePoints(d: Drawing, v: Viewport): Pt[] {
  if (d.kind === 'line') {
    const a = { x: v.timeToX(d.t1), y: v.priceToY(d.p1) };
    const b = { x: v.timeToX(d.t2), y: v.priceToY(d.p2) };
    return [a, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, b];
  }
  const pts = d.kind === 'ink' ? inkScreenPoints(d, v) : glyphScreenPoints(d, v);
  const step = Math.max(1, Math.floor(pts.length / 64));
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i += step) out.push({ x: pts[i][0], y: pts[i][1] });
  return out;
}

/** Moves a drawing by a screen delta, preserving chart anchoring semantics. */
export function translateDrawing(d: Drawing, dx: number, dy: number, v: Viewport): Drawing {
  const dL = dx / v.barSpacing;
  const shiftT = (t: number): number => quantizeTime(v.timeIndex.logicalToTime(v.timeIndex.timeToLogical(t) + dL));
  const shiftP = (p: number): number => quantizePrice(v.yToPrice(v.priceToY(p) + dy));
  switch (d.kind) {
    case 'line':
      return { ...d, t1: shiftT(d.t1), p1: shiftP(d.p1), t2: shiftT(d.t2), p2: shiftP(d.p2) };
    case 'glyph':
      return { ...d, at: shiftT(d.at), ap: shiftP(d.ap) };
    case 'ink': {
      const pts = d.pts.slice();
      for (let i = 0; i < pts.length; i += 3) {
        pts[i] = shiftT(pts[i]);
        pts[i + 1] = shiftP(pts[i + 1]);
      }
      return { ...d, pts };
    }
  }
}
