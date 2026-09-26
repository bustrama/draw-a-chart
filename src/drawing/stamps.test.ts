import { describe, expect, it } from 'vitest';
import { TimeIndex } from '../chart/timeIndex';
import { LinearPriceMapping, Viewport } from '../chart/viewport';
import { MAX_STAMP_LABEL, parseDrawing } from './model';
import { DEFAULT_STAMP, placeStamp, STAMP, STAMP_LABELS, stampBox, stampLabel, stampSnap, stampTextWidth, type BarExtent } from './stamps';

const H = 3_600_000;
const T0 = Date.UTC(2026, 0, 1);

/** 10 hourly bars; bar i is centred at x = 100 + 20 i, its high is 150 + i and its low 140 + i. */
function makeViewport(): Viewport {
  const timeIndex = TimeIndex.from(
    Array.from({ length: 10 }, (_, i) => T0 + i * H),
    H,
    1,
  );
  const price = LinearPriceMapping.fromSamples(100, 400, 200, 0); // y = 800 - 4 * price
  if (!price) throw new Error('mapping');
  return new Viewport({ x0: 100, barSpacing: 20, width: 400, height: 400, timeIndex, price });
}

const bars = (i: number): BarExtent => ({ high: 150 + i, low: 140 + i });
const barX = (i: number) => 100 + 20 * i;

describe('stamp vocabulary', () => {
  it('has his 16 events, the three B waves and the five phases, with unique texts', () => {
    const count = (g: string) => STAMP_LABELS.filter((l) => l.group === g).length;
    expect(count('accumulation') + count('distribution')).toBe(16);
    expect(count('waves')).toBe(3);
    expect(count('phases')).toBe(5);
    expect(new Set(STAMP_LABELS.map((l) => l.text)).size).toBe(STAMP_LABELS.length);
    expect(DEFAULT_STAMP).toBe('PS');
  });

  it('only has labels that survive storage', () => {
    for (const l of STAMP_LABELS) {
      expect(l.text.length).toBeLessThanOrEqual(MAX_STAMP_LABEL);
      const d = parseDrawing({ id: 'x', createdAt: 1, style: { color: '#ffffff', width: 2 }, kind: 'stamp', label: l.text, t: 1, p: 1, place: 'at' });
      expect(d?.kind).toBe('stamp');
    }
  });

  it('snaps events and waves to bar extremes, phases by time only', () => {
    expect(stampSnap('SC')).toBe('extreme');
    expect(stampSnap('3rd B')).toBe('extreme');
    expect(stampSnap('Phase C')).toBe('time');
    expect(stampLabel('Phase C')?.chip).toBe('C');
    // Text from a newer version: treated like an event.
    expect(stampLabel('mSOW')).toBeUndefined();
    expect(stampSnap('mSOW')).toBe('extreme');
  });
});

describe('placeStamp', () => {
  const v = makeViewport();

  it('puts an event above the high when the pen is above the bar middle', () => {
    // Bar 3: high 153 (y 188), low 143 (y 228), middle y 208.
    expect(placeStamp('extreme', barX(3) + 6, 150, v, bars)).toEqual({ t: T0 + 3 * H, p: 153, place: 'above' });
    expect(placeStamp('extreme', barX(3), 207, v, bars)).toEqual({ t: T0 + 3 * H, p: 153, place: 'above' });
  });

  it('puts an event below the low when the pen is below the bar middle', () => {
    expect(placeStamp('extreme', barX(3) - 6, 209, v, bars)).toEqual({ t: T0 + 3 * H, p: 143, place: 'below' });
    expect(placeStamp('extreme', barX(3), 390, v, bars)).toEqual({ t: T0 + 3 * H, p: 143, place: 'below' });
  });

  it('takes the bar with the nearest centre', () => {
    expect(placeStamp('extreme', barX(3) + 11, 100, v, bars).t).toBe(T0 + 4 * H);
    expect(placeStamp('extreme', barX(3) + 9, 100, v, bars).t).toBe(T0 + 3 * H);
  });

  it('puts a phase at the bar time and the pen price', () => {
    expect(placeStamp('time', barX(5) + 7, 300, v, bars)).toEqual({ t: T0 + 5 * H, p: 125, place: 'at' });
  });

  it('leaves a stamp where it was placed off the bars', () => {
    // Future area: two bars after the last one.
    expect(placeStamp('extreme', barX(11), 300, v, bars)).toEqual({ t: T0 + 11 * H, p: 125, place: 'at' });
    // Before the first bar.
    expect(placeStamp('extreme', barX(-2), 300, v, bars)).toEqual({ t: T0 - 2 * H, p: 125, place: 'at' });
    // A bar without prices.
    expect(placeStamp('extreme', barX(4), 100, v, () => null)).toEqual({ t: T0 + 4 * H, p: 175, place: 'at' });
  });
});

describe('stampBox', () => {
  it('spans the text and the tick above a high', () => {
    const w = stampTextWidth('SC');
    const box = stampBox('SC', 'above', 50, 100);
    expect(box.maxY).toBe(100 - STAMP.gap);
    expect(box.minY).toBeLessThan(100 - STAMP.gap - STAMP.tick - STAMP.fontPx);
    expect(box.maxX - box.minX).toBeCloseTo(w + STAMP.halo, 9);
    expect((box.minX + box.maxX) / 2).toBe(50);
  });

  it('mirrors below a low', () => {
    const above = stampBox('Spring', 'above', 50, 100);
    const below = stampBox('Spring', 'below', 50, 100);
    expect(below.minY - 100).toBeCloseTo(100 - above.maxY, 9);
    expect(below.maxY - 100).toBeCloseTo(100 - above.minY, 9);
  });

  it('centres a placed phase on its anchor', () => {
    const box = stampBox('Phase C', 'at', 50, 100);
    expect((box.minX + box.maxX) / 2).toBe(50);
    expect((box.minY + box.maxY) / 2).toBe(100);
    expect(box.maxX - box.minX).toBeGreaterThan(stampTextWidth('Phase C'));
  });

  it('measures longer text as wider', () => {
    expect(stampTextWidth('UTAD')).toBeGreaterThan(stampTextWidth('UT'));
  });
});
