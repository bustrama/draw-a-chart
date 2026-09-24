import { describe, expect, it } from 'vitest';
import { CandleSeries, preferCandle } from './candleSeries';
import type { Candle } from './types';

const M = 60_000;
const T0 = Date.UTC(2026, 0, 1);

function bar(i: number, over: Partial<Candle> = {}): Candle {
  return { time: T0 + i * M, open: 100 + i, high: 110 + i, low: 90 + i, close: 105 + i, volume: 10, closed: true, ...over };
}

describe('preferCandle', () => {
  it('never lets an open version overwrite a closed bar', () => {
    const closed = bar(0, { closed: true, volume: 50 });
    const open = bar(0, { closed: false, volume: 80 });
    expect(preferCandle(closed, open)).toBe(closed);
    expect(preferCandle(open, closed)).toBe(closed);
  });

  it('keeps the more advanced open version (trades, then volume)', () => {
    const older = bar(0, { closed: false, volume: 5, trades: 10 });
    const newer = bar(0, { closed: false, volume: 7, trades: 12 });
    expect(preferCandle(newer, older)).toBe(newer);
    expect(preferCandle(older, newer)).toBe(newer);
    const noTradesOld = bar(0, { closed: false, volume: 5 });
    const noTradesNew = bar(0, { closed: false, volume: 9 });
    expect(preferCandle(noTradesNew, noTradesOld)).toBe(noTradesNew);
  });
});

describe('CandleSeries.merge', () => {
  it('normalizes an unsorted batch with duplicates on first load', () => {
    const s = new CandleSeries(M);
    const change = s.merge([bar(2), bar(0), bar(1), bar(1, { close: 999 })]);
    expect(change.kind).toBe('general');
    expect(s.all().map((c) => c.time)).toEqual([T0, T0 + M, T0 + 2 * M]);
    expect(s.all()[1].close).toBe(999);
  });

  it('drops malformed candles', () => {
    const s = new CandleSeries(M);
    s.merge([bar(0), bar(1, { open: Number.NaN }), bar(2, { high: 1, low: 2 })]);
    expect(s.length).toBe(1);
  });

  it('reports a live update of the forming bar as a tail change', () => {
    const s = new CandleSeries(M);
    s.merge([bar(0), bar(1, { closed: false, volume: 3 })]);
    const change = s.merge([bar(1, { closed: false, volume: 4, close: 120 })]);
    expect(change).toEqual({ kind: 'tail', candles: [expect.objectContaining({ close: 120 })] });
    expect(s.length).toBe(2);
  });

  it('ignores a stale open update that arrives after a newer one', () => {
    const s = new CandleSeries(M);
    s.merge([bar(0), bar(1, { closed: false, volume: 9, trades: 90 })]);
    const change = s.merge([bar(1, { closed: false, volume: 4, trades: 40 })]);
    expect(change.kind).toBe('none');
    expect(s.last?.volume).toBe(9);
  });

  it('appends a new bar as a tail change without duplicating', () => {
    const s = new CandleSeries(M);
    s.merge([bar(0), bar(1)]);
    const change = s.merge([bar(2, { closed: false })]);
    expect(change.kind).toBe('tail');
    expect(s.length).toBe(3);
    // Same bar again (duplicate delivery) is a no-op.
    expect(s.merge([bar(2, { closed: false })]).kind).toBe('none');
    expect(s.length).toBe(3);
  });

  it('returns both the finalized previous bar and the new bar in order', () => {
    const s = new CandleSeries(M);
    s.merge([bar(0), bar(1, { closed: false, volume: 1 })]);
    const change = s.merge([bar(2, { closed: false }), bar(1, { closed: true, volume: 2 })]);
    expect(change.kind).toBe('tail');
    if (change.kind !== 'tail') return;
    expect(change.candles.map((c) => [c.time, c.closed])).toEqual([
      [T0 + M, true],
      [T0 + 2 * M, false],
    ]);
  });

  it('classifies older history as a prepend', () => {
    const s = new CandleSeries(M);
    s.merge([bar(10), bar(11)]);
    const change = s.merge([bar(7), bar(8), bar(9)]);
    expect(change).toEqual({ kind: 'prepend', count: 3 });
    expect(s.first?.time).toBe(T0 + 7 * M);
  });

  it('deduplicates overlapping history pages', () => {
    const s = new CandleSeries(M);
    s.merge([bar(5), bar(6), bar(7)]);
    const change = s.merge([bar(3), bar(4), bar(5), bar(6)]);
    expect(change.kind).toBe('general');
    expect(s.all().map((c) => (c.time - T0) / M)).toEqual([3, 4, 5, 6, 7]);
  });

  it('treats a backfill inside a gap as a general change and closes the gap', () => {
    const s = new CandleSeries(M);
    s.merge([bar(0), bar(1), bar(4), bar(5)]);
    expect(s.findGaps()).toEqual([{ after: T0 + M, before: T0 + 4 * M, missing: 2 }]);
    const change = s.merge([bar(2), bar(3)]);
    expect(change.kind).toBe('general');
    expect(s.findGaps()).toEqual([]);
  });

  it('reports no change when a batch is identical to stored data', () => {
    const s = new CandleSeries(M);
    s.merge([bar(0), bar(1), bar(2)]);
    expect(s.merge([bar(0), bar(1), bar(2)]).kind).toBe('none');
  });

  it('finds bars by open time', () => {
    const s = new CandleSeries(M);
    s.merge([bar(0), bar(1), bar(3)]);
    expect(s.indexOfTime(T0 + 3 * M)).toBe(2);
    expect(s.indexOfTime(T0 + 2 * M)).toBe(-1);
  });
});
