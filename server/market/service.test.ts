import { afterEach, describe, expect, it } from 'vitest';
import type { AlpacaTimeframe, CalendarRow, StockSymbol } from './alpaca.ts';
import type { CryptoSymbol } from './binance.ts';
import { BarCache, type Bar } from './cache.ts';
import { MarketError, MarketService, type CryptoUpstream, type OutBar, type StockUpstream } from './service.ts';
import { UpstreamError } from './upstream.ts';

const MIN = 60_000;
const H = 60 * MIN;
const z = (iso: string) => Date.parse(iso);
const hhmm = (bars: readonly OutBar[]) => bars.map((b) => `${new Date(b.t).toISOString().slice(5, 16)}${b.closed ? '' : '*'}`);

class Clock {
  t: number;
  constructor(iso: string) {
    this.t = z(iso);
  }
  now = () => this.t;
}

/** Hourly (or any interval) bars for every slot up to the forming one; `missing` = exchange gaps. */
class FakeCrypto implements CryptoUpstream {
  readonly calls: Array<{ from: number; to: number }> = [];
  readonly missing = new Set<number>();
  fail = false;
  private readonly clock: Clock;
  constructor(clock: Clock) {
    this.clock = clock;
  }
  async klines(_symbol: string, interval: string, from: number, to: number): Promise<Bar[]> {
    this.calls.push({ from, to });
    if (this.fail) throw new UpstreamError('Binance', 0, 'unreachable');
    const ms = interval === '1h' ? H : interval === '1m' ? MIN : Number.NaN;
    const newest = Math.floor(this.clock.t / ms) * ms;
    const out: Bar[] = [];
    for (let t = Math.ceil(from / ms) * ms; t <= Math.min(to, newest); t += ms) {
      if (this.missing.has(t)) continue;
      const c = t / 1e9 + (t === newest ? (this.clock.t - t) / 1e6 : 0); // the forming bar moves with time
      out.push({ t, o: c, h: c + 1, l: c - 1, c, v: 1 });
    }
    return out;
  }
  async symbols(): Promise<CryptoSymbol[]> {
    return [
      { symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT', tickSize: '0.01000000' },
      { symbol: 'BTCEUR', base: 'BTC', quote: 'EUR', tickSize: '0.01000000' },
      { symbol: 'SHIBUSDT', base: 'SHIB', quote: 'USDT', tickSize: '0.00000001' },
    ];
  }
}

const ROWS: CalendarRow[] = [
  { date: '2026-09-24', open: '09:30', close: '16:00' },
  { date: '2026-09-25', open: '09:30', close: '16:00' },
  { date: '2026-09-28', open: '09:30', close: '16:00' },
  { date: '2026-09-29', open: '09:30', close: '16:00' },
];
const SOURCE_MS: Record<AlpacaTimeframe, number> = { '1Min': MIN, '5Min': 5 * MIN, '15Min': 15 * MIN, '30Min': 30 * MIN, '1Day': 24 * H };

/**
 * Alpaca-like: bars around the clock (pre- and post-market included) every source interval; daily
 * bars at New York midnight of each session. Enforces the free plan: nothing newer than 15 minutes.
 */
class FakeStocks implements StockUpstream {
  readonly delayMs = 15 * MIN;
  readonly calls: Array<{ timeframe: AlpacaTimeframe; start: number; end: number }> = [];
  readonly splitCalls: Array<{ start: string; end: string }> = [];
  splitDates: string[] = [];
  /** Split checks never answer (a hung upstream). */
  hangSplits = false;
  assetsFail = false;
  assetCalls = 0;
  /** Emit only every n-th source bar (a thinly traded stock). */
  every = 1;
  private readonly clock: Clock;
  constructor(clock: Clock) {
    this.clock = clock;
  }
  async bars(_symbol: string, timeframe: AlpacaTimeframe, start: number, end: number): Promise<Bar[]> {
    this.calls.push({ timeframe, start, end });
    if (end > this.clock.t - this.delayMs) throw new UpstreamError('Alpaca', 403, 'subscription does not permit querying recent SIP data');
    const out: Bar[] = [];
    if (timeframe === '1Day') {
      for (const r of ROWS) {
        const t = z(`${r.date}T04:00:00Z`);
        if (t >= start && t <= end) out.push({ t, o: 1, h: 2, l: 0.5, c: 1.5, v: 1000 });
      }
      return out;
    }
    const ms = SOURCE_MS[timeframe];
    let i = 0;
    for (let t = Math.ceil(start / ms) * ms; t <= end; t += ms) if (i++ % this.every === 0) out.push({ t, o: 10, h: 11, l: 9, c: 10, v: 5 });
    return out;
  }
  async calendar(): Promise<CalendarRow[]> {
    return ROWS;
  }
  async assets(): Promise<StockSymbol[]> {
    this.assetCalls++;
    if (this.assetsFail) throw new UpstreamError('Alpaca', 503, 'HTTP 503');
    return [
      { symbol: 'AAPL', name: 'Apple Inc. Common Stock', exchange: 'NASDAQ' },
      { symbol: 'MLP', name: 'Maui Land & Pineapple Company', exchange: 'NYSE' },
      { symbol: 'BTC', name: 'Grayscale Bitcoin Mini Trust', exchange: 'ARCA' },
    ];
  }
  async splits(_symbol: string, start: string, end: string): Promise<string[]> {
    this.splitCalls.push({ start, end });
    if (this.hangSplits) return new Promise(() => undefined);
    return this.splitDates.filter((d) => d >= start && d <= end);
  }
}

const caches: BarCache[] = [];
function setup(nowIso: string, options: { alpaca?: boolean } = {}) {
  const clock = new Clock(nowIso);
  const cache = new BarCache(':memory:');
  caches.push(cache);
  const crypto = new FakeCrypto(clock);
  const stocks = new FakeStocks(clock);
  const logs: string[] = [];
  const service = new MarketService({ cache, binance: crypto, alpaca: options.alpaca === false ? null : stocks, now: clock.now, log: (m) => logs.push(m), splitCheckWaitMs: 50 });
  return { clock, cache, crypto, stocks, service, logs };
}

afterEach(() => {
  for (const c of caches.splice(0)) c.close();
});

describe('MarketService: crypto', () => {
  it('serves the latest bars and fetches only what the cache is missing', async () => {
    const { clock, crypto, service } = setup('2026-09-25T18:30:10Z');
    const req = { market: 'binance', symbol: 'BTCUSDT', tf: '1h' as const, limit: 5 };
    expect(hhmm(await service.bars(req))).toEqual(['09-25T14:00', '09-25T15:00', '09-25T16:00', '09-25T17:00', '09-25T18:00*']);
    expect(crypto.calls).toEqual([{ from: z('2026-09-25T14:00:00Z'), to: z('2026-09-25T18:00:00Z') }]);

    await service.bars(req); // the forming bar is reused for a few seconds
    expect(crypto.calls).toHaveLength(1);

    clock.t += 20_000;
    const again = await service.bars(req);
    expect(crypto.calls.at(-1)).toEqual({ from: z('2026-09-25T18:00:00Z'), to: z('2026-09-25T18:00:00Z') });
    expect(again.at(-1)?.c).toBeGreaterThan((await service.bars(req)).at(0)!.c); // fresh forming bar

    clock.t = z('2026-09-25T19:00:10Z'); // 18:00 closed, 19:00 forming: one request for both
    expect(hhmm(await service.bars(req))).toEqual(['09-25T15:00', '09-25T16:00', '09-25T17:00', '09-25T18:00', '09-25T19:00*']);
    expect(crypto.calls.at(-1)).toEqual({ from: z('2026-09-25T18:00:00Z'), to: z('2026-09-25T19:00:00Z') });
  });

  it('never asks again for a range the exchange has no bars for', async () => {
    const { clock, crypto, service } = setup('2026-09-25T18:30:10Z');
    crypto.missing.add(z('2026-09-25T16:00:00Z'));
    const req = { market: 'binance', symbol: 'BTCUSDT', tf: '1h' as const, limit: 5 };
    // Five bars, like the exchange's own API: one more from before the gap.
    expect(hhmm(await service.bars(req))).toEqual(['09-25T13:00', '09-25T14:00', '09-25T15:00', '09-25T17:00', '09-25T18:00*']);
    clock.t += 20_000;
    await service.bars(req);
    expect(crypto.calls.at(-1)).toEqual({ from: z('2026-09-25T18:00:00Z'), to: z('2026-09-25T18:00:00Z') });
  });

  it('pages older history and forward ranges through the cache', async () => {
    const { crypto, service } = setup('2026-09-25T18:30:10Z');
    const older = { market: 'binance', symbol: 'BTCUSDT', tf: '1h' as const, limit: 3, end: z('2026-09-25T14:00:00Z') - 1 };
    expect(hhmm(await service.bars(older))).toEqual(['09-25T11:00', '09-25T12:00', '09-25T13:00']);
    await service.bars(older);
    expect(crypto.calls).toHaveLength(1);
    const forward = { market: 'binance', symbol: 'BTCUSDT', tf: '1h' as const, limit: 4, start: z('2026-09-25T12:00:00Z') };
    expect(hhmm(await service.bars(forward))).toEqual(['09-25T12:00', '09-25T13:00', '09-25T14:00', '09-25T15:00']);
    expect(crypto.calls.at(-1)).toEqual({ from: z('2026-09-25T14:00:00Z'), to: z('2026-09-25T15:00:00Z') });
  });

  it('refuses unknown symbols, bad limits and markets it cannot serve', async () => {
    const { crypto, service } = setup('2026-09-25T18:30:10Z', { alpaca: false });
    await expect(service.bars({ market: 'binance', symbol: 'NOPE', tf: '1h', limit: 5 })).rejects.toMatchObject({ status: 404 });
    await expect(service.bars({ market: 'binance', symbol: 'BTCUSDT', tf: '1h', limit: 0 })).rejects.toMatchObject({ status: 400 });
    await expect(service.bars({ market: 'us', symbol: 'AAPL', tf: '1h', limit: 5 })).rejects.toBeInstanceOf(MarketError);
    await expect(service.bars({ market: 'forex', symbol: 'EURUSD', tf: '1h', limit: 5 })).rejects.toMatchObject({ status: 404 });
    expect(service.markets().find((m) => m.id === 'us')?.available).toBe(false);
    expect(crypto.calls).toHaveLength(0);
  });

  it('marks nothing complete when the upstream fails', async () => {
    const { crypto, service } = setup('2026-09-25T18:30:10Z');
    crypto.fail = true;
    const req = { market: 'binance', symbol: 'BTCUSDT', tf: '1h' as const, limit: 5 };
    await expect(service.bars(req)).rejects.toBeInstanceOf(UpstreamError);
    crypto.fail = false;
    await service.bars(req);
    expect(crypto.calls.at(-1)).toEqual({ from: z('2026-09-25T14:00:00Z'), to: z('2026-09-25T18:00:00Z') });
  });
});

describe('MarketService: US stocks', () => {
  // Monday 28 Sep 2026, 10:40 New York: the delayed data reaches 10:25.
  const MONDAY = '2026-09-28T14:40:00Z';

  it('follows the trading sessions: nights and weekends are not missing bars', async () => {
    const { stocks, service } = setup(MONDAY);
    const bars = await service.bars({ market: 'us', symbol: 'AAPL', tf: '1h', limit: 10 });
    expect(hhmm(bars)).toEqual([
      '09-24T18:30',
      '09-24T19:30',
      '09-25T13:30',
      '09-25T14:30',
      '09-25T15:30',
      '09-25T16:30',
      '09-25T17:30',
      '09-25T18:30',
      '09-25T19:30',
      '09-28T13:30*',
    ]);
    // Hourly bars are built from 30-minute bars, and nothing newer than 15 minutes is requested.
    for (const c of stocks.calls) {
      expect(c.timeframe).toBe('30Min');
      expect(c.end).toBeLessThanOrEqual(z(MONDAY) - 15 * MIN);
    }
    // The forming bar holds the 9:30 and 10:00 half hours reported so far.
    expect(bars.at(-1)?.v).toBe(10);
  });

  it('serves a closed market from the cache alone', async () => {
    const { stocks, service } = setup('2026-09-26T15:00:00Z'); // Saturday
    const req = { market: 'us', symbol: 'AAPL', tf: '1h' as const, limit: 3 };
    expect(hhmm(await service.bars(req))).toEqual(['09-25T17:30', '09-25T18:30', '09-25T19:30']);
    const calls = stocks.calls.length;
    await service.bars(req);
    expect(stocks.calls).toHaveLength(calls);
  });

  it('serves daily bars at New York midnight, today still forming', async () => {
    const { service } = setup(MONDAY);
    const bars = await service.bars({ market: 'us', symbol: 'AAPL', tf: '1d', limit: 3 });
    expect(hhmm(bars)).toEqual(['09-24T04:00', '09-25T04:00', '09-28T04:00*']);
  });

  it('keeps the daily bar forming until the extended session is over', async () => {
    // 16:40 New York: the regular session closed, but post-market volume still counts for the day.
    const { clock, service } = setup('2026-09-28T20:40:00Z');
    const req = { market: 'us', symbol: 'AAPL', tf: '1d' as const, limit: 2 };
    expect(hhmm(await service.bars(req))).toEqual(['09-25T04:00', '09-28T04:00*']);
    clock.t = Date.parse('2026-09-29T00:40:00Z'); // 20:40: final (with the 15-minute delay)
    expect(hhmm(await service.bars(req))).toEqual(['09-25T04:00', '09-28T04:00']);
  });

  it('does not let a hanging split check hold the chart', async () => {
    const { clock, stocks, service } = setup(MONDAY);
    const req = { market: 'us', symbol: 'AAPL', tf: '1h' as const, limit: 3 };
    await service.bars(req);
    clock.t = Date.parse('2026-09-29T14:40:00Z');
    stocks.hangSplits = true;
    expect(await service.bars(req)).toHaveLength(3); // answered after the short wait
  });

  it('drops the cached bars of a stock that split', async () => {
    const { clock, stocks, service, logs } = setup(MONDAY);
    const req = { market: 'us', symbol: 'AAPL', tf: '1h' as const, limit: 10 };
    await service.bars(req);
    expect(stocks.splitCalls).toHaveLength(0); // the first look only records the day
    clock.t = z('2026-09-29T14:40:00Z');
    stocks.splitDates = ['2026-09-29'];
    const before = stocks.calls.length;
    await service.bars(req);
    expect(stocks.splitCalls).toEqual([{ start: '2026-09-26', end: '2026-09-29' }]);
    expect(logs.some((l) => l.includes('split'))).toBe(true);
    // The whole range was fetched again, not only the new bars.
    expect(stocks.calls.slice(before).some((c) => c.start <= z('2026-09-25T18:30:00Z'))).toBe(true);
  });

  it('collects more bars when a thinly traded stock has minutes without trades', async () => {
    const { stocks, service } = setup(MONDAY);
    stocks.every = 2;
    const bars = await service.bars({ market: 'us', symbol: 'AAPL', tf: '1m', limit: 50 });
    expect(bars.length).toBeGreaterThan(25); // more than the first 50 slots hold
    expect(bars.length).toBeLessThanOrEqual(50);
    expect(stocks.calls.length).toBeGreaterThan(1);
    for (let i = 1; i < bars.length; i++) expect(bars[i].t).toBeGreaterThan(bars[i - 1].t);
  });
});

describe('MarketService: symbols and calendar', () => {
  it('does not reload a failing symbol list on every request', async () => {
    const { clock, stocks, service } = setup(MONDAY_ISO);
    stocks.assetsFail = true;
    await service.search('aapl');
    await service.search('aapl');
    expect(stocks.assetCalls).toBe(1);
    clock.t += 3 * 60_000;
    stocks.assetsFail = false;
    expect((await service.search('aapl'))[0]?.symbol).toBe('AAPL');
    expect(stocks.assetCalls).toBe(2);
  });

  it('ranks coins and stocks sensibly', async () => {
    const { service } = setup(MONDAY_ISO);
    const ids = async (q: string) => (await service.search(q)).map((r) => `${r.market}:${r.symbol}`);
    expect((await ids('btc'))[0]).toBe('binance:BTCUSDT');
    expect(await ids('btc')).toContain('us:BTC');
    expect(await ids('apple')).toEqual(['us:AAPL', 'us:MLP']);
    expect((await ids('aapl'))[0]).toBe('us:AAPL');
    expect(await ids('  ')).toEqual([]);
  });

  it('describes symbols', async () => {
    const { service } = setup(MONDAY_ISO);
    expect(await service.symbol('binance', 'SHIBUSDT')).toMatchObject({ pricePrecision: 8, minMove: 0.00000001, timeZone: 'UTC', sessions: false });
    expect(await service.symbol('us', 'AAPL')).toMatchObject({ name: 'Apple Inc. Common Stock', timeZone: 'America/New_York', delayMs: 15 * MIN, sessions: true });
    expect(await service.symbol('us', 'NOPE')).toBeNull();
  });

  it('serves the US sessions and keeps lists for the next start', async () => {
    const { cache, service } = setup(MONDAY_ISO);
    const sessions = await service.sessions('us');
    expect(sessions[0]).toEqual([z('2026-09-24T04:00:00Z'), z('2026-09-24T13:30:00Z'), z('2026-09-24T20:00:00Z')]);
    await expect(service.sessions('binance')).rejects.toMatchObject({ status: 404 });
    await service.search('aapl');
    // A restarted server reads them from the cache instead of the upstream.
    const restarted = new MarketService({ cache, binance: null, alpaca: new FakeStocks(new Clock(MONDAY_ISO)), now: () => z(MONDAY_ISO) });
    expect(cache.getMeta('symbols:us')).not.toBeNull();
    expect((await restarted.search('aapl'))[0].symbol).toBe('AAPL');
  });
});

const MONDAY_ISO = '2026-09-28T14:40:00Z';
