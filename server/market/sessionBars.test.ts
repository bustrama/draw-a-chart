import { describe, expect, it } from 'vitest';
import { DAY_MS, NEW_YORK, SessionCalendar, sessionsFromCalendar } from '../../shared/sessions.ts';
import type { Bar } from './cache.ts';
import { toSessionBars } from './sessionBars.ts';

const z = (iso: string) => Date.parse(iso);
const cal = new SessionCalendar(sessionsFromCalendar([{ date: '2026-09-24', open: '09:30', close: '16:00' }], NEW_YORK));
const M30 = 30 * 60_000;

/** 30-minute source bars from 08:00 to 17:30 New York (12:00-21:30Z); volume = index. */
function thirtyMinute(): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < 20; i++) {
    const t = z('2026-09-24T12:00:00Z') + i * M30;
    out.push({ t, o: 100 + i, h: 110 + i, l: 90 + i, c: 105 + i, v: i });
  }
  return out;
}

describe('toSessionBars', () => {
  it('builds regular-hours hourly bars from 30-minute bars, from 9:30 to the close', () => {
    const bars = toSessionBars(thirtyMinute(), cal.clock(3_600_000));
    expect(bars.map((b) => new Date(b.t).toISOString().slice(11, 16))).toEqual(['13:30', '14:30', '15:30', '16:30', '17:30', '18:30', '19:30']);
    // 13:30 = source bars 3 (13:30) and 4 (14:00).
    expect(bars[0]).toEqual({ t: z('2026-09-24T13:30:00Z'), o: 103, h: 114, l: 93, c: 109, v: 3 + 4 });
    // The last hourly bar is only 19:30-20:00: source bar 15.
    expect(bars[6]).toEqual({ t: z('2026-09-24T19:30:00Z'), o: 115, h: 125, l: 105, c: 120, v: 15 });
  });

  it('builds the two 4-hour bars of a session', () => {
    const bars = toSessionBars(thirtyMinute(), cal.clock(4 * 3_600_000));
    expect(bars.map((b) => b.t)).toEqual([z('2026-09-24T13:30:00Z'), z('2026-09-24T17:30:00Z')]);
    expect(bars[0].v).toBe(3 + 4 + 5 + 6 + 7 + 8 + 9 + 10);
    expect(bars[1].v).toBe(11 + 12 + 13 + 14 + 15);
  });

  it('keeps native bars in regular hours and drops pre- and post-market ones', () => {
    const minute = [z('2026-09-24T13:29:00Z'), z('2026-09-24T13:30:00Z'), z('2026-09-24T19:59:00Z'), z('2026-09-24T20:00:00Z')].map((t) => ({ t, o: 1, h: 1, l: 1, c: 1, v: 1 }));
    expect(toSessionBars(minute, cal.clock(60_000)).map((b) => b.t)).toEqual([z('2026-09-24T13:30:00Z'), z('2026-09-24T19:59:00Z')]);
  });

  it('keeps daily bars on session days', () => {
    const daily = [{ t: z('2026-09-24T04:00:00Z'), o: 1, h: 2, l: 0.5, c: 1.5, v: 99 }];
    expect(toSessionBars(daily, cal.clock(DAY_MS, true))).toEqual(daily);
  });
});
