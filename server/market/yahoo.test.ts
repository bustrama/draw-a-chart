import { describe, expect, it } from 'vitest';
import { HttpClient, UpstreamError } from './upstream.ts';
import { YahooUpstream } from './yahoo.ts';

const MIN = 60_000;
const DAY = 86_400_000;
const NOW = Date.parse('2026-09-28T14:40:00Z');
const z = (iso: string) => Date.parse(iso);
const sec = (iso: string) => z(iso) / 1000;

/** A Yahoo stand-in answering every request with `answer(url)` (JSON, or a status and JSON). */
function yahooWith(answer: (url: URL) => unknown | { status: number; body: unknown }) {
  const urls: URL[] = [];
  const http = new HttpClient({
    name: 'Yahoo',
    perSecond: 1000,
    burst: 1000,
    maxAttempts: 1,
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      urls.push(url);
      const a = answer(url) as { status?: number; body?: unknown };
      const status = typeof a?.status === 'number' ? a.status : 200;
      return new Response(JSON.stringify(status === 200 && a?.body === undefined ? a : a.body), { status, headers: { 'content-type': 'application/json' } });
    },
  });
  return { urls, yahoo: new YahooUpstream({ http, now: () => NOW, baseUrl: 'https://yahoo.test' }) };
}

const chart = (timestamp: number[], quote: Record<string, Array<number | null>>) => ({ chart: { result: [{ meta: {}, timestamp, indicators: { quote: [quote] } }], error: null } });

describe('Yahoo upstream', () => {
  it('skips empty rows and folds the latest trade into the bar it falls in', async () => {
    const { yahoo, urls } = yahooWith(() =>
      chart([sec('2026-09-28T13:55:00Z'), sec('2026-09-28T14:00:00Z'), sec('2026-09-28T14:05:00Z'), sec('2026-09-28T14:07:27Z')], {
        open: [null, 10, 11, 11.75],
        high: [null, 12, 11.5, 11.75],
        low: [null, 9, 10.5, 11.75],
        close: [null, 11, 11, 11.75],
        volume: [null, 5, 3, 0],
      }),
    );
    const bars = await yahoo.bars('ES=F', '5m', z('2026-09-28T13:50:00Z'), z('2026-09-28T14:05:00Z'));
    expect(bars).toEqual([
      { t: z('2026-09-28T14:00:00Z'), o: 10, h: 12, l: 9, c: 11, v: 5 },
      { t: z('2026-09-28T14:05:00Z'), o: 11, h: 11.75, l: 10.5, c: 11.75, v: 3 },
    ]);
    expect(urls[0].pathname).toBe('/v8/finance/chart/ES%3DF');
    // From 30 bars early (Yahoo's first row has no volume) to past the last bar's open.
    expect(Object.fromEntries(urls[0].searchParams)).toEqual({ interval: '5m', period1: String(sec('2026-09-28T11:20:00Z')), period2: String(sec('2026-09-28T14:10:00Z')) });
  });

  it("drops the first row of an answer, which Yahoo sends without volume", async () => {
    // Like Yahoo: a row every 5 minutes from period1 on, the first one with volume 0.
    const { yahoo } = yahooWith((url) => {
      const from = Number(url.searchParams.get('period1'));
      const times = Array.from({ length: 40 }, (_, i) => from + i * 300);
      return chart(times, { open: times.map(() => 10), high: times.map(() => 11), low: times.map(() => 9), close: times.map(() => 10), volume: times.map((_, i) => (i === 0 ? 0 : 7)) });
    });
    const bars = await yahoo.bars('ES=F', '5m', z('2026-09-28T13:00:00Z'), z('2026-09-28T13:30:00Z'));
    expect(bars.map((b) => b.v)).toEqual([7, 7, 7, 7, 7, 7, 7]);
  });

  it('answers nothing for a range before the contract has data', async () => {
    const before = yahooWith(() => ({ status: 400, body: { chart: { result: null, error: { code: 'Bad Request', description: "Data doesn't exist for startDate = 1420070400, endDate = 1451606400" } } } }));
    expect(await before.yahoo.bars('MES=F', '1d', z('2015-01-01T00:00:00Z'), z('2016-01-01T00:00:00Z'))).toEqual([]);
    const other = yahooWith(() => ({ status: 400, body: { chart: { result: null, error: { code: 'Bad Request', description: 'Invalid input - interval=7m is not supported' } } } }));
    await expect(other.yahoo.bars('ES=F', '1d', z('2015-01-01T00:00:00Z'), z('2016-01-01T00:00:00Z'))).rejects.toThrow('not supported');
  });

  it("never asks for more than Yahoo's history, a week of minutes at a time", async () => {
    const { yahoo, urls } = yahooWith(() => chart([], {}));
    expect(await yahoo.bars('ES=F', '1m', NOW - 40 * DAY, NOW)).toEqual([]);
    // Callers plan with a day to spare; requests go as far as Yahoo's 30 days (less an hour).
    expect(yahoo.historyStart('1m')).toBe(NOW - 29 * DAY);
    expect(yahoo.historyStart('1d')).toBeNull();
    expect(urls).toHaveLength(5); // 30 days in 7-day requests
    expect(Number(urls[0].searchParams.get('period1'))).toBe(Math.floor((NOW - 30 * DAY + 60 * MIN) / 1000));
    for (const u of urls) expect(Number(u.searchParams.get('period2')) - Number(u.searchParams.get('period1'))).toBeLessThanOrEqual(8 * 86_400);
    expect(await yahoo.bars('ES=F', '5m', NOW - 90 * DAY, NOW - 70 * DAY)).toEqual([]);
    expect(urls).toHaveLength(5); // entirely before the 5-minute history: not asked at all
  });

  it('keeps daily bars at their midnight and accepts prices below zero', async () => {
    const { yahoo } = yahooWith(() => chart([sec('2020-04-20T04:00:00Z')], { open: [17.73], high: [17.85], low: [-40.32], close: [-37.63], volume: [247947] }));
    expect(await yahoo.bars('CL=F', '1d', z('2020-04-20T00:00:00Z'), z('2020-04-21T00:00:00Z'))).toEqual([{ t: z('2020-04-20T04:00:00Z'), o: 17.73, h: 17.85, l: -40.32, c: -37.63, v: 247947 }]);
  });

  it("reports Yahoo's own error", async () => {
    const { yahoo } = yahooWith(() => ({ status: 404, body: { chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } } } }));
    await expect(yahoo.bars('XX=F', '60m', NOW - 5 * MIN, NOW)).rejects.toBeInstanceOf(UpstreamError);
    const empty = yahooWith(() => ({ chart: { result: null, error: { description: 'No data found, symbol may be delisted' } } }));
    await expect(empty.yahoo.bars('XX=F', '60m', NOW - 5 * MIN, NOW)).rejects.toThrow('No data found');
  });
});
