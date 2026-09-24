import { describe, expect, it } from 'vitest';
import { BinanceRestClient } from './rest';

const row = (t: number, closeTime: number) => [t, '1.0', '2.0', '0.5', '1.5', '10.0', closeTime, '15', 42, '5', '7', '0'];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('BinanceRestClient', () => {
  it('requests klines with the expected parameters and marks the forming bar open', async () => {
    const urls: string[] = [];
    const now = 1_000_000;
    const client = new BinanceRestClient({
      baseUrls: ['https://x'],
      now: () => now,
      sleep: async () => undefined,
      fetchImpl: async (input) => {
        urls.push(String(input));
        return jsonResponse([row(0, 59_999), row(999_960, 1_059_959)]);
      },
    });
    const candles = await client.fetchKlines({ symbol: 'BTCUSDT', timeframe: '1m', startTime: 0, endTime: 999_999, limit: 2 });
    expect(urls[0]).toBe('https://x/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=2&startTime=0&endTime=999999');
    expect(candles).toHaveLength(2);
    expect(candles[0]).toMatchObject({ time: 0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10, trades: 42, closed: true });
    expect(candles[1].closed).toBe(false);
  });

  it('treats opaque failures as possible rate limits: backs off and rotates hosts', async () => {
    const urls: string[] = [];
    const sleeps: number[] = [];
    let calls = 0;
    const client = new BinanceRestClient({
      baseUrls: ['https://a', 'https://b'],
      now: () => 0,
      random: () => 1,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      fetchImpl: async (input) => {
        urls.push(String(input));
        calls++;
        if (calls === 1) throw new TypeError('Failed to fetch');
        return jsonResponse([row(0, 1)]);
      },
    });
    const candles = await client.fetchKlines({ symbol: 'BTCUSDT', timeframe: '1m', limit: 1 });
    expect(candles).toHaveLength(1);
    expect(urls[0].startsWith('https://a/')).toBe(true);
    expect(urls[1].startsWith('https://b/')).toBe(true);
    expect(Math.max(...sleeps)).toBeGreaterThanOrEqual(2_000);
  });

  it('does not retry readable client errors', async () => {
    let calls = 0;
    const client = new BinanceRestClient({
      baseUrls: ['https://a'],
      sleep: async () => undefined,
      fetchImpl: async () => {
        calls++;
        return jsonResponse({ code: -1121, msg: 'Invalid symbol.' }, 400);
      },
    });
    await expect(client.fetchKlines({ symbol: 'NOPE', timeframe: '1m', limit: 1 })).rejects.toThrow('HTTP 400');
    expect(calls).toBe(1);
  });

  it('gives up after the maximum number of attempts', async () => {
    let calls = 0;
    const client = new BinanceRestClient({
      baseUrls: ['https://a'],
      maxAttempts: 3,
      sleep: async () => undefined,
      fetchImpl: async () => {
        calls++;
        throw new TypeError('Failed to fetch');
      },
    });
    await expect(client.fetchKlines({ symbol: 'BTCUSDT', timeframe: '1m', limit: 1 })).rejects.toThrow('Failed to fetch');
    expect(calls).toBe(3);
  });

  it('serializes and paces requests', async () => {
    const sleeps: number[] = [];
    let t = 0;
    const client = new BinanceRestClient({
      baseUrls: ['https://a'],
      minSpacingMs: 250,
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
      fetchImpl: async () => jsonResponse([]),
    });
    await Promise.all([
      client.fetchKlines({ symbol: 'BTCUSDT', timeframe: '1m', limit: 1 }),
      client.fetchKlines({ symbol: 'BTCUSDT', timeframe: '1m', limit: 1 }),
      client.fetchKlines({ symbol: 'BTCUSDT', timeframe: '1m', limit: 1 }),
    ]);
    expect(sleeps).toEqual([250, 250]);
  });
});
