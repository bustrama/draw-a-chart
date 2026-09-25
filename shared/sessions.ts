/**
 * Trading sessions and bar clocks: which bar open times exist for a market and timeframe.
 *
 * Shared by the server (bucketing US stock bars into regular-hours bars, stepping over nights and
 * holidays) and the app (the chart's future area and telling real data gaps from nights and
 * weekends). Pure functions of UTC milliseconds without imports, so Node runs this file directly
 * (type stripping) and Vite bundles it.
 */

/** One regular trading session. All times are UTC milliseconds. */
export interface Session {
  /** Midnight of the session's date in the exchange's time zone: the open time of its daily bar. */
  readonly day: number;
  /** Regular-hours open (inclusive). */
  readonly open: number;
  /** Regular-hours close (exclusive). */
  readonly close: number;
}

/** Which bar open times exist for one market and timeframe. */
export interface BarClock {
  /** Nominal bar length (ms). */
  readonly intervalMs: number;
  /** True when bars follow each other every `intervalMs` without breaks (24/7 markets). */
  readonly continuous: boolean;
  /** Open time of the first bar that opens strictly after `time`. */
  next(time: number): number;
  /** Open time of the last bar that opens strictly before `time`. */
  prev(time: number): number;
  /**
   * Open time of the latest bar that has started at `time`: the bar containing it or, between
   * sessions, the last bar before. Null before the first bar.
   */
  latest(time: number): number | null;
  /** Open time of the bar containing `time`, or null when no bar covers it (e.g. overnight). */
  bucket(time: number): number | null;
  /** End (exclusive) of the bar that opens at `open`. */
  end(open: number): number;
}

export const DAY_MS = 86_400_000;

/** Bars every `intervalMs`, aligned to the UTC epoch, around the clock (crypto). */
export function fixedClock(intervalMs: number): BarClock {
  if (!(intervalMs > 0)) throw new Error('intervalMs must be positive');
  const floor = (t: number) => Math.floor(t / intervalMs) * intervalMs;
  return {
    intervalMs,
    continuous: true,
    next: (t) => floor(t) + intervalMs,
    prev: (t) => Math.ceil(t / intervalMs) * intervalMs - intervalMs,
    latest: (t) => floor(t),
    bucket: (t) => floor(t),
    end: (open) => open + intervalMs,
  };
}

/**
 * Number of bars that open strictly between the bars opening at `a` and `b` (a < b), counted up
 * to `cap`. 0 means `b` directly follows `a`.
 */
export function barsBetween(clock: BarClock, a: number, b: number, cap = 100_000): number {
  if (clock.continuous) return Math.max(0, Math.min(cap, Math.round((b - a) / clock.intervalMs) - 1));
  let n = 0;
  for (let t = clock.next(a); t < b && n < cap; t = clock.next(t)) n++;
  return n;
}

/** Steps `count` bars back from the bar opening at `time` (0 = `time` itself). */
export function stepBack(clock: BarClock, time: number, count: number): number {
  if (clock.continuous) return time - count * clock.intervalMs;
  let t = time;
  for (let i = 0; i < count; i++) t = clock.prev(t);
  return t;
}

/** Steps `count` bars forward from the bar opening at `time` (0 = `time` itself). */
export function stepForward(clock: BarClock, time: number, count: number): number {
  if (clock.continuous) return time + count * clock.intervalMs;
  let t = time;
  for (let i = 0; i < count; i++) t = clock.next(t);
  return t;
}

/**
 * The regular sessions of an exchange, sorted. Intraday bars start at each session's open and
 * repeat every interval until the close (the last one may be shorter, e.g. 15:30-16:00 for
 * hourly bars from a 9:30 open); daily bars open at each session's `day`.
 */
export class SessionCalendar {
  readonly sessions: readonly Session[];
  private readonly opens: Float64Array;
  private readonly days: Float64Array;

  constructor(sessions: readonly Session[]) {
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      if (!(s.open < s.close) || !(s.day <= s.open)) throw new Error(`invalid session at ${i}`);
      if (i > 0 && !(sessions[i - 1].close <= s.day)) throw new Error(`sessions out of order at ${i}`);
    }
    this.sessions = sessions;
    this.opens = Float64Array.from(sessions, (s) => s.open);
    this.days = Float64Array.from(sessions, (s) => s.day);
  }

  get first(): Session | undefined {
    return this.sessions[0];
  }

  get last(): Session | undefined {
    return this.sessions[this.sessions.length - 1];
  }

  /** The session whose regular hours contain `time`, if any. */
  sessionAt(time: number): Session | null {
    const i = lastAtOrBefore(this.opens, time, false);
    const s = this.sessions[i];
    return s && time < s.close ? s : null;
  }

  /** Bar clock for intraday bars of `intervalMs`, or for daily bars. */
  clock(intervalMs: number, daily = false): BarClock {
    return daily ? this.dailyClock() : this.intradayClock(intervalMs);
  }

  private intradayClock(ms: number): BarClock {
    if (!(ms > 0)) throw new Error('intervalMs must be positive');
    const sessions = this.sessions;
    const opens = this.opens;
    const n = sessions.length;
    const lastBarOf = (s: Session) => s.open + (Math.ceil((s.close - s.open) / ms) - 1) * ms;
    const fixed = fixedClock(ms);
    return {
      intervalMs: ms,
      continuous: false,
      bucket(t) {
        const s = sessions[lastAtOrBefore(opens, t, false)];
        if (!s || t >= s.close) return null;
        return s.open + Math.floor((t - s.open) / ms) * ms;
      },
      latest(t) {
        const s = sessions[lastAtOrBefore(opens, t, false)];
        if (!s) return null;
        return t < s.close ? s.open + Math.floor((t - s.open) / ms) * ms : lastBarOf(s);
      },
      end(open) {
        const s = sessions[lastAtOrBefore(opens, open, false)];
        return s && open < s.close ? Math.min(open + ms, s.close) : open + ms;
      },
      next(t) {
        if (n === 0) return fixed.next(t);
        const i = lastAtOrBefore(opens, t, false);
        if (i < 0) return sessions[0].open;
        const s = sessions[i];
        const candidate = s.open + (Math.floor((t - s.open) / ms) + 1) * ms;
        if (candidate < s.close) return candidate;
        // Past the last session of the calendar, keep stepping at the nominal interval.
        return i + 1 < n ? sessions[i + 1].open : candidate;
      },
      prev(t) {
        const i = lastAtOrBefore(opens, t, true);
        if (i < 0) return fixed.prev(t);
        const s = sessions[i];
        if (i === n - 1 && t > s.close) return s.open + (Math.ceil((t - s.open) / ms) - 1) * ms;
        const last = lastBarOf(s);
        if (t > last) return last;
        return s.open + (Math.ceil((t - s.open) / ms) - 1) * ms;
      },
    };
  }

  private dailyClock(): BarClock {
    const sessions = this.sessions;
    const opens = this.opens;
    const days = this.days;
    const n = sessions.length;
    const fixed = fixedClock(DAY_MS);
    return {
      intervalMs: DAY_MS,
      continuous: false,
      bucket(t) {
        const s = sessions[lastAtOrBefore(days, t, false)];
        return s && t < s.close ? s.day : null;
      },
      latest(t) {
        const s = sessions[lastAtOrBefore(opens, t, false)];
        return s ? s.day : null;
      },
      end(open) {
        const i = lastAtOrBefore(days, open, false);
        const s = sessions[i];
        return s && s.day === open ? s.close : open + DAY_MS;
      },
      next(t) {
        if (n === 0) return fixed.next(t);
        const i = lastAtOrBefore(days, t, false);
        if (i + 1 < n) return sessions[i + 1].day;
        const last = sessions[n - 1].day;
        return last + (Math.floor((t - last) / DAY_MS) + 1) * DAY_MS;
      },
      prev(t) {
        const i = lastAtOrBefore(days, t, true);
        if (i < 0) return fixed.prev(t);
        const s = sessions[i];
        if (i === n - 1 && t > s.day + DAY_MS) return s.day + (Math.ceil((t - s.day) / DAY_MS) - 1) * DAY_MS;
        return s.day;
      },
    };
  }
}

/** Index of the last element <= t (or < t when `strict`) in a sorted array, -1 if none. */
function lastAtOrBefore(sorted: Float64Array, t: number, strict: boolean): number {
  let lo = 0;
  let hi = sorted.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (strict ? sorted[mid] < t : sorted[mid] <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

// ---- time zones -----------------------------------------------------------------------------

export const NEW_YORK = 'America/New_York';

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Offset (ms) of `timeZone` from UTC at instant `t`: local wall time minus UTC. */
function offsetAt(t: number, timeZone: string): number {
  const parts = formatter(timeZone).formatToParts(new Date(t));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return wall - Math.floor(t / 1000) * 1000;
}

/** UTC ms of a wall-clock time (`YYYY-MM-DD`, `HH:MM`) in an IANA time zone. */
export function zonedTime(date: string, time: string, timeZone: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  if (!Number.isFinite(wall)) throw new Error(`invalid date/time: ${date} ${time}`);
  // Two passes: the first guess may sit on the other side of a daylight-saving change.
  const guess = wall - offsetAt(wall, timeZone);
  return wall - offsetAt(guess, timeZone);
}

/** `YYYY-MM-DD` of instant `t` in `timeZone`. */
export function zonedDate(t: number, timeZone: string): string {
  const parts = formatter(timeZone).formatToParts(new Date(t));
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month').padStart(2, '0')}-${get('day').padStart(2, '0')}`;
}

/** Exchange calendar rows (`date`, `open`, `close` as local wall times) to sessions. */
export function sessionsFromCalendar(rows: readonly { readonly date: string; readonly open: string; readonly close: string }[], timeZone: string): Session[] {
  return rows.map((r) => ({
    day: zonedTime(r.date, '00:00', timeZone),
    open: zonedTime(r.date, r.open, timeZone),
    close: zonedTime(r.date, r.close, timeZone),
  }));
}
