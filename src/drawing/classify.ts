import { bboxHeight, bboxOf, bboxWidth, type BBox, type Pt } from './geometry';

/**
 * Automatic distinction between handwriting (rigid "glyph" strokes grouped into notes) and
 * drawing (freehand "ink" anchored point by point), so the user never selects a tool for it.
 *
 * Heuristics (all in screen CSS px at the time of writing):
 * - Letter-sized strokes are glyphs.
 * - Short-but-wide strokes with substantial horizontal back-tracking (loops of cursive words)
 *   are glyphs. Price paths, trend lines and boxes progress mostly monotonically in x.
 * - Everything else is ink.
 * A glyph joins the previous note if it follows quickly and nearby; otherwise it starts a note.
 */
export const HANDWRITING = {
  maxGlyphSizePx: 60,
  cursiveMaxHeightPx: 56,
  cursiveMaxWidthPx: 360,
  /** min(leftward, rightward) / max(leftward, rightward) horizontal travel. */
  cursiveBacktrackRatio: 0.25,
  /** Max pause between strokes of one note. */
  joinGapMs: 1600,
  /** Min line height used for proximity tests (tiny dots/commas should not shrink it). */
  minLineHeightPx: 22,
} as const;

export type StrokeClass = 'glyph' | 'ink';

export function classifyStroke(points: readonly Pt[], cfg = HANDWRITING): StrokeClass {
  if (points.length === 0) return 'ink';
  const box = bboxOf(points);
  const w = bboxWidth(box);
  const h = bboxHeight(box);
  if (Math.max(w, h) <= cfg.maxGlyphSizePx) return 'glyph';
  if (h <= cfg.cursiveMaxHeightPx && w <= cfg.cursiveMaxWidthPx && horizontalBacktrack(points) >= cfg.cursiveBacktrackRatio) {
    return 'glyph';
  }
  return 'ink';
}

/** Ratio of the smaller to the larger total horizontal travel direction (0 = monotonic in x). */
export function horizontalBacktrack(points: readonly Pt[], jitterPx = 0.75): number {
  let right = 0;
  let left = 0;
  let prev = points[0]?.x ?? 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - prev;
    if (Math.abs(dx) < jitterPx) continue;
    if (dx > 0) right += dx;
    else left -= dx;
    prev = points[i].x;
  }
  const max = Math.max(left, right);
  return max === 0 ? 0 : Math.min(left, right) / max;
}

export interface NoteContext {
  /** Screen bbox of the note's strokes (current view). */
  readonly box: BBox;
  /** Time the last stroke of the note ended (ms, same clock as stroke times). */
  readonly lastEndAt: number;
  /** Typical glyph height in the note. */
  readonly lineHeight: number;
}

/** Whether a new glyph stroke continues the given note. */
export function joinsNote(note: NoteContext, strokeBox: BBox, strokeStartAt: number, cfg = HANDWRITING): boolean {
  if (strokeStartAt - note.lastEndAt > cfg.joinGapMs) return false;
  const lh = Math.max(cfg.minLineHeightPx, note.lineHeight);
  const padX = 1.6 * lh;
  const padY = 1.2 * lh;
  const cx = (strokeBox.minX + strokeBox.maxX) / 2;
  const cy = (strokeBox.minY + strokeBox.maxY) / 2;
  return cx >= note.box.minX - padX && cx <= note.box.maxX + padX && cy >= note.box.minY - padY && cy <= note.box.maxY + padY;
}
