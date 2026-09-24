import { describe, expect, it } from 'vitest';
import { TimeIndex } from './timeIndex';

const H = 3_600_000;
const T0 = Date.UTC(2026, 0, 1);

function hourly(n: number, start = T0): number[] {
  return Array.from({ length: n }, (_, i) => start + i * H);
}

describe('TimeIndex', () => {
  it('maps bar open times to integer logical indices', () => {
    const idx = TimeIndex.from(hourly(5), H, 1);
    for (let i = 0; i < 5; i++) expect(idx.timeToLogical(T0 + i * H)).toBe(i);
  });

  it('interpolates between bars (positions between candles)', () => {
    const idx = TimeIndex.from(hourly(5), H, 1);
    expect(idx.timeToLogical(T0 + 2.25 * H)).toBeCloseTo(2.25, 12);
    expect(idx.logicalToTime(3.5)).toBe(T0 + 3.5 * H);
  });

  it('extrapolates into the future and the past with the nominal interval', () => {
    const idx = TimeIndex.from(hourly(5), H, 1);
    expect(idx.timeToLogical(T0 + 7.5 * H)).toBeCloseTo(7.5, 12);
    expect(idx.timeToLogical(T0 - 2 * H)).toBeCloseTo(-2, 12);
    expect(idx.logicalToTime(-3)).toBe(T0 - 3 * H);
    expect(idx.logicalToTime(10)).toBe(T0 + 10 * H);
  });

  it('compresses data gaps into the space between neighbouring bars', () => {
    // Bars at 0h, 1h, then a 10h gap, then 11h, 12h.
    const times = [T0, T0 + H, T0 + 11 * H, T0 + 12 * H];
    const idx = TimeIndex.from(times, H, 1);
    expect(idx.timeToLogical(T0 + 11 * H)).toBe(2);
    // Middle of the gap maps half way between logical 1 and 2.
    expect(idx.timeToLogical(T0 + 6 * H)).toBeCloseTo(1.5, 12);
    expect(idx.logicalToTime(1.5)).toBe(T0 + 6 * H);
  });

  it('round-trips arbitrary times and logicals exactly (within float precision)', () => {
    const times = [T0, T0 + H, T0 + 2 * H, T0 + 9 * H, T0 + 10 * H];
    const idx = TimeIndex.from(times, H, 1);
    for (const t of [T0 - 5.3 * H, T0 + 0.1, T0 + 1.9 * H, T0 + 5 * H, T0 + 9.99 * H, T0 + 40 * H]) {
      expect(idx.logicalToTime(idx.timeToLogical(t))).toBeCloseTo(t, 3);
    }
    for (const l of [-4.2, 0, 0.5, 2.75, 3.999, 4, 17.3]) {
      expect(idx.timeToLogical(idx.logicalToTime(l))).toBeCloseTo(l, 9);
    }
  });

  it('keeps absolute times stable when older history is prepended', () => {
    const recent = TimeIndex.from(hourly(10, T0 + 100 * H), H, 1);
    const withHistory = TimeIndex.from(hourly(110, T0), H, 2);
    const t = T0 + 104.4 * H;
    // Logical index shifts by exactly the number of prepended bars, time stays the anchor.
    expect(withHistory.timeToLogical(t) - recent.timeToLogical(t)).toBeCloseTo(100, 9);
  });

  it('keeps future-area anchors visually stable when a new bar arrives', () => {
    const before = TimeIndex.from(hourly(10), H, 1);
    const after = TimeIndex.from(hourly(11), H, 2);
    const future = T0 + 14.5 * H;
    expect(after.timeToLogical(future)).toBeCloseTo(before.timeToLogical(future), 9);
  });

  it('rejects unsorted input and reports empty indices as NaN', () => {
    expect(() => TimeIndex.from([T0 + H, T0], H, 1)).toThrow();
    expect(Number.isNaN(TimeIndex.EMPTY.timeToLogical(T0))).toBe(true);
    expect(Number.isNaN(TimeIndex.EMPTY.logicalToTime(1))).toBe(true);
  });
});
