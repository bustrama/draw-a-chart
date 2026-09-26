import type { TimeframeId } from '../market/types';

/**
 * Drawing data model. Everything is stored in chart space (absolute time in Unix ms + price),
 * never in pixels or logical bar indices, so drawings survive panning, zooming, resizing,
 * history loading and (later) display on other timeframes.
 */

export interface ChartKey {
  readonly provider: string;
  readonly symbol: string;
  readonly timeframe: TimeframeId;
}

export function chartKeyString(k: ChartKey): string {
  return `${k.provider}:${k.symbol}:${k.timeframe}`;
}

export interface StrokeStyle {
  readonly color: string;
  /** Nominal stroke diameter in CSS px (at pressure 0.5 for pressure-sensitive strokes). */
  readonly width: number;
}

interface DrawingBase {
  readonly id: string;
  readonly style: StrokeStyle;
  /** Client wall-clock time of creation (ms); used for stable paint order. */
  readonly createdAt: number;
}

/**
 * Freehand ink. Each point is anchored independently, so the stroke stays glued to the candles
 * it was drawn over and deforms with non-uniform zoom exactly like the price action does.
 */
export interface InkDrawing extends DrawingBase {
  readonly kind: 'ink';
  /** Flat triples: [time, price, pressure, time, price, pressure, ...]. */
  readonly pts: readonly number[];
}

/** Straight segment between two chart coordinates (QuickShape result or explicit line). */
export interface LineDrawing extends DrawingBase {
  readonly kind: 'line';
  readonly t1: number;
  readonly p1: number;
  readonly t2: number;
  readonly p2: number;
}

/**
 * Handwriting glyph. Rigid shape attached to one chart anchor; all glyphs of a note share the
 * same `group`, anchor and `ref`, so a note moves with the chart, scales uniformly within
 * limits, and never becomes unreadable through non-uniform stretching.
 */
export interface GlyphDrawing extends DrawingBase {
  readonly kind: 'glyph';
  readonly group: string;
  /** Anchor time (ms) and price. */
  readonly at: number;
  readonly ap: number;
  /** Horizontal chart scale (CSS px per ms) at the time the note was written. */
  readonly ref: number;
  /** Flat triples [dx, dy, pressure, ...]: CSS px offsets from the anchor at reference scale. */
  readonly pts: readonly number[];
}

/** Where a stamp's text sits: above a bar's high, below its low, or centred on its anchor. */
export type StampPlace = 'above' | 'below' | 'at';

/**
 * Wyckoff label stamp (an event such as `SC`, a Phase B wave, a phase). Drawn as text at a
 * constant size beside its anchor; the text is what is stored, so the label stays readable
 * (and machine-readable) without a vocabulary. See `stamps.ts`.
 */
export interface StampDrawing extends DrawingBase {
  readonly kind: 'stamp';
  readonly label: string;
  /** Anchor time (ms) and price: a bar's open time and its high or low for `above`/`below`. */
  readonly t: number;
  readonly p: number;
  readonly place: StampPlace;
}

export type Drawing = InkDrawing | LineDrawing | GlyphDrawing | StampDrawing;
export type DrawingKind = Drawing['kind'];

/** A key per kind: adding a kind to `Drawing` without adding it here does not compile. */
const KINDS: Record<DrawingKind, true> = { ink: true, line: true, glyph: true, stamp: true };

/**
 * Every kind this app version understands. Rows of other kinds (from a newer version) are
 * skipped; when this list grows, devices pull their charts in full again (`pullCursorKey`).
 */
export const DRAWING_KINDS = Object.keys(KINDS) as readonly DrawingKind[];

export const MAX_STAMP_LABEL = 24;

/** Uniform glyph scale for the current zoom: damped (square root) and clamped for legibility. */
export const GLYPH_SCALE_MIN = 0.5;
export const GLYPH_SCALE_MAX = 2;

export function glyphScale(ref: number, pxPerMsNow: number): number {
  if (!(ref > 0) || !(pxPerMsNow > 0)) return 1;
  const s = Math.sqrt(pxPerMsNow / ref);
  return Math.min(GLYPH_SCALE_MAX, Math.max(GLYPH_SCALE_MIN, s));
}

/** Rounds values to keep persisted JSON compact without losing visible precision. */
export function quantizeTime(t: number): number {
  return Math.round(t);
}

export function quantizePrice(p: number): number {
  return Number(p.toPrecision(10));
}

export function quantizePressure(p: number): number {
  return Math.round(p * 1000) / 1000;
}

export function quantizePx(v: number): number {
  return Math.round(v * 100) / 100;
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

/**
 * Validates untrusted drawing data (IndexedDB, sync server rows, live payloads).
 * Returns null instead of throwing so one corrupt row cannot break rendering.
 */
export function parseDrawing(value: unknown): Drawing | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || v.id.length === 0 || v.id.length > 64) return null;
  if (typeof v.createdAt !== 'number' || !Number.isFinite(v.createdAt)) return null;
  const style = v.style as Record<string, unknown> | undefined;
  if (typeof style !== 'object' || style === null) return null;
  if (typeof style.color !== 'string' || !HEX_COLOR.test(style.color)) return null;
  if (typeof style.width !== 'number' || !(style.width > 0 && style.width <= 64)) return null;
  const base = { id: v.id, createdAt: v.createdAt, style: { color: style.color, width: style.width } };

  switch (v.kind) {
    case 'ink': {
      if (!isFiniteTriples(v.pts)) return null;
      return { ...base, kind: 'ink', pts: v.pts };
    }
    case 'line': {
      const nums = [v.t1, v.p1, v.t2, v.p2];
      if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
      return { ...base, kind: 'line', t1: v.t1 as number, p1: v.p1 as number, t2: v.t2 as number, p2: v.p2 as number };
    }
    case 'glyph': {
      if (typeof v.group !== 'string' || v.group.length === 0 || v.group.length > 64) return null;
      const nums = [v.at, v.ap, v.ref];
      if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
      if (!((v.ref as number) > 0)) return null;
      if (!isFiniteTriples(v.pts)) return null;
      return {
        ...base,
        kind: 'glyph',
        group: v.group,
        at: v.at as number,
        ap: v.ap as number,
        ref: v.ref as number,
        pts: v.pts,
      };
    }
    case 'stamp': {
      if (!isStampLabel(v.label)) return null;
      if (typeof v.t !== 'number' || !Number.isFinite(v.t) || typeof v.p !== 'number' || !Number.isFinite(v.p)) return null;
      if (v.place !== 'above' && v.place !== 'below' && v.place !== 'at') return null;
      return { ...base, kind: 'stamp', label: v.label, t: v.t, p: v.p, place: v.place };
    }
    default:
      return null;
  }
}

/**
 * A short single line of text: 1-24 characters, no control or invisible formatting characters
 * (bidi overrides, zero-width spaces) and no line or paragraph separators.
 */
function isStampLabel(label: unknown): label is string {
  return typeof label === 'string' && label.length > 0 && label.length <= MAX_STAMP_LABEL && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(label);
}

const MAX_POINTS = 20_000;

function isFiniteTriples(pts: unknown): pts is number[] {
  if (!Array.isArray(pts) || pts.length === 0 || pts.length % 3 !== 0 || pts.length > MAX_POINTS * 3) return false;
  for (const n of pts) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return false;
  }
  return true;
}

/** Stable paint order: creation time, then id. */
export function compareDrawings(a: Drawing, b: Drawing): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
