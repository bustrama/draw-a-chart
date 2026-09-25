import { describe, expect, it } from 'vitest';
import { NEW_YORK, SessionCalendar, sessionsFromCalendar } from '../../shared/sessions.ts';
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

describe('TimeIndex with trading sessions', () => {
  const M5 = 5 * 60_000;
  const z = (iso: string) => Date.parse(iso);
  // Fri 25 and Mon 28 Sep 2026, 9:30-16:00 New York (13:30-20:00Z).
  const cal = new SessionCalendar(
    sessionsFromCalendar(
      [
        { date: '2026-09-25', open: '09:30', close: '16:00' },
        { date: '2026-09-28', open: '09:30', close: '16:00' },
        { date: '2026-09-29', open: '09:30', close: '16:00' },
      ],
      NEW_YORK,
    ),
  );
  const clock = cal.clock(M5);
  const fridayClose = Array.from({ length: 6 }, (_, i) => z('2026-09-25T19:30:00Z') + i * M5); // 19:30 … 19:55

  it('projects the future area onto the next session', () => {
    const idx = TimeIndex.from(fridayClose, clock, 1);
    expect(idx.logicalToTime(6)).toBe(z('2026-09-28T13:30:00Z')); // one bar after Friday's close: Monday's open
    expect(idx.timeToLogical(z('2026-09-28T13:40:00Z'))).toBeCloseTo(8, 12);
    // The weekend compresses into the space between the last bar and Monday's first.
    expect(idx.timeToLogical(z('2026-09-26T12:00:00Z'))).toBeGreaterThan(5);
    expect(idx.timeToLogical(z('2026-09-26T12:00:00Z'))).toBeLessThan(6);
  });

  it('keeps future-area anchors in place when the next session opens', () => {
    const before = TimeIndex.from(fridayClose, clock, 1);
    const monday = [z('2026-09-28T13:30:00Z'), z('2026-09-28T13:35:00Z'), z('2026-09-28T13:40:00Z')];
    const after = TimeIndex.from([...fridayClose, ...monday], clock, 2);
    for (const t of [z('2026-09-26T12:00:00Z'), z('2026-09-28T13:52:30Z'), z('2026-09-28T19:00:00Z'), z('2026-09-29T15:00:00Z')]) {
      expect(after.timeToLogical(t)).toBeCloseTo(before.timeToLogical(t), 9);
    }
  });

  it('round-trips in the future area, also past the generated bars', () => {
    const idx = TimeIndex.from(fridayClose, clock, 1);
    for (const l of [5.5, 6, 7.25, 100.5, 1400, 1600.75, 5000]) {
      expect(idx.timeToLogical(idx.logicalToTime(l))).toBeCloseTo(l, 6);
    }
    for (const t of [z('2026-09-27T00:00:00Z'), z('2026-09-29T19:59:00Z'), z('2027-06-01T00:00:00Z')]) {
      expect(idx.logicalToTime(idx.timeToLogical(t))).toBeCloseTo(t, 0);
    }
  });
});

describe('TimeIndex far into the future', () => {
  it('keeps points thousands of bars ahead on the session bars (the table grows on demand)', async () => {
    const { mockUsCalendar } = await import('../market/mock/MockProvider');
    const { stepForward } = await import('../../shared/sessions.ts');
    const clock = mockUsCalendar(2026, 2027).clock(60_000);
    const last = Date.parse('2026-09-25T19:59:00Z'); // Friday 15:59 New York
    const idx = TimeIndex.from([last - 60_000, last], clock, 1);
    for (const ahead of [1400, 2000, 7000]) {
      const t = stepForward(clock, last, ahead);
      expect(idx.logicalToTime(1 + ahead)).toBe(t);
      expect(idx.timeToLogical(t)).toBeCloseTo(1 + ahead, 9);
    }
  });
});
