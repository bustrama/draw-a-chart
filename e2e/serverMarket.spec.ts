import { expect, test, type Page } from '@playwright/test';
import { waitForChart } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

const H = 3_600_000;

/** Hourly bars ending at the current hour (still forming), as the server sends them. */
function wireBars(count: number): unknown[] {
  const last = Math.floor(Date.now() / H) * H;
  return Array.from({ length: count }, (_, i) => {
    const t = last - (count - 1 - i) * H;
    return [t, 100, 102, 99, 101, 5, t === last ? 0 : 1];
  });
}

/** The market-data API marks every answer; without it the app assumes there is no market server. */
const API = { 'x-market-api': '1' };

const BTC = { market: 'binance', symbol: 'BTCUSDT', name: 'BTC/USDT', base: 'BTC', quote: 'USDT', exchange: 'Binance', pricePrecision: 2, minMove: 0.01, timeZone: 'UTC', delayMs: 0, sessions: false };

async function fakeBinanceStream(page: Page): Promise<string[]> {
  const urls: string[] = [];
  await page.routeWebSocket(/binance/, (ws) => {
    urls.push(ws.url());
    ws.onMessage(() => undefined);
  });
  return urls;
}

test.describe('market data through the server (mocked API)', () => {
  test('history comes from the server, live updates straight from Binance', async ({ page }) => {
    const bars: URLSearchParams[] = [];
    await page.route('**/api/market/symbol?**', (route) => route.fulfill({ json: { symbol: BTC }, headers: API }));
    await page.route('**/api/market/bars?**', (route) => {
      bars.push(new URL(route.request().url()).searchParams);
      return route.fulfill({ json: { bars: wireBars(1000) }, headers: API });
    });
    const streams = await fakeBinanceStream(page);
    await page.goto('/?symbol=BTCUSDT&tf=1h&sync=off');
    await waitForChart(page);
    expect(await page.evaluate(() => (window as any).__dac.chart.barCount)).toBe(1000);
    expect(Object.fromEntries(bars[0])).toMatchObject({ market: 'binance', symbol: 'BTCUSDT', tf: '1h', limit: '1000' });
    await expect.poll(() => streams.some((u) => u.includes('btcusdt@kline_1h'))).toBe(true);
  });

  test('crypto falls back to Binance directly when the server cannot be reached', async ({ page }) => {
    await page.route('**/api/market/**', (route) => route.abort('connectionrefused'));
    let klines = 0;
    await page.route(/\/api\/v3\/klines/, (route) => {
      klines++;
      const rows = (wireBars(1000) as number[][]).map(([t, o, h, l, c, v]) => [t, String(o), String(h), String(l), String(c), String(v), t + H - 1, '0', 10, '0', '0', '0']);
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(rows) });
    });
    await fakeBinanceStream(page);
    await page.goto('/?symbol=BTCUSDT&tf=1h&sync=off');
    await waitForChart(page);
    expect(await page.evaluate(() => (window as any).__dac.chart.barCount)).toBe(1000);
    expect(klines).toBeGreaterThan(0);
  });

  test('a server error is shown instead of silently switching sources', async ({ page }) => {
    await page.route('**/api/market/symbol?**', (route) => route.fulfill({ json: { symbol: { ...BTC, market: 'us', symbol: 'AAPL', timeZone: 'America/New_York', sessions: false } }, headers: API }));
    await page.route('**/api/market/bars?**', (route) => route.fulfill({ status: 404, json: { error: 'unknown symbol AAPL' }, headers: API }));
    await page.goto('/?market=us&symbol=AAPL&tf=1h&sync=off');
    await expect(page.getByText('Market data unavailable: unknown symbol AAPL')).toBeVisible();
  });
});
