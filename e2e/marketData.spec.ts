import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { waitForChart } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

const H = 3_600_000;

interface FakeBinance {
  sockets: WebSocketRoute[];
  closed: Set<WebSocketRoute>;
  restQueries: URLSearchParams[];
  lastBar: number;
  /** Bars (open times) the fake exchange does not have (simulated outage). */
  missing: Set<number>;
  /** The currently connected socket (dev StrictMode opens and closes a first one). */
  active(): WebSocketRoute;
  openCount(): number;
}

function row(t: number, close = 100 + (t / H) % 50): unknown[] {
  return [t, String(close - 1), String(close + 2), String(close - 3), String(close), '10.5', t + H - 1, '1000', 500, '5', '500', '0'];
}

/** Installs a fake Binance (REST klines + combined kline stream) for BTCUSDT 1h. */
async function fakeBinance(page: Page, lagBars = 0): Promise<FakeBinance> {
  // lagBars > 0 starts the fake exchange behind the real clock so it can "advance" to bars that
  // already exist in real time (REST never returns bars that open in the future).
  const lastBar = Math.floor(Date.now() / H) * H - lagBars * H;
  const fake: FakeBinance = {
    sockets: [],
    closed: new Set(),
    restQueries: [],
    lastBar,
    missing: new Set(),
    active() {
      const open = this.sockets.filter((s) => !this.closed.has(s));
      if (open.length !== 1) throw new Error(`expected exactly one open socket, found ${open.length}`);
      return open[0];
    },
    openCount() {
      return this.sockets.filter((s) => !this.closed.has(s)).length;
    },
  };
  const first = lastBar - 2999 * H;
  await page.route(/\/api\/v3\/klines/, async (route) => {
    const q = new URL(route.request().url()).searchParams;
    fake.restQueries.push(q);
    const limit = Number(q.get('limit') ?? 500);
    const start = q.get('startTime') ? Number(q.get('startTime')) : undefined;
    const end = q.get('endTime') ? Number(q.get('endTime')) : undefined;
    const upper = Math.min(fake.lastBar, end !== undefined ? Math.floor(end / H) * H : fake.lastBar);
    let times: number[] = [];
    if (start !== undefined) {
      for (let t = Math.max(first, Math.ceil(start / H) * H); t <= upper && times.length < limit; t += H) times.push(t);
    } else {
      for (let t = upper; t >= first && times.length < limit; t -= H) times.unshift(t);
    }
    times = times.filter((t) => !fake.missing.has(t));
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(times.map((t) => row(t))) });
  });
  await page.routeWebSocket(/binance/, (ws) => {
    fake.sockets.push(ws);
    ws.onMessage(() => undefined); // SUBSCRIBE/UNSUBSCRIBE acks are not needed
    ws.onClose(() => fake.closed.add(ws));
  });
  return fake;
}

function kline(t: number, close: number, closed = false, trades = 100_000) {
  return JSON.stringify({
    stream: 'btcusdt@kline_1h',
    data: { e: 'kline', E: Date.now(), s: 'BTCUSDT', k: { t, T: t + H - 1, s: 'BTCUSDT', i: '1h', o: '100', c: String(close), h: '9999', l: '1', v: '12.5', n: trades, x: closed } },
  });
}

async function seriesTimes(page: Page): Promise<number[]> {
  return page.evaluate(() => (window as any).__dac.chart.candles.data().map((d: { time: number }) => d.time * 1000));
}

async function openBinance(page: Page, lagBars = 0): Promise<FakeBinance> {
  const fake = await fakeBinance(page, lagBars);
  await page.goto('/?provider=binance&symbol=BTCUSDT&tf=1h');
  await waitForChart(page);
  await expect.poll(() => fake.openCount()).toBe(1);
  return fake;
}

test.describe('market data (direct Binance code path, mocked network)', () => {
  test('loads normalized history and applies live updates to the forming candle', async ({ page }) => {
    const fake = await openBinance(page);
    const times = await seriesTimes(page);
    expect(times.length).toBe(1000);
    expect(times.at(-1)).toBe(fake.lastBar);
    expect(new Set(times).size).toBe(times.length);
    expect(fake.active().url()).toContain('stream?streams=btcusdt@kline_1h');

    fake.active().send(kline(fake.lastBar, 123.45));
    await expect.poll(() => page.evaluate(() => (window as any).__dac.chart.candles.data().at(-1).close)).toBe(123.45);
    expect((await seriesTimes(page)).length).toBe(1000);
  });

  test('never creates duplicate candles and appends new bars once', async ({ page }) => {
    const fake = await openBinance(page);
    const ws = fake.active();
    ws.send(kline(fake.lastBar, 150, true));
    ws.send(kline(fake.lastBar + H, 151));
    ws.send(kline(fake.lastBar + H, 151)); // duplicate delivery
    ws.send(kline(fake.lastBar, 149, false, 5)); // stale, out-of-order update for the closed bar
    await expect.poll(async () => (await seriesTimes(page)).length).toBe(1001);
    const times = await seriesTimes(page);
    expect(new Set(times).size).toBe(times.length);
    const last2 = await page.evaluate(() => (window as any).__dac.chart.candles.data().slice(-2).map((d: { close: number }) => d.close));
    expect(last2).toEqual([150, 151]); // closed bar kept its final value
  });

  test('detects skipped bars and backfills them from REST', async ({ page }) => {
    const fake = await openBinance(page);
    const before = fake.restQueries.length;
    fake.lastBar += 3 * H; // the exchange moved on while we missed two bars
    fake.active().send(kline(fake.lastBar, 200));
    await expect.poll(async () => (await seriesTimes(page)).length).toBe(1003);
    const backfill = fake.restQueries.slice(before).find((q) => q.get('startTime') !== null);
    expect(backfill?.get('startTime')).toBe(String(fake.lastBar - 3 * H));
    const times = await seriesTimes(page);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBe(H);
  });

  test('reconnects after the connection drops and recovers missed candles', async ({ page }) => {
    const fake = await openBinance(page, 1);
    const restBefore = fake.restQueries.length;
    fake.lastBar += H; // a new bar opened while disconnected
    const dropped = fake.active();
    fake.closed.add(dropped);
    await dropped.close({ code: 4000, reason: 'network' });
    await expect.poll(() => fake.openCount(), { timeout: 10_000 }).toBe(1);
    expect(fake.active()).not.toBe(dropped);
    expect(fake.active().url()).toContain('btcusdt@kline_1h');
    await expect.poll(async () => (await seriesTimes(page)).at(-1), { timeout: 10_000 }).toBe(fake.lastBar);
    const resync = fake.restQueries.slice(restBefore).find((q) => q.get('startTime') !== null);
    expect(resync?.get('startTime')).toBe(String(fake.lastBar - H));
    await expect.poll(() => page.evaluate(() => (window as any).__dac.getStatus().feed.live)).toBe('live');
  });

  test('switching symbol/timeframe re-subscribes and drops the old stream', async ({ page }) => {
    const fake = await openBinance(page);
    const sent: string[] = [];
    fake.active().onMessage((m) => sent.push(String(m)));
    await page.getByTestId('tf-4h').click();
    await expect.poll(() => sent.some((m) => m.includes('SUBSCRIBE') && m.includes('btcusdt@kline_4h'))).toBe(true);
    await expect.poll(() => sent.some((m) => m.includes('UNSUBSCRIBE') && m.includes('btcusdt@kline_1h'))).toBe(true);
  });
});
