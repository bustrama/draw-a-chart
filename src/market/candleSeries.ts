import { barsBetween, fixedClock } from '../../shared/sessions.ts';
import type { BarClock, Candle } from './types';

/**
 * Decides which of two versions of the same bar (same open time) is more up to date.
 *
 * - A closed bar never regresses to an open one (REST snapshots taken before the close must
 *   not overwrite the final stream update, and vice versa).
 * - Between two open versions, the one with more trades (or, if unknown, more volume) wins.
 *   Both are monotonically non-decreasing while a bar is forming, so this protects against
 *   out-of-order delivery (e.g. a slow REST response arriving after newer stream updates).
 * - Ties go to the incoming version.
 */
export function preferCandle(existing: Candle, incoming: Candle): Candle {
  if (existing.closed !== incoming.closed) return existing.closed ? existing : incoming;
  if (existing.closed) return incoming;
  if (existing.trades !== undefined && incoming.trades !== undefined && existing.trades !== incoming.trades) {
    return incoming.trades > existing.trades ? incoming : existing;
  }
  if (incoming.volume < existing.volume) return existing;
  return incoming;
}

export type SeriesChange =
  /** Nothing changed. */
  | { readonly kind: 'none' }
  /**
   * Only trailing bars changed: `candles` must be applied in order with incremental updates.
   * The first entry is either the (updated) previous last bar or a newly appended bar.
   */
  | { readonly kind: 'tail'; readonly candles: readonly Candle[] }
  /** Only bars before the first bar were added. */
  | { readonly kind: 'prepend'; readonly count: number }
  /** Anything else (middle inserts, corrections of older bars). Requires a full re-sync. */
  | { readonly kind: 'general' };

export interface Gap {
  /** Open time of the last bar before the gap. */
  readonly after: number;
  /** Open time of the first bar after the gap. */
  readonly before: number;
  /** Number of missing bars (per the bar clock: nights and weekends are not missing bars). */
  readonly missing: number;
}

/**
 * Sorted, de-duplicated candle list for one symbol + timeframe.
 * Pure data structure (no I/O, no timers). Every mutation reports what changed so the chart
 * adapter can choose between incremental updates and a full re-sync.
 */
export class CandleSeries {
  private bars: Candle[] = [];
  /** Which bar open times exist (a fixed interval, or trading sessions). */
  readonly clock: BarClock;

  constructor(clock: BarClock | number) {
    this.clock = typeof clock === 'number' ? fixedClock(clock) : clock;
  }

  get intervalMs(): number {
    return this.clock.intervalMs;
  }

  get length(): number {
    return this.bars.length;
  }

  get first(): Candle | undefined {
    return this.bars[0];
  }

  get last(): Candle | undefined {
    return this.bars[this.bars.length - 1];
  }

  /** Read-only view; callers must not mutate it. Replaced (not mutated) on every change. */
  all(): readonly Candle[] {
    return this.bars;
  }

  clear(): void {
    this.bars = [];
  }

  /** Merges any batch (initial history, older pages, backfills, live updates). */
  merge(incoming: readonly Candle[]): SeriesChange {
    const batch = normalizeBatch(incoming);
    if (batch.length === 0) return { kind: 'none' };
    const old = this.bars;

    if (old.length === 0) {
      this.bars = batch;
      return { kind: 'general' };
    }

    // Fast path: pure prepend of older history.
    if (batch[batch.length - 1].time < old[0].time) {
      this.bars = batch.concat(old);
      return { kind: 'prepend', count: batch.length };
    }

    // Fast path: single live update of the last bar, or a single appended bar.
    const oldLast = old[old.length - 1];
    if (batch.length === 1 && batch[0].time >= oldLast.time) {
      const c = batch[0];
      if (c.time === oldLast.time) {
        const winner = preferCandle(oldLast, c);
        if (winner === oldLast || candlesEqual(winner, oldLast)) return { kind: 'none' };
        const next = old.slice(0, -1);
        next.push(winner);
        this.bars = next;
        return { kind: 'tail', candles: [winner] };
      }
      const next = old.slice();
      next.push(c);
      this.bars = next;
      return { kind: 'tail', candles: [c] };
    }

    // General two-pointer merge. Unchanged bars keep their identity (reference equality),
    // which is what the change classification below relies on.
    const merged: Candle[] = [];
    let i = 0;
    let j = 0;
    let firstDiff = -1;
    while (i < old.length || j < batch.length) {
      const a = old[i];
      const b = batch[j];
      let out: Candle;
      if (b === undefined || (a !== undefined && a.time < b.time)) {
        out = a;
        i++;
      } else if (a === undefined || b.time < a.time) {
        out = b;
        j++;
      } else {
        const winner = preferCandle(a, b);
        out = winner === a || candlesEqual(winner, a) ? a : winner;
        i++;
        j++;
      }
      if (firstDiff === -1 && out !== old[merged.length]) firstDiff = merged.length;
      merged.push(out);
    }
    if (firstDiff === -1 && merged.length === old.length) return { kind: 'none' };
    if (firstDiff === -1) firstDiff = old.length;
    this.bars = merged;
    if (firstDiff >= old.length - 1) {
      return { kind: 'tail', candles: merged.slice(firstDiff) };
    }
    return { kind: 'general' };
  }

  /**
   * Missing bars between consecutive stored bars (exchange downtime, dropped updates, or minutes
   * without trades). Times the bar clock has no bars for (nights, weekends) are not gaps.
   */
  findGaps(): Gap[] {
    const gaps: Gap[] = [];
    const clock = this.clock;
    for (let k = 1; k < this.bars.length; k++) {
      const after = this.bars[k - 1].time;
      const before = this.bars[k].time;
      if (clock.continuous ? before - after <= clock.intervalMs : clock.next(after) >= before) continue;
      const missing = barsBetween(clock, after, before);
      if (missing > 0) gaps.push({ after, before, missing });
    }
    return gaps;
  }

  /** Index of the bar with exactly this open time, or -1. */
  indexOfTime(time: number): number {
    let lo = 0;
    let hi = this.bars.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const t = this.bars[mid].time;
      if (t === time) return mid;
      if (t < time) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }
}

export function candlesEqual(a: Candle, b: Candle): boolean {
  return (
    a.time === b.time &&
    a.open === b.open &&
    a.high === b.high &&
    a.low === b.low &&
    a.close === b.close &&
    a.volume === b.volume &&
    a.closed === b.closed &&
    a.trades === b.trades
  );
}

/** Validates, sorts and de-duplicates a batch (duplicates resolved with preferCandle). */
function normalizeBatch(input: readonly Candle[]): Candle[] {
  const valid = input.filter(isValidCandle);
  valid.sort((a, b) => a.time - b.time);
  const out: Candle[] = [];
  for (const c of valid) {
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.time === c.time) {
      out[out.length - 1] = preferCandle(prev, c);
    } else {
      out.push(c);
    }
  }
  return out;
}

function isValidCandle(c: Candle): boolean {
  return (
    Number.isFinite(c.time) &&
    Number.isFinite(c.open) &&
    Number.isFinite(c.high) &&
    Number.isFinite(c.low) &&
    Number.isFinite(c.close) &&
    Number.isFinite(c.volume) &&
    c.high >= c.low
  );
}
