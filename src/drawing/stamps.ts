import { THEME } from '../chart/theme';
import type { Viewport } from '../chart/viewport';
import type { BBox } from './geometry';
import { quantizePrice, quantizeTime, type StampPlace } from './model';

/**
 * Wyckoff label stamps: the label strip's vocabulary and where a placed stamp lands.
 *
 * The vocabulary: the 16 Wyckoff events in cycle order, the three waves of Phase B, and the five
 * phases (the chip tooltips say what each phase does). A stamp stores its text, so labels outside
 * this list (from a newer version) still render.
 */

export type StampGroup = 'accumulation' | 'distribution' | 'waves' | 'phases';

/**
 * - `extreme`: the stamp goes to the bar under the pen, above its high or below its low;
 * - `time`: it goes to that bar's time and keeps the price where it was placed (phases).
 */
export type StampSnap = 'extreme' | 'time';

export interface StampLabel {
  /** Stored and shown on the chart. */
  readonly text: string;
  /** Shown on the strip's chip (a phase shows only its letter). */
  readonly chip: string;
  /** Full name: the chip's tooltip. */
  readonly name: string;
  readonly group: StampGroup;
  readonly snap: StampSnap;
}

function event(text: string, name: string, group: StampGroup): StampLabel {
  return { text, chip: text, name, group, snap: 'extreme' };
}

function wave(n: string, name: string): StampLabel {
  return { text: `${n} B`, chip: `${n} B`, name, group: 'waves', snap: 'extreme' };
}

function phase(letter: string, name: string): StampLabel {
  return { text: `Phase ${letter}`, chip: letter, name: `Phase ${letter}: ${name}`, group: 'phases', snap: 'time' };
}

export const STAMP_LABELS: readonly StampLabel[] = [
  event('PS', 'Preliminary Support', 'accumulation'),
  event('SC', 'Selling Climax', 'accumulation'),
  event('AR', 'Automatic Rally (a reaction in distribution)', 'accumulation'),
  event('ST', 'Secondary Test', 'accumulation'),
  event('Spring', 'Spring (Phase C)', 'accumulation'),
  event('Test', 'Test (Phase C)', 'accumulation'),
  event('LPS', 'Last Point of Support', 'accumulation'),
  event('SOS', 'Sign of Strength', 'accumulation'),
  event('BU', 'Back-Up', 'accumulation'),
  event('JAC', 'Jump Across the Creek', 'accumulation'),
  event('PSY', 'Preliminary Supply', 'distribution'),
  event('BC', 'Buying Climax', 'distribution'),
  event('UT', 'Upthrust', 'distribution'),
  event('UTAD', 'Upthrust After Distribution (Phase C)', 'distribution'),
  event('SOW', 'Sign of Weakness', 'distribution'),
  event('LPSY', 'Last Point of Supply', 'distribution'),
  wave('1st', '1st wave of Phase B'),
  wave('2nd', '2nd wave of Phase B'),
  wave('3rd', '3rd wave of Phase B: leads into Phase C'),
  phase('A', 'Stopping the Previous Trend'),
  phase('B', 'Building the Cause'),
  phase('C', 'Testing the Cause'),
  phase('D', 'Trending Inside the Trading Range'),
  phase('E', 'Trending Out of the Trading Range'),
];

export const DEFAULT_STAMP = STAMP_LABELS[0].text;

const BY_TEXT = new Map(STAMP_LABELS.map((l) => [l.text, l]));

/** The vocabulary entry for a stamp's text (undefined for text this version does not know). */
export function stampLabel(text: string): StampLabel | undefined {
  return BY_TEXT.get(text);
}

/** How a stamp with this text snaps: phases by time, everything else to a bar's high or low. */
export function stampSnap(text: string): StampSnap {
  return stampLabel(text)?.snap ?? 'extreme';
}

/** High and low of a displayed bar. */
export interface BarExtent {
  readonly high: number;
  readonly low: number;
}

export interface StampAnchor {
  readonly t: number;
  readonly p: number;
  readonly place: StampPlace;
}

/**
 * Where a stamp placed at pane point (x, y) lands. The bar under the pen is the one with the
 * nearest centre. An event goes above that bar's high when the pen is above the bar's middle, and
 * below its low otherwise; a phase goes to the bar's time at the pen's price. Off the bars (the
 * future area, before the first bar) a stamp stays where it was placed.
 */
export function placeStamp(snap: StampSnap, x: number, y: number, v: Viewport, barAt: (index: number) => BarExtent | null): StampAnchor {
  const i = Math.round(v.xToLogical(x));
  const bar = i >= 0 && i < v.timeIndex.length ? barAt(i) : null;
  const price = quantizePrice(v.yToPrice(y));
  if (!bar) return { t: quantizeTime(v.xToTime(x)), p: price, place: 'at' };
  const t = v.timeIndex.timeAt(i);
  if (snap === 'time') return { t, p: price, place: 'at' };
  const middle = (v.priceToY(bar.high) + v.priceToY(bar.low)) / 2;
  return y <= middle ? { t, p: quantizePrice(bar.high), place: 'above' } : { t, p: quantizePrice(bar.low), place: 'below' };
}

/** Text and layout of a stamp on the chart, in CSS px (constant size at every zoom). */
export const STAMP = {
  fontPx: 12,
  font: `700 12px ${THEME.fontFamily}`,
  /** Beside a bar: gap from the high/low to the tick, tick length, gap from the tick to the text. */
  gap: 2,
  tick: 5,
  textGap: 2,
  /** Halo drawn around the text so it stays readable over candles and grid lines. */
  halo: 3,
  /** Halo and box fill: the chart background, slightly translucent. */
  plate: 'rgba(11, 14, 19, 0.85)',
  /** Padding of the box around a centred (`at`) stamp. */
  padX: 4,
  padY: 3,
} as const;

/** How far a stamp beside a bar reaches from the bar's high (or low), in CSS px. */
export const STAMP_REACH = STAMP.gap + STAMP.tick + STAMP.textGap + STAMP.fontPx + STAMP.halo / 2;

/** Vertical offset from a stamp's anchor to the middle of its text, in CSS px. */
export function stampTextOffset(place: StampPlace): number {
  const d = STAMP.gap + STAMP.tick + STAMP.textGap + STAMP.fontPx / 2;
  return place === 'above' ? -d : place === 'below' ? d : 0;
}

const widths = new Map<string, number>();
let measure: CanvasRenderingContext2D | null | undefined;

/** Width of a stamp's text in CSS px (estimated where there is no canvas, e.g. in unit tests). */
export function stampTextWidth(text: string): number {
  let w = widths.get(text);
  if (w !== undefined) return w;
  if (measure === undefined) measure = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  if (measure) {
    measure.font = STAMP.font;
    w = measure.measureText(text).width;
  } else {
    w = text.length * STAMP.fontPx * 0.62;
  }
  widths.set(text, w);
  return w;
}

/**
 * Screen box of a stamp whose anchor is at (ax, ay): its text with the halo, and beside a bar
 * the tick down (or up) to the high (or low) as well.
 */
export function stampBox(text: string, place: StampPlace, ax: number, ay: number): BBox {
  const w = stampTextWidth(text);
  const h = STAMP.fontPx;
  if (place === 'at') {
    const hw = w / 2 + STAMP.padX;
    const hh = h / 2 + STAMP.padY;
    return { minX: ax - hw, maxX: ax + hw, minY: ay - hh, maxY: ay + hh };
  }
  const hw = w / 2 + STAMP.halo / 2;
  return place === 'above'
    ? { minX: ax - hw, maxX: ax + hw, minY: ay - STAMP_REACH, maxY: ay - STAMP.gap }
    : { minX: ax - hw, maxX: ax + hw, minY: ay + STAMP.gap, maxY: ay + STAMP_REACH };
}
