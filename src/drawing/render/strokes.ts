import { getStroke } from 'perfect-freehand';
import { LinearPriceMapping, type Viewport } from '../../chart/viewport';
import { glyphScale, type Drawing, type GlyphDrawing, type InkDrawing, type LineDrawing, type StampDrawing } from '../model';
import { STAMP, stampBox } from '../stamps';

/**
 * Rendering of drawings in pane-local CSS px. Used by both the chart primitive (committed
 * drawings) and the live overlay (stroke in progress) so a stroke looks identical before and
 * after it is committed.
 */

export const INK_OPTIONS = {
  thinning: 0.55,
  smoothing: 0.5,
  streamline: 0.3,
} as const;

export type ScreenPoint = [x: number, y: number, pressure: number];

export function inkOutline(points: readonly ScreenPoint[], size: number, complete: boolean): number[][] {
  return getStroke(points as unknown as number[][], {
    size,
    ...INK_OPTIONS,
    simulatePressure: false,
    last: complete,
  });
}

export function fillOutline(ctx: CanvasRenderingContext2D, outline: readonly number[][]): void {
  if (outline.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < outline.length; i++) ctx.lineTo(outline[i][0], outline[i][1]);
  ctx.closePath();
  ctx.fill();
}

export function outlineToPath(outline: readonly number[][]): Path2D {
  const path = new Path2D();
  if (outline.length < 2) return path;
  path.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < outline.length; i++) path.lineTo(outline[i][0], outline[i][1]);
  path.closePath();
  return path;
}

// ---- per-drawing caches (drawings are immutable, so identity keys are safe) ----------------

interface DataBounds {
  tMin: number;
  tMax: number;
  pMin: number;
  pMax: number;
}

const boundsCache = new WeakMap<Drawing, DataBounds>();

/** Chart-space bounds of ink/line drawings (glyph bounds depend on zoom and are computed separately). */
export function dataBounds(d: InkDrawing | LineDrawing): DataBounds {
  let b = boundsCache.get(d);
  if (b) return b;
  if (d.kind === 'line') {
    b = { tMin: Math.min(d.t1, d.t2), tMax: Math.max(d.t1, d.t2), pMin: Math.min(d.p1, d.p2), pMax: Math.max(d.p1, d.p2) };
  } else {
    b = { tMin: Infinity, tMax: -Infinity, pMin: Infinity, pMax: -Infinity };
    for (let i = 0; i < d.pts.length; i += 3) {
      const t = d.pts[i];
      const p = d.pts[i + 1];
      if (t < b.tMin) b.tMin = t;
      if (t > b.tMax) b.tMax = t;
      if (p < b.pMin) b.pMin = p;
      if (p > b.pMax) b.pMax = p;
    }
  }
  boundsCache.set(d, b);
  return b;
}

interface LocalBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const glyphCache = new WeakMap<GlyphDrawing, { path: Path2D; bounds: LocalBounds }>();

/** Outline of a glyph in its local (anchor-relative, reference-scale) space, computed once. */
export function glyphShape(d: GlyphDrawing): { path: Path2D; bounds: LocalBounds } {
  let g = glyphCache.get(d);
  if (g) return g;
  const pts: ScreenPoint[] = [];
  const bounds: LocalBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (let i = 0; i < d.pts.length; i += 3) {
    const x = d.pts[i];
    const y = d.pts[i + 1];
    pts.push([x, y, d.pts[i + 2]]);
    if (x < bounds.minX) bounds.minX = x;
    if (x > bounds.maxX) bounds.maxX = x;
    if (y < bounds.minY) bounds.minY = y;
    if (y > bounds.maxY) bounds.maxY = y;
  }
  const pad = d.style.width;
  bounds.minX -= pad;
  bounds.minY -= pad;
  bounds.maxX += pad;
  bounds.maxY += pad;
  g = { path: outlineToPath(inkOutline(pts, d.style.width, true)), bounds };
  glyphCache.set(d, g);
  return g;
}

const logicalCache = new WeakMap<InkDrawing, { version: number; logicals: Float64Array }>();

/** Fractional logical index of every ink point, cached per time-index version. */
function inkLogicals(d: InkDrawing, v: Viewport): Float64Array {
  const c = logicalCache.get(d);
  if (c && c.version === v.timeIndex.version) return c.logicals;
  const n = d.pts.length / 3;
  const logicals = new Float64Array(n);
  for (let i = 0; i < n; i++) logicals[i] = v.timeIndex.timeToLogical(d.pts[i * 3]);
  logicalCache.set(d, { version: v.timeIndex.version, logicals });
  return logicals;
}

/** Screen points of an ink drawing under the given viewport. */
export function inkScreenPoints(d: InkDrawing, v: Viewport): ScreenPoint[] {
  const logicals = inkLogicals(d, v);
  const out: ScreenPoint[] = new Array(logicals.length);
  for (let i = 0; i < logicals.length; i++) {
    out[i] = [v.logicalToX(logicals[i]), v.priceToY(d.pts[i * 3 + 1]), d.pts[i * 3 + 2]];
  }
  return out;
}

/** Screen points of a glyph (anchor + uniform scale). */
export function glyphScreenPoints(d: GlyphDrawing, v: Viewport): ScreenPoint[] {
  const ax = v.timeToX(d.at);
  const ay = v.priceToY(d.ap);
  const k = glyphScale(d.ref, v.pxPerMs);
  const out: ScreenPoint[] = [];
  for (let i = 0; i < d.pts.length; i += 3) out.push([ax + d.pts[i] * k, ay + d.pts[i + 1] * k, d.pts[i + 2]]);
  return out;
}

export interface ScreenBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Conservative screen bounding box of a drawing under the viewport. */
export function screenBox(d: Drawing, v: Viewport): ScreenBox {
  if (d.kind === 'stamp') return stampBox(d.label, d.place, v.timeToX(d.t), v.priceToY(d.p));
  if (d.kind === 'glyph') {
    const { bounds } = glyphShape(d);
    const ax = v.timeToX(d.at);
    const ay = v.priceToY(d.ap);
    const k = glyphScale(d.ref, v.pxPerMs);
    return { minX: ax + bounds.minX * k, minY: ay + bounds.minY * k, maxX: ax + bounds.maxX * k, maxY: ay + bounds.maxY * k };
  }
  const b = dataBounds(d);
  const x1 = v.timeToX(b.tMin);
  const x2 = v.timeToX(b.tMax);
  const y1 = v.priceToY(b.pMin);
  const y2 = v.priceToY(b.pMax);
  const pad = d.style.width;
  return {
    minX: Math.min(x1, x2) - pad,
    maxX: Math.max(x1, x2) + pad,
    minY: Math.min(y1, y2) - pad,
    maxY: Math.max(y1, y2) + pad,
  };
}

export function isOnScreen(box: ScreenBox, v: Viewport): boolean {
  return box.maxX >= 0 && box.minX <= v.width && box.maxY >= 0 && box.minY <= v.height;
}

export interface RenderOptions {
  readonly hidden?: ReadonlySet<string>;
  readonly alpha?: number;
}

interface InkPathCache {
  readonly path: Path2D;
  readonly version: number;
  /** Transform parameters the outline was computed with: x = x0 + L*bs, y = pa + pb*price. */
  readonly x0: number;
  readonly bs: number;
  readonly pa: number;
  readonly pb: number;
}

const inkPathCache = new WeakMap<InkDrawing, InkPathCache>();
/** Re-project a cached outline while the scales stay within this ratio; recompute beyond it. */
const INK_SCALE_TOLERANCE = 0.08;

/**
 * Draws chart-anchored ink. For a linear price scale the pane transform is affine in
 * (logical, price), so between two frames a stroke's screen outline maps exactly by one
 * ctx.transform: pixel-exact while panning, and within a few percent of stroke width while
 * zooming (the outline is recomputed once scales drift more than 8 %).
 */
function drawInk(ctx: CanvasRenderingContext2D, d: InkDrawing, v: Viewport): void {
  ctx.fillStyle = d.style.color;
  const lin = v.price instanceof LinearPriceMapping ? v.price : null;
  if (!lin) {
    fillOutline(ctx, inkOutline(inkScreenPoints(d, v), d.style.width, true));
    return;
  }
  let c = inkPathCache.get(d);
  const reusable =
    c !== undefined &&
    c.version === v.timeIndex.version &&
    Math.abs(v.barSpacing / c.bs - 1) <= INK_SCALE_TOLERANCE &&
    Math.abs(lin.b / c.pb - 1) <= INK_SCALE_TOLERANCE;
  if (!reusable) {
    c = {
      path: outlineToPath(inkOutline(inkScreenPoints(d, v), d.style.width, true)),
      version: v.timeIndex.version,
      x0: v.x0,
      bs: v.barSpacing,
      pa: lin.a,
      pb: lin.b,
    };
    inkPathCache.set(d, c);
  }
  const cache = c as InkPathCache;
  const sx = v.barSpacing / cache.bs;
  const sy = lin.b / cache.pb;
  ctx.save();
  ctx.transform(sx, 0, 0, sy, v.x0 - cache.x0 * sx, lin.a - cache.pa * sy);
  ctx.fill(cache.path);
  ctx.restore();
}

export function renderDrawing(ctx: CanvasRenderingContext2D, d: Drawing, v: Viewport): void {
  switch (d.kind) {
    case 'ink': {
      drawInk(ctx, d, v);
      return;
    }
    case 'line': {
      ctx.strokeStyle = d.style.color;
      ctx.lineWidth = d.style.width;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(v.timeToX(d.t1), v.priceToY(d.p1));
      ctx.lineTo(v.timeToX(d.t2), v.priceToY(d.p2));
      ctx.stroke();
      return;
    }
    case 'glyph': {
      const { path } = glyphShape(d);
      const k = glyphScale(d.ref, v.pxPerMs);
      ctx.save();
      ctx.translate(v.timeToX(d.at), v.priceToY(d.ap));
      ctx.scale(k, k);
      ctx.fillStyle = d.style.color;
      ctx.fill(path);
      ctx.restore();
      return;
    }
    case 'stamp': {
      drawStamp(ctx, d, v);
      return;
    }
  }
}

/**
 * A stamp beside a bar is its text with a halo and a tick pointing at the high (or low); a
 * centred stamp (a phase) is its text in an outlined box. Constant size at every zoom.
 */
function drawStamp(ctx: CanvasRenderingContext2D, d: StampDrawing, v: Viewport): void {
  const ax = v.timeToX(d.t);
  const ay = v.priceToY(d.p);
  ctx.save();
  ctx.font = STAMP.font;
  ctx.textAlign = 'center';
  ctx.lineJoin = 'round';
  let textY = ay;
  if (d.place === 'at') {
    const box = stampBox(d.label, 'at', ax, ay);
    ctx.fillStyle = STAMP.plate;
    ctx.strokeStyle = d.style.color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const [x, y, w, h] = [box.minX + 0.5, box.minY + 0.5, box.maxX - box.minX - 1, box.maxY - box.minY - 1];
    if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, 4);
    else ctx.rect(x, y, w, h);
    ctx.fill();
    ctx.stroke();
    ctx.textBaseline = 'middle';
  } else {
    const dir = d.place === 'above' ? -1 : 1;
    ctx.strokeStyle = d.style.color;
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(ax, ay + dir * STAMP.gap);
    ctx.lineTo(ax, ay + dir * (STAMP.gap + STAMP.tick));
    ctx.stroke();
    ctx.textBaseline = d.place === 'above' ? 'bottom' : 'top';
    textY = ay + dir * (STAMP.gap + STAMP.tick + STAMP.textGap);
    ctx.strokeStyle = STAMP.plate;
    ctx.lineWidth = STAMP.halo;
    ctx.strokeText(d.label, ax, textY);
  }
  ctx.fillStyle = d.style.color;
  ctx.fillText(d.label, ax, textY);
  ctx.restore();
}

/** Renders all visible drawings (culled against the pane). Returns the number drawn. */
export function renderDrawings(ctx: CanvasRenderingContext2D, drawings: readonly Drawing[], v: Viewport, opts: RenderOptions = {}): number {
  let drawn = 0;
  ctx.save();
  if (opts.alpha !== undefined) ctx.globalAlpha = opts.alpha;
  for (const d of drawings) {
    if (opts.hidden?.has(d.id)) continue;
    if (!isOnScreen(screenBox(d, v), v)) continue;
    renderDrawing(ctx, d, v);
    drawn++;
  }
  ctx.restore();
  return drawn;
}
