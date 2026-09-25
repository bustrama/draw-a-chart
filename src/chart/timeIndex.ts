import { fixedClock } from '../../shared/sessions.ts';
import type { BarClock } from '../market/types';

/** Future bar times generated first for session markets; the table grows when a time needs more. */
const FUTURE_BARS = 1500;
/** Beyond this many future bars (years of minute bars) the nominal interval is used. */
const FUTURE_MAX = 200_000;

/**
 * Bidirectional mapping between absolute time (Unix ms) and the chart's *fractional* logical
 * index (bar index, where bar i's centre is logical i).
 *
 * Why this exists: drawings are persisted in absolute time, never in logical indices. Logical
 * indices shift whenever older history is prepended and are meaningless across timeframes.
 * Lightweight Charts only converts integer indices (`logicalToCoordinate` returns 0 for
 * fractional input and `coordinateToLogical` rounds), so the fractional mapping is ours.
 *
 * Mapping rules (piecewise linear, monotonic, exactly invertible):
 * - A bar's open time maps to that bar's centre (TradingView convention).
 * - Between two consecutive bars, time interpolates linearly. This also covers gaps in the data
 *   (exchange downtime, nights, weekends): the missing time is compressed into the space between
 *   the two neighbouring bars, exactly like the chart compresses it.
 * - After the last bar, the future bars come from the bar clock: every interval for 24/7 markets,
 *   the next session's bars for stocks. So drawings in the "future" area stay put when new bars
 *   arrive, also across nights and weekends. Before the first bar, the nominal interval is used.
 */
export class TimeIndex {
  static readonly EMPTY = new TimeIndex(new Float64Array(0), fixedClock(1), 0);

  private readonly times: Float64Array;
  private readonly clock: BarClock;
  readonly intervalMs: number;
  /** Changes whenever the set of bar times changes; used to invalidate derived caches. */
  readonly version: number;
  /** [last bar, next bar, ...] for session clocks, built on first use. */
  private future: Float64Array | null = null;

  private constructor(times: Float64Array, clock: BarClock, version: number) {
    this.times = times;
    this.clock = clock;
    this.intervalMs = clock.intervalMs;
    this.version = version;
  }

  static from(sortedTimes: ArrayLike<number>, clock: BarClock | number, version: number): TimeIndex {
    const c = typeof clock === 'number' ? fixedClock(clock) : clock;
    if (!(c.intervalMs > 0)) throw new Error('intervalMs must be positive');
    const times = Float64Array.from(sortedTimes);
    for (let k = 1; k < times.length; k++) {
      if (!(times[k] > times[k - 1])) throw new Error('bar times must be strictly increasing');
    }
    return new TimeIndex(times, c, version);
  }

  get length(): number {
    return this.times.length;
  }

  get isEmpty(): boolean {
    return this.times.length === 0;
  }

  timeAt(index: number): number {
    return this.times[index];
  }

  /** Fractional logical index for an absolute time. Returns NaN when there is no data. */
  timeToLogical(t: number): number {
    const times = this.times;
    const n = times.length;
    if (n === 0) return Number.NaN;
    const first = times[0];
    if (t <= first) return (t - first) / this.intervalMs;
    const last = times[n - 1];
    if (t >= last) return n - 1 + this.futureOffset(t);
    // Largest i with times[i] <= t (exists because first < t < last).
    const i = lastAtOrBefore(times, t);
    return i + (t - times[i]) / (times[i + 1] - times[i]);
  }

  /** Absolute time for a fractional logical index. Returns NaN when there is no data. */
  logicalToTime(logical: number): number {
    const times = this.times;
    const n = times.length;
    if (n === 0) return Number.NaN;
    if (logical <= 0) return times[0] + logical * this.intervalMs;
    if (logical >= n - 1) return this.futureTime(logical - (n - 1));
    const i = Math.floor(logical);
    const f = logical - i;
    return times[i] + f * (times[i + 1] - times[i]);
  }

  /** Bars (fractional) from the last bar to time `t` (t >= last bar). */
  private futureOffset(t: number): number {
    const last = this.times[this.times.length - 1];
    if (this.clock.continuous) return (t - last) / this.intervalMs;
    let f = this.futureTimes();
    while (t >= f[f.length - 1] && f.length - 1 < FUTURE_MAX) f = this.growFuture();
    const k = f.length - 1;
    if (t >= f[k]) return k + (t - f[k]) / this.intervalMs;
    const j = lastAtOrBefore(f, t);
    return j + (t - f[j]) / (f[j + 1] - f[j]);
  }

  /** Time `offset` bars (fractional) after the last bar. */
  private futureTime(offset: number): number {
    const last = this.times[this.times.length - 1];
    if (this.clock.continuous) return last + offset * this.intervalMs;
    let f = this.futureTimes();
    while (offset >= f.length - 1 && f.length - 1 < FUTURE_MAX) f = this.growFuture();
    const k = f.length - 1;
    if (offset >= k) return f[k] + (offset - k) * this.intervalMs;
    const j = Math.floor(offset);
    return f[j] + (offset - j) * (f[j + 1] - f[j]);
  }

  private futureTimes(): Float64Array {
    if (!this.future) {
      const f = new Float64Array(1);
      f[0] = this.times[this.times.length - 1];
      this.future = this.extend(f, FUTURE_BARS);
    }
    return this.future;
  }

  /** Doubles the generated future bars (a drawing far to the right of the last bar). */
  private growFuture(): Float64Array {
    const f = this.futureTimes();
    this.future = this.extend(f, Math.min(FUTURE_MAX, 2 * (f.length - 1)));
    return this.future;
  }

  /** `f` continued with the clock's next bars up to `bars` future bars. */
  private extend(f: Float64Array, bars: number): Float64Array {
    const out = new Float64Array(bars + 1);
    out.set(f);
    let t = f[f.length - 1];
    for (let k = f.length; k <= bars; k++) {
      const next = this.clock.next(t);
      t = next > t ? next : t + this.intervalMs; // a clock must move forward; never loop
      out[k] = t;
    }
    return out;
  }
}

/** Largest index i with sorted[i] <= t, given sorted[0] <= t. */
function lastAtOrBefore(sorted: Float64Array, t: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= t) lo = mid;
    else hi = mid;
  }
  return sorted[hi] <= t ? hi : lo;
}
