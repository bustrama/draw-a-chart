import { expect, test, type Page } from '@playwright/test';
import { drawings, Input, lerpPoints, paneBox, waitForChart } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

// Friday 25 Sep 2026 16:30 New York (half an hour after the close), and Monday 28 Sep 12:00.
const FRIDAY = Date.parse('2026-09-25T20:30:00Z');
const MONDAY = Date.parse('2026-09-28T16:00:00Z');
const FRIDAY_LAST_HOUR = Date.parse('2026-09-25T19:30:00Z'); // the 15:30-16:00 bar

async function openUs(page: Page, now: number, tf = '1h'): Promise<void> {
  await page.goto(`/?provider=mock&market=us&symbol=SPY&tf=${tf}&mockNow=${now}&mockLive=0`);
  await waitForChart(page);
}

function barTimes(page: Page): Promise<number[]> {
  return page.evaluate(() => (window as any).__dac.chart.candles.data().map((d: { time: number }) => d.time * 1000));
}

/** Bars (fractional) between the chart's bar at `from` and time `t`, as the chart maps them. */
function offset(page: Page, from: number, t: number): Promise<number> {
  return page.evaluate(
    ([a, b]) => {
      const idx = (window as any).__dac.chart.currentTimeIndex;
      return idx.timeToLogical(b) - idx.timeToLogical(a);
    },
    [from, t] as const,
  );
}

test.describe('US market (mock trading sessions)', () => {
  test('shows regular-hours bars only, in New York time', async ({ page }) => {
    await openUs(page, FRIDAY);
    const times = await barTimes(page);
    expect(times).toHaveLength(1000);
    expect(times.at(-1)).toBe(FRIDAY_LAST_HOUR);
    const ny = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    for (const t of times) {
      const p = Object.fromEntries(ny.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
      expect(['Sat', 'Sun']).not.toContain(p.weekday);
      expect(`${p.hour}:${p.minute}`).toMatch(/^(09:30|1[0-5]:30)$/);
    }
    await expect(page.getByTestId('live-status')).toContainText('15m delayed');
  });

  test('a drawing in the future area stays on its bar over the weekend', async ({ page }) => {
    await openUs(page, FRIDAY);
    const input = await Input.create(page);
    const box = await paneBox(page);
    // From mid-chart to three bars right of Friday's last bar: Monday's 11:30 bar.
    const endX = await page.evaluate(() => {
      const w = (window as any).__dac;
      const v = w.chart.viewport();
      const host = (document.querySelector('[data-testid=chart-host]') as HTMLElement).getBoundingClientRect();
      return host.left + w.chart.paneRect().left + v.logicalToX(w.chart.barCount - 1 + 3);
    });
    const y = box.y + box.height / 2;
    await input.penStroke(lerpPoints({ x: endX - 250, y: y - 40 }, { x: endX, y }, 30));
    const [d] = await drawings(page);
    const end = d.pts[d.pts.length - 3] as number;
    const before = await offset(page, FRIDAY_LAST_HOUR, end);
    expect(before).toBeGreaterThan(2.5);
    expect(before).toBeLessThan(3.5);

    // Monday: three new bars (9:30, 10:30, 11:30) arrived. The point keeps its place among them.
    await openUs(page, MONDAY);
    await expect.poll(async () => (await drawings(page)).length).toBe(1);
    const times = await barTimes(page);
    expect(times.slice(-3)).toEqual([Date.parse('2026-09-28T13:30:00Z'), Date.parse('2026-09-28T14:30:00Z'), Date.parse('2026-09-28T15:30:00Z')]);
    expect(await offset(page, FRIDAY_LAST_HOUR, end)).toBeCloseTo(before, 6);
  });

  test('switches markets through the symbol search and remembers recent symbols', async ({ page }) => {
    await page.goto(`/?provider=mock&mockNow=${FRIDAY}&mockLive=0`);
    await waitForChart(page);
    await page.getByTestId('symbol-select').click();
    await page.getByTestId('symbol-search-input').fill('spy');
    await page.getByTestId('symbol-option-us-SPY').click();
    await expect.poll(() => page.evaluate(() => (window as any).__dac.getStatus().market)).toEqual({ market: 'us', symbol: 'SPY', timeframe: '1h' });
    await waitForChart(page);
    expect((await barTimes(page)).at(-1)).toBe(FRIDAY_LAST_HOUR);
    await page.getByTestId('symbol-select').click();
    await expect(page.getByTestId('symbol-option-binance-BTCUSDT')).toBeVisible(); // recently charted
    await page.getByTestId('symbol-search-input').press('Enter'); // the first entry: SPY again
    await expect(page.getByTestId('symbol-search')).toBeHidden();
  });
});
