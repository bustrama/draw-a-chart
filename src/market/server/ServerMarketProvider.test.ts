import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WireSymbol } from '../protocol';
import { searchLocal, StaticMarketRegistry } from '../registry';
import { FakeProvider } from '../testing/fakes';
import type { Candle, LiveStatus } from '../types';
import { MarketApi, MarketApiError } from './marketApi';
import { ServerMarketProvider } from './ServerMarketProvider';

const z = (iso: string) => Date.parse(iso);

const AAPL: WireSymbol = {
  market: 'us',
  symbol: 'AAPL',
  name: 'Apple Inc. Common Stock',
  base: 'AAPL',
  quote: 'USD',
  exchange: 'NASDAQ',
  pricePrecision: 2,
  minMove: 0.01,
  timeZone: 'America/New_York',
  delayMs: 900_000,
  sessions: true,
};
const SESSIONS = [[z('2026-09-25T04:00:00Z'), z('2026-09-25T13:30:00Z'), z('2026-09-25T20:00:00Z')]];

type Route = (url: URL) => Response | Promise<Response>;
/** An answer of the market-data API (it marks every answer). */
const answer = (status: number, body: string | null) => new Response(body, { status, headers: { 'Content-Type': 'application/json', 'X-Market-Api': '1' } });
const ok = (body: unknown) => answer(200, JSON.stringify(body));

function api(route: Route) {
  const urls: URL[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://app.test');
    urls.push(url);
    return route(url);
  }) as typeof fetch;
  return { api: new MarketApi('', fetchImpl), urls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('MarketApi', () => {
  it('reads bars and forwards the query', async () => {
    const { api: a, urls } = api(() => ok({ bars: [[1000, 1, 2, 0.5, 1.5, 7, 1], [2000, 1, 2, 0.5, 1.5, 3, 0], 'junk'] }));
    const bars = await a.bars({ market: 'us', symbol: 'AAPL', timeframe: '1h', limit: 2, endTime: 1999.7 });
    expect(bars).toEqual([
      { time: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 7, closed: true },
      { time: 2000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3, closed: false },
    ]);
    expect(Object.fromEntries(urls[0].searchParams)).toEqual({ market: 'us', symbol: 'AAPL', tf: '1h', limit: '2', end: '1999' });
  });

  it('turns failures into readable errors', async () => {
    const fail = (response: Response | Error) =>
      api(() => {
        if (response instanceof Error) throw response;
        return response;
      }).api.symbol('us', 'AAPL');
    await expect(fail(answer(404, JSON.stringify({ error: 'unknown symbol AAPL' })))).rejects.toMatchObject({ status: 404, kind: 'error', message: 'unknown symbol AAPL' });
    await expect(fail(answer(500, 'oops'))).rejects.toMatchObject({ status: 500, kind: 'error', message: 'Market data unavailable (HTTP 500)' });
    // Not the market-data API: a proxy error page, a static host's index.html, market data turned off.
    await expect(fail(new Response('<html>bad gateway</html>', { status: 502 }))).rejects.toMatchObject({ kind: 'absent' });
    await expect(fail(new Response('<!doctype html>', { status: 200 }))).rejects.toMatchObject({ kind: 'absent' });
    await expect(fail(new Response(null, { status: 302, headers: { Location: '/login' } }))).rejects.toMatchObject({ kind: 'login', message: expect.stringContaining('login') });
    await expect(fail(new TypeError('network down'))).rejects.toMatchObject({ kind: 'unreachable', message: 'The market-data server is unreachable' });
  });

  it('loads a calendar once, and again after a failure', async () => {
    let calls = 0;
    const { api: a } = api(() => (++calls === 1 ? answer(503, '{}') : ok({ sessions: SESSIONS })));
    await expect(a.calendar('us')).rejects.toBeInstanceOf(MarketApiError);
    const cal = await a.calendar('us');
    expect(cal.sessions).toHaveLength(1);
    expect(await a.calendar('us')).toBe(cal);
    expect(calls).toBe(2);
  });
});

describe('ServerMarketProvider', () => {
  it('prepares a stock chart with its sessions, time zone and delay', async () => {
    const { api: a } = api((url) => (url.pathname === '/api/market/symbol' ? ok({ symbol: AAPL }) : ok({ sessions: SESSIONS })));
    const provider = new ServerMarketProvider({ api: a, market: 'us', name: 'US stocks' });
    const { info, clock } = await provider.prepare('AAPL', '1h');
    expect(info).toMatchObject({ symbol: 'AAPL', name: 'Apple Inc. Common Stock', timeZone: 'America/New_York', delayMs: 900_000 });
    expect(clock.continuous).toBe(false);
    expect(clock.next(z('2026-09-25T13:30:00Z'))).toBe(z('2026-09-25T14:30:00Z'));
  });

  it('falls back to the direct provider when the server is unreachable', async () => {
    const { api: a } = api(() => {
      throw new TypeError('offline');
    });
    const fallback = new FakeProvider();
    fallback.handler = () => [{ time: 1, open: 1, high: 1, low: 1, close: 1, volume: 1, closed: true }];
    const provider = new ServerMarketProvider({ api: a, market: 'binance', name: 'Binance', fallback });
    expect((await provider.prepare('BTCUSDT', '1h')).clock.continuous).toBe(true);
    expect(await provider.fetchCandles({ symbol: 'BTCUSDT', timeframe: '1h', limit: 5 })).toHaveLength(1);
    expect(fallback.requests).toHaveLength(1);
  });

  it('falls back when something else answers at the market path (no market-data API)', async () => {
    const { api: a } = api(() => new Response(JSON.stringify({ error: 'not found' }), { status: 404 })); // the sync API
    const fallback = new FakeProvider();
    const provider = new ServerMarketProvider({ api: a, market: 'binance', name: 'Binance', fallback });
    await provider.fetchCandles({ symbol: 'BTCUSDT', timeframe: '1h', limit: 5 });
    expect(fallback.requests).toHaveLength(1);
  });

  it('does not fall back when the server answers with an error', async () => {
    const { api: a } = api(() => answer(404, JSON.stringify({ error: 'unknown symbol NOPE' })));
    const fallback = new FakeProvider();
    const provider = new ServerMarketProvider({ api: a, market: 'binance', name: 'Binance', fallback });
    await expect(provider.fetchCandles({ symbol: 'NOPE', timeframe: '1h', limit: 5 })).rejects.toMatchObject({ status: 404 });
    expect(fallback.requests).toHaveLength(0);
  });

  it('polls the latest bars, reports its status and asks for a resync after an outage', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(z('2026-09-25T15:00:30Z'));
    let fail = false;
    const { api: a, urls } = api(() => {
      if (fail) throw new TypeError('offline');
      return ok({ bars: [[z('2026-09-25T14:30:00Z'), 1, 2, 0.5, 1.5, 7, 0]] });
    });
    const provider = new ServerMarketProvider({ api: a, market: 'us', name: 'US stocks', documentEvents: new EventTarget() });
    const candles: Candle[] = [];
    const statuses: LiveStatus[] = [];
    let resyncs = 0;
    const stop = provider.subscribeCandles('AAPL', '1h', { onCandle: (c) => candles.push(c), onStatus: (s) => statuses.push(s), onResync: () => resyncs++ });
    await flushMicrotasksWithTimers();
    expect(statuses).toEqual(['connecting', 'live']);
    expect(candles).toHaveLength(1);
    expect(urls[0].searchParams.get('limit')).toBe('3');

    fail = true;
    await vi.advanceTimersByTimeAsync(70_000); // the next minute, 35 s in
    expect(statuses.at(-1)).toBe('reconnecting');
    fail = false;
    await vi.advanceTimersByTimeAsync(70_000);
    expect(statuses.at(-1)).toBe('live');
    expect(resyncs).toBe(1);

    stop();
    const polls = urls.length;
    await vi.advanceTimersByTimeAsync(180_000);
    expect(urls).toHaveLength(polls);
  });
});

describe('local symbol search', () => {
  it('matches symbols and names of the markets it knows', async () => {
    const crypto = new FakeProvider();
    crypto.symbols = () => [
      { symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT', pricePrecision: 2, minMove: 0.01 },
      { symbol: 'ETHUSDT', base: 'ETH', quote: 'USDT', pricePrecision: 2, minMove: 0.01 },
    ];
    const registry = new StaticMarketRegistry([{ id: 'binance', label: 'Crypto', provider: crypto }]);
    expect((await registry.search('eth')).map((m) => m.symbol)).toEqual(['ETHUSDT']);
    expect(searchLocal(registry.markets, '').map((m) => m.symbol)).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(registry.provider('us')).toBeNull();
  });
});

/** Lets the first poll (started at subscription) finish under fake timers. */
async function flushMicrotasksWithTimers(): Promise<void> {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
}
