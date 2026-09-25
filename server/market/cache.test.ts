import { afterEach, describe, expect, it } from 'vitest';
import { BarCache, type Bar } from './cache.ts';

const bar = (t: number, c = 100): Bar => ({ t, o: c, h: c + 1, l: c - 1, c, v: 10 });

let cache: BarCache | null = null;
const open = () => (cache = new BarCache(':memory:'));

afterEach(() => {
  cache?.close();
  cache = null;
});

describe('BarCache', () => {
  it('gives each series a stable id', () => {
    const c = open();
    const a = c.series('us', 'AAPL', '1h');
    expect(c.series('us', 'AAPL', '1h')).toBe(a);
    expect(c.series('us', 'AAPL', '1d')).not.toBe(a);
    expect(c.series('binance', 'AAPL', '1h')).not.toBe(a);
  });

  it('stores bars inside the fetched range only and reads them back in order', () => {
    const c = open();
    const s = c.series('binance', 'BTCUSDT', '1m');
    c.store(s, [bar(300), bar(100), bar(200), bar(999)], 100, 300);
    expect(c.range(s, 0, 1000).map((b) => b.t)).toEqual([100, 200, 300]);
    expect(c.range(s, 150, 250)).toEqual([bar(200)]);
  });

  it('merges overlapping and adjacent coverage and reports what is missing', () => {
    const c = open();
    const s = c.series('us', 'SPY', '5m');
    c.store(s, [], 100, 199);
    c.store(s, [], 300, 399);
    expect(c.missing(s, 0, 500)).toEqual([
      [0, 99],
      [200, 299],
      [400, 500],
    ]);
    expect(c.missing(s, 120, 180)).toEqual([]);
    c.store(s, [], 200, 299); // touches both neighbours
    expect(c.coverage(s)).toEqual([[100, 399]]);
    c.store(s, [], 50, 120);
    expect(c.coverage(s)).toEqual([[50, 399]]);
    expect(c.missing(s, 0, 500)).toEqual([
      [0, 49],
      [400, 500],
    ]);
  });

  it('replaces a bar stored again (e.g. corrected upstream)', () => {
    const c = open();
    const s = c.series('us', 'SPY', '1d');
    c.store(s, [bar(100, 5)], 100, 100);
    c.store(s, [bar(100, 7)], 100, 100);
    expect(c.range(s, 0, 200)).toEqual([bar(100, 7)]);
  });

  it('forgets every series of a symbol', () => {
    const c = open();
    const a = c.series('us', 'NVDA', '1h');
    const b = c.series('us', 'NVDA', '1d');
    const other = c.series('us', 'AAPL', '1h');
    for (const s of [a, b, other]) c.store(s, [bar(100)], 0, 200);
    c.purgeSymbol('us', 'NVDA');
    expect(c.range(a, 0, 200)).toEqual([]);
    expect(c.coverage(b)).toEqual([]);
    expect(c.range(other, 0, 200)).toEqual([bar(100)]);
  });

  it('keeps small values in meta', () => {
    const c = open();
    expect(c.getMeta('k')).toBeNull();
    c.setMeta('k', 'v1');
    c.setMeta('k', 'v2');
    expect(c.getMeta('k')).toBe('v2');
  });
});
