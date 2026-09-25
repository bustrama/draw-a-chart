import { describe, expect, it } from 'vitest';
import { barsBetween, DAY_MS, fixedClock, NEW_YORK, SessionCalendar, sessionsFromCalendar, stepBack, stepForward, zonedDate, zonedTime } from './sessions.ts';

const MIN = 60_000;
const H = 60 * MIN;
const z = (iso: string) => Date.parse(iso);

// Thu 24 Sep, Fri 25 Sep, Mon 28 Sep 2026 (EDT: 9:30-16:00 = 13:30-20:00Z), and the day after
// Thanksgiving (Fri 27 Nov 2026, EST, early close 13:00 = 18:00Z).
const ROWS = [
  { date: '2026-09-24', open: '09:30', close: '16:00' },
  { date: '2026-09-25', open: '09:30', close: '16:00' },
  { date: '2026-09-28', open: '09:30', close: '16:00' },
  { date: '2026-11-27', open: '09:30', close: '13:00' },
];
const cal = new SessionCalendar(sessionsFromCalendar(ROWS, NEW_YORK));

describe('time zones', () => {
  it('converts New York wall times across daylight saving changes', () => {
    expect(zonedTime('2026-09-24', '09:30', NEW_YORK)).toBe(z('2026-09-24T13:30:00Z'));
    expect(zonedTime('2026-01-15', '09:30', NEW_YORK)).toBe(z('2026-01-15T14:30:00Z'));
    // DST starts Sun 8 Mar 2026 and ends Sun 1 Nov 2026.
    expect(zonedTime('2026-03-06', '09:30', NEW_YORK)).toBe(z('2026-03-06T14:30:00Z'));
    expect(zonedTime('2026-03-09', '09:30', NEW_YORK)).toBe(z('2026-03-09T13:30:00Z'));
    expect(zonedTime('2026-10-30', '16:00', NEW_YORK)).toBe(z('2026-10-30T20:00:00Z'));
    expect(zonedTime('2026-11-02', '16:00', NEW_YORK)).toBe(z('2026-11-02T21:00:00Z'));
    expect(zonedTime('2026-09-24', '00:00', NEW_YORK)).toBe(z('2026-09-24T04:00:00Z'));
  });

  it('gives the local date of an instant', () => {
    expect(zonedDate(z('2026-09-25T03:59:00Z'), NEW_YORK)).toBe('2026-09-24');
    expect(zonedDate(z('2026-09-25T04:00:00Z'), NEW_YORK)).toBe('2026-09-25');
    expect(zonedDate(z('2026-01-05T12:00:00Z'), 'UTC')).toBe('2026-01-05');
  });

  it('builds sessions from exchange calendar rows', () => {
    expect(cal.sessions[0]).toEqual({ day: z('2026-09-24T04:00:00Z'), open: z('2026-09-24T13:30:00Z'), close: z('2026-09-24T20:00:00Z') });
    expect(cal.sessions[3]).toEqual({ day: z('2026-11-27T05:00:00Z'), open: z('2026-11-27T14:30:00Z'), close: z('2026-11-27T18:00:00Z') });
  });

  it('rejects malformed or unsorted sessions', () => {
    const [a, b] = cal.sessions;
    expect(() => new SessionCalendar([b, a])).toThrow();
    expect(() => new SessionCalendar([{ ...a, close: a.open }])).toThrow();
  });
});

describe('intraday clock', () => {
  const m5 = cal.clock(5 * MIN);
  const h1 = cal.clock(H);
  const h4 = cal.clock(4 * H);

  it('buckets regular-hours times and rejects the rest', () => {
    expect(m5.bucket(z('2026-09-24T13:37:00Z'))).toBe(z('2026-09-24T13:35:00Z'));
    expect(m5.bucket(z('2026-09-24T13:29:59Z'))).toBeNull(); // pre-market
    expect(m5.bucket(z('2026-09-24T20:00:00Z'))).toBeNull(); // the close is exclusive
    expect(h1.bucket(z('2026-09-24T19:45:00Z'))).toBe(z('2026-09-24T19:30:00Z'));
    expect(h4.bucket(z('2026-09-24T17:29:00Z'))).toBe(z('2026-09-24T13:30:00Z'));
    expect(h4.bucket(z('2026-09-24T17:30:00Z'))).toBe(z('2026-09-24T17:30:00Z'));
  });

  it('aligns hourly bars to the open and cuts the last bar at the close', () => {
    const bars: number[] = [];
    for (let t = z('2026-09-24T13:30:00Z'); t < z('2026-09-25T00:00:00Z'); t = h1.next(t)) bars.push(t);
    expect(bars.map((t) => new Date(t).toISOString().slice(11, 16))).toEqual(['13:30', '14:30', '15:30', '16:30', '17:30', '18:30', '19:30']);
    expect(h1.end(z('2026-09-24T19:30:00Z'))).toBe(z('2026-09-24T20:00:00Z'));
    expect(h1.end(z('2026-09-24T18:30:00Z'))).toBe(z('2026-09-24T19:30:00Z'));
    expect(h4.end(z('2026-09-24T17:30:00Z'))).toBe(z('2026-09-24T20:00:00Z'));
  });

  it('steps over nights, weekends and holidays', () => {
    expect(m5.next(z('2026-09-25T19:55:00Z'))).toBe(z('2026-09-28T13:30:00Z'));
    expect(m5.prev(z('2026-09-28T13:30:00Z'))).toBe(z('2026-09-25T19:55:00Z'));
    expect(m5.next(z('2026-09-26T12:00:00Z'))).toBe(z('2026-09-28T13:30:00Z')); // Saturday
    expect(m5.prev(z('2026-09-26T12:00:00Z'))).toBe(z('2026-09-25T19:55:00Z'));
    expect(h1.next(z('2026-09-28T19:30:00Z'))).toBe(z('2026-11-27T14:30:00Z')); // the next calendar day
    expect(h1.prev(z('2026-11-27T14:30:00Z'))).toBe(z('2026-09-28T19:30:00Z'));
  });

  it('handles early closes', () => {
    const bars: number[] = [];
    for (let t = z('2026-11-27T14:30:00Z'); t < z('2026-11-27T18:00:00Z'); t = h1.next(t)) bars.push(t);
    expect(bars.map((t) => new Date(t).toISOString().slice(11, 16))).toEqual(['14:30', '15:30', '16:30', '17:30']);
    expect(h1.end(z('2026-11-27T17:30:00Z'))).toBe(z('2026-11-27T18:00:00Z'));
    expect(h4.next(z('2026-11-27T14:30:00Z'))).toBeGreaterThan(z('2026-11-27T18:00:00Z')); // one 4h bar that day
  });

  it('finds the latest bar that has started', () => {
    expect(m5.latest(z('2026-09-24T13:37:00Z'))).toBe(z('2026-09-24T13:35:00Z'));
    expect(m5.latest(z('2026-09-24T22:00:00Z'))).toBe(z('2026-09-24T19:55:00Z')); // after the close
    expect(m5.latest(z('2026-09-27T12:00:00Z'))).toBe(z('2026-09-25T19:55:00Z')); // Sunday
    expect(m5.latest(z('2026-09-25T12:00:00Z'))).toBe(z('2026-09-24T19:55:00Z')); // pre-market
    expect(m5.latest(z('2026-09-20T12:00:00Z'))).toBeNull(); // before the calendar
  });

  it('keeps next and prev inverse, also past the end of the calendar', () => {
    for (const clock of [m5, h1, h4, cal.clock(MIN)]) {
      let t = cal.sessions[0].open;
      for (let i = 0; i < 400; i++) {
        const n = clock.next(t);
        expect(n).toBeGreaterThan(t);
        expect(clock.prev(n)).toBe(t);
        t = n;
      }
    }
  });

  it('counts and steps bars', () => {
    expect(barsBetween(m5, z('2026-09-25T19:55:00Z'), z('2026-09-28T13:30:00Z'))).toBe(0);
    expect(barsBetween(m5, z('2026-09-24T13:30:00Z'), z('2026-09-24T13:50:00Z'))).toBe(3);
    const start = z('2026-09-25T19:00:00Z');
    const later = stepForward(m5, start, 50);
    expect(later).toBe(z('2026-09-28T16:40:00Z')); // 11 more bars on Friday, then 39 on Monday
    expect(stepBack(m5, later, 50)).toBe(start);
  });
});

describe('daily clock', () => {
  const d = cal.clock(DAY_MS, true);
  const day = (date: string) => zonedTime(date, '00:00', NEW_YORK);

  it('steps between session dates', () => {
    expect(d.next(day('2026-09-25'))).toBe(day('2026-09-28'));
    expect(d.prev(day('2026-09-28'))).toBe(day('2026-09-25'));
    expect(d.next(z('2026-09-26T12:00:00Z'))).toBe(day('2026-09-28'));
  });

  it('knows which daily bar has started and when it ends', () => {
    expect(d.latest(z('2026-09-25T12:00:00Z'))).toBe(day('2026-09-24')); // pre-market: yesterday's bar
    expect(d.latest(z('2026-09-25T14:00:00Z'))).toBe(day('2026-09-25'));
    expect(d.latest(z('2026-09-27T14:00:00Z'))).toBe(day('2026-09-25'));
    expect(d.end(day('2026-09-25'))).toBe(z('2026-09-25T20:00:00Z'));
    expect(d.bucket(z('2026-09-25T15:00:00Z'))).toBe(day('2026-09-25'));
    expect(d.bucket(z('2026-09-26T15:00:00Z'))).toBeNull();
  });

  it('keeps next and prev inverse past the end of the calendar', () => {
    let t = cal.sessions[0].day;
    for (let i = 0; i < 20; i++) {
      const n = d.next(t);
      expect(d.prev(n)).toBe(t);
      t = n;
    }
  });
});

describe('fixed clock', () => {
  it('steps at the interval, aligned to the epoch', () => {
    const c = fixedClock(H);
    const t = z('2026-09-24T10:00:00Z');
    expect(c.next(t)).toBe(t + H);
    expect(c.prev(t)).toBe(t - H);
    expect(c.next(t + 1)).toBe(t + H);
    expect(c.prev(t + 1)).toBe(t);
    expect(c.bucket(t + 59 * MIN)).toBe(t);
    expect(c.end(t)).toBe(t + H);
    expect(barsBetween(c, t, t + 5 * H)).toBe(4);
    expect(stepBack(c, t, 3)).toBe(t - 3 * H);
  });
});
