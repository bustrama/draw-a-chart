import { expect, test, type Page } from '@playwright/test';
import { drawings, Input, lerpPoints, paneBox, waitForChart } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

// Friday 25 Sep 2026 16:30 New York (the session closes at 17:00), and Monday 28 Sep 12:00.
const FRIDAY = Date.parse('2026-09-25T20:30:00Z');
const MONDAY = Date.parse('2026-09-28T16:00:00Z');
const FRIDAY_LAST_HOUR = Date.parse('2026-09-25T20:00:00Z'); // 16:00-17:00, still forming

async function openFutures(page: Page, now: number, tf = '1h'): Promise<void> {
  await page.goto(`/?provider=mock&market=futures&symbol=ES&tf=${tf}&mockNow=${now}&mockLive=0`);
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

const ny = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const parts = (t: number) => Object.fromEntries(ny.formatToParts(new Date(t)).map((x) => [x.type, x.value]));

test.describe('futures (mock CME Globex hours)', () => {
  test('trades across midnight, never in the daily break or at the weekend', async ({ page }) => {
    await openFutures(page, FRIDAY);
    const times = await barTimes(page);
    expect(times).toHaveLength(1000);
    expect(times.at(-1)).toBe(FRIDAY_LAST_HOUR);
    let midnight = 0;
    for (const [i, t] of times.entries()) {
      const p = parts(t);
      const hour = Number(p.hour);
      expect(hour, new Date(t).toISOString()).not.toBe(17);
      expect(p.weekday).not.toBe('Sat');
      if (p.weekday === 'Sun') expect(hour).toBeGreaterThanOrEqual(18);
      if (p.weekday === 'Fri') expect(hour).toBeLessThan(17);
      if (hour === 0 && i > 0 && Number(parts(times[i - 1]).hour) === 23) midnight++;
    }
    expect(midnight).toBeGreaterThan(30);
    await expect(page.getByTestId('live-status')).toContainText('10m delayed');
  });

  test('daily bars are trade dates', async ({ page }) => {
    await openFutures(page, FRIDAY, '1d');
    const times = await barTimes(page);
    expect(times.at(-1)).toBe(Date.parse('2026-09-25T04:00:00Z'));
    for (const t of times) {
      const p = parts(t);
      expect(`${p.hour}:${p.minute}`).toBe('00:00');
      expect(['Sat', 'Sun']).not.toContain(p.weekday);
    }
  });

  test('a drawing in the future area stays on its bar over the weekend', async ({ page }) => {
    await openFutures(page, FRIDAY);
    const input = await Input.create(page);
    const box = await paneBox(page);
    // From mid-chart to three bars right of Friday's last bar: Sunday's 20:00 bar.
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

    // Monday noon: Sunday evening's and Monday morning's bars have arrived; the point keeps its place.
    await openFutures(page, MONDAY);
    await expect.poll(async () => (await drawings(page)).length).toBe(1);
    const times = await barTimes(page);
    expect(times.filter((t) => t > FRIDAY_LAST_HOUR).slice(0, 3)).toEqual([Date.parse('2026-09-27T22:00:00Z'), Date.parse('2026-09-27T23:00:00Z'), Date.parse('2026-09-28T00:00:00Z')]);
    expect(await offset(page, FRIDAY_LAST_HOUR, end)).toBeCloseTo(before, 6);
  });

  test('the symbol search opens a future (ranking is tested on the server)', async ({ page }) => {
    await page.goto(`/?provider=mock&mockNow=${FRIDAY}&mockLive=0`);
    await waitForChart(page);
    await page.getByTestId('symbol-select').click();
    await page.getByTestId('symbol-search-input').fill('es');
    await expect(page.getByRole('option').first()).toHaveAttribute('data-testid', 'symbol-option-futures-ES');
    await page.getByTestId('symbol-search-input').press('Enter');
    await expect.poll(() => page.evaluate(() => (window as any).__dac.getStatus().market)).toEqual({ market: 'futures', symbol: 'ES', timeframe: '1h' });
    await waitForChart(page);
    expect((await barTimes(page)).at(-1)).toBe(FRIDAY_LAST_HOUR);
  });
});
