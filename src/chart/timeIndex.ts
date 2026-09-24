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
 *   (e.g. exchange downtime): the missing interval is compressed into the space between the two
 *   neighbouring bars, exactly like the chart compresses it.
 * - Before the first bar and after the last bar, time extrapolates with the nominal bar interval,
 *   so drawings in the "future" area stay put when new bars arrive.
 */
export class TimeIndex {
  static readonly EMPTY = new TimeIndex(new Float64Array(0), 1, 0);

  private readonly times: Float64Array;
  readonly intervalMs: number;
  /** Changes whenever the set of bar times changes; used to invalidate derived caches. */
  readonly version: number;

  private constructor(times: Float64Array, intervalMs: number, version: number) {
    this.times = times;
    this.intervalMs = intervalMs;
    this.version = version;
  }

  static from(sortedTimes: ArrayLike<number>, intervalMs: number, version: number): TimeIndex {
    if (!(intervalMs > 0)) throw new Error('intervalMs must be positive');
    const times = Float64Array.from(sortedTimes);
    for (let k = 1; k < times.length; k++) {
      if (!(times[k] > times[k - 1])) throw new Error('bar times must be strictly increasing');
    }
    return new TimeIndex(times, intervalMs, version);
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
    if (t >= last) return n - 1 + (t - last) / this.intervalMs;
    // Largest i with times[i] <= t (exists because first < t < last).
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= t) lo = mid;
      else hi = mid;
    }
    return lo + (t - times[lo]) / (times[lo + 1] - times[lo]);
  }

  /** Absolute time for a fractional logical index. Returns NaN when there is no data. */
  logicalToTime(logical: number): number {
    const times = this.times;
    const n = times.length;
    if (n === 0) return Number.NaN;
    if (logical <= 0) return times[0] + logical * this.intervalMs;
    if (logical >= n - 1) return times[n - 1] + (logical - (n - 1)) * this.intervalMs;
    const i = Math.floor(logical);
    const f = logical - i;
    return times[i] + f * (times[i + 1] - times[i]);
  }
}
