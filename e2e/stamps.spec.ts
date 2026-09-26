import { expect, test, type Page } from '@playwright/test';
import {
  barExtent,
  colorDistanceAt,
  drawings,
  highestVisibleHigh,
  Input,
  lerpPoints,
  openApp,
  paneBox,
  settle,
  STROKE_COLOR,
  viewportClient,
  waitForChart,
  type XY,
} from './helpers';

/** How far a label beside a bar reaches from its high or low (STAMP_REACH in src/drawing/stamps.ts). */
const LABEL_REACH = 22.5;

function selectionCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as never as { __dac: { engine: { getState(): { selectionCount: number } } } }).__dac.engine.getState().selectionCount);
}

/** Centre of a stamp's text below a low (tick 2-7 px under it, text from 9 px). */
const textBelow = (low: XY): XY => ({ x: low.x, y: low.y + 15 });

/** The label tool on, with the chart repainted (it may make room under the strip). */
async function labelTool(page: Page, chip: string): Promise<void> {
  await page.getByTestId('tool-stamp').click();
  await page.getByTestId(chip).click();
  await settle(page);
}

/**
 * Longest horizontal run (CSS px) of pixels close to the pen colour in the rows around client y,
 * read from the chart's own screenshot canvas.
 */
async function longestColourRun(page: Page, y: number, x0: number, x1: number): Promise<number> {
  return page.evaluate(
    ([cy, a, b]) => {
      const w = (window as never as { __dac: { chart: { takeScreenshot(): HTMLCanvasElement; paneRect(): { left: number; width: number }; chart: { priceScale(id: string): { width(): number } } } } }).__dac;
      const canvas = w.chart.takeScreenshot();
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
      const host = (document.querySelector('[data-testid=chart-host]') as HTMLElement).getBoundingClientRect();
      const pane = w.chart.paneRect();
      const dpr = canvas.width / (pane.width + w.chart.chart.priceScale('right').width() + pane.left);
      const left = Math.round((a - host.left) * dpr);
      const width = Math.round((b - a) * dpr);
      let best = 0;
      for (let dy = -2; dy <= 2; dy++) {
        const row = ctx.getImageData(left, Math.round((cy - host.top) * dpr) + dy, width, 1).data;
        let run = 0;
        for (let i = 0; i < width; i++) {
          const near = Math.hypot(row[i * 4] - 0xff, row[i * 4 + 1] - 0xd1, row[i * 4 + 2] - 0x66) < 200;
          run = near ? run + 1 : 0;
          best = Math.max(best, run);
        }
      }
      return best / dpr;
    },
    [y, x0, x1] as const,
  );
}

test.describe('Wyckoff label stamps', () => {
  test('a label goes above the high or below the low of the bar under the pen', async ({ page }) => {
    await openApp(page);
    const input = await Input.create(page);
    await expect(page.getByTestId('label-strip')).toHaveCount(0);
    await page.getByTestId('tool-stamp').click();
    await expect(page.getByTestId('label-strip')).toBeVisible();
    await expect(page.getByTestId('stamp-ps')).toHaveAttribute('aria-pressed', 'true');

    await page.getByTestId('stamp-sc').click();
    await settle(page);
    await expect(page.getByTestId('stamp-sc')).toHaveAttribute('aria-pressed', 'true');
    const down = await barExtent(page, 40);
    const atLow = await viewportClient(page, down.t, down.low);
    await input.penStroke([{ x: atLow.x + 2, y: atLow.y + 12 }]); // under the bar, off its centre

    await page.getByTestId('stamp-ar').click();
    const up = await barExtent(page, 30);
    const atHigh = await viewportClient(page, up.t, up.high);
    await input.penStroke([{ x: atHigh.x - 2, y: atHigh.y - 12 }]);

    expect(await drawings(page)).toMatchObject([
      { kind: 'stamp', label: 'SC', t: down.t, p: down.low, place: 'below', style: { color: '#ffd166' } },
      { kind: 'stamp', label: 'AR', t: up.t, p: up.high, place: 'above' },
    ]);
    // Painted by the chart itself (so also in screenshots): the text under the low, over the high.
    await settle(page);
    expect(await colorDistanceAt(page, textBelow(atLow), STROKE_COLOR, 5)).toBeLessThan(60);
    expect(await colorDistanceAt(page, { x: atHigh.x, y: atHigh.y - 15 }, STROKE_COLOR, 5)).toBeLessThan(60);
  });

  test('a phase goes to the time of the bar under the pen, at the pen height, in a box', async ({ page }) => {
    await openApp(page);
    const input = await Input.create(page);
    await labelTool(page, 'stamp-phase-c');
    const b = await barExtent(page, 20);
    const at = await viewportClient(page, b.t, b.low);
    const box = await paneBox(page);
    const target = { x: at.x + 3, y: box.y + box.height * 0.45 };
    await input.penStroke([target]);

    const [phase] = await drawings(page);
    expect(phase).toMatchObject({ kind: 'stamp', label: 'Phase C', t: b.t, place: 'at' });
    const drawnAt = await viewportClient(page, phase.t, phase.p);
    expect(Math.abs(drawnAt.y - target.y)).toBeLessThan(0.5);
    await settle(page);
    // The box's top edge: a long line in the pen colour above the text (12 px text, 3 px padding).
    expect(await longestColourRun(page, drawnAt.y - 8.5, drawnAt.x - 40, drawnAt.x + 40)).toBeGreaterThan(30);
  });

  test('a stamp follows the pen until it lifts', async ({ page }) => {
    await openApp(page);
    const input = await Input.create(page);
    await labelTool(page, 'stamp-spring');
    const first = await barExtent(page, 50);
    const last = await barExtent(page, 44);
    const a = await viewportClient(page, first.t, first.low);
    const b = await viewportClient(page, last.t, last.low);
    await input.penDown({ x: a.x, y: a.y + 12 });
    for (const p of lerpPoints({ x: a.x, y: a.y + 12 }, { x: b.x, y: b.y + 12 }, 8)) await input.penMove(p);
    expect(await drawings(page)).toHaveLength(0); // nothing is placed before the pen lifts
    await input.penUp({ x: b.x, y: b.y + 12 });
    expect(await drawings(page)).toMatchObject([{ label: 'Spring', t: last.t, p: last.low, place: 'below' }]);
  });

  test('lifting the pen outside the chart places nothing', async ({ page }) => {
    await openApp(page);
    const input = await Input.create(page);
    await labelTool(page, 'stamp-sc');
    const b = await barExtent(page, 40);
    const low = await viewportClient(page, b.t, b.low);
    const box = await paneBox(page);
    const start = { x: low.x, y: low.y + 12 };
    const off = { x: box.x + box.width + 20, y: start.y }; // over the price axis
    await input.penDown(start);
    for (const p of lerpPoints(start, off, 8)) await input.penMove(p);
    await input.penUp(off);
    expect(await drawings(page)).toHaveLength(0);

    // Up under the label strip counts as outside too (it would be hidden there).
    const strip = (await page.getByTestId('label-strip').boundingBox())!;
    const under = { x: start.x, y: strip.y + strip.height / 2 };
    await input.penDown(start);
    for (const p of lerpPoints(start, under, 8)) await input.penMove(p);
    await input.penUp(under);
    expect(await drawings(page)).toHaveLength(0);

    // Coming back over the chart before lifting places it after all.
    await input.penDown(start);
    for (const p of [...lerpPoints(start, off, 8), ...lerpPoints(off, start, 8)]) await input.penMove(p);
    await input.penUp(start);
    expect(await drawings(page)).toMatchObject([{ label: 'SC', t: b.t, p: b.low }]);
  });

  test('a stamp is erased, selected, moved to another bar and undone like any drawing', async ({ page }) => {
    await openApp(page);
    const input = await Input.create(page);
    await labelTool(page, 'stamp-st');
    const b = await barExtent(page, 40);
    const low = await viewportClient(page, b.t, b.low);
    await input.penStroke([{ x: low.x, y: low.y + 12 }]);
    const [placed] = await drawings(page);

    // The eraser crossing its text removes it; undo brings it back.
    await page.getByTestId('tool-eraser').click();
    await settle(page); // the room kept under the label strip is given back
    const shown = textBelow(await viewportClient(page, placed.t, placed.p));
    await input.penStroke(lerpPoints({ x: shown.x - 30, y: shown.y }, { x: shown.x + 30, y: shown.y }, 12));
    expect(await drawings(page)).toHaveLength(0);
    await page.getByTestId('undo').click();
    expect(await drawings(page)).toEqual([placed]);

    // A tap on its text selects it; a nudge that keeps it on its bar changes nothing.
    await page.getByTestId('tool-select').click();
    await settle(page);
    const grab = textBelow(await viewportClient(page, placed.t, placed.p));
    await input.penStroke([grab]);
    await expect.poll(() => selectionCount(page)).toBe(1);
    const version = () => page.evaluate(() => (window as never as { __dac: { engine: { document: { store: { version: number } } } } }).__dac.engine.document.store.version);
    const before = await version();
    await input.penStroke(lerpPoints(grab, { x: grab.x + 2, y: grab.y + 2 }, 4));
    await settle(page);
    expect(await version()).toBe(before);
    expect(await drawings(page)).toEqual([placed]);

    // Dropped under another bar, it lands on that bar's low. Its text decides the side: dropped
    // higher than a label sits (by more than half the bar), it still goes under the low.
    const target = await barExtent(page, 34);
    const targetLow = await viewportClient(page, target.t, target.low);
    const halfBar = (targetLow.y - (await viewportClient(page, target.t, target.high)).y) / 2;
    const drop = textBelow(targetLow);
    await input.penStroke(lerpPoints(grab, { x: drop.x + 3, y: drop.y - halfBar - 3 }, 10));
    await settle(page);
    const [moved] = await drawings(page);
    expect(moved).toMatchObject({ id: placed.id, label: 'ST', t: target.t, p: target.low, place: 'below' });

    await page.keyboard.press('Delete');
    expect(await drawings(page)).toHaveLength(0);
    await page.keyboard.press('Control+z');
    expect(await drawings(page)).toEqual([moved]);
  });

  test('the chart keeps room under the strip for a label above the highest bar', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 560 });
    await openApp(page);
    // Bars 80 to 1 before the last one on screen, unambiguously (no bar half visible at the edges).
    await page.evaluate(() => {
      const chart = (window as never as { __dac: { chart: { barCount: number; chart: { timeScale(): { setVisibleLogicalRange(r: object): void } } } } }).__dac.chart;
      chart.chart.timeScale().setVisibleLogicalRange({ from: chart.barCount - 80.3, to: chart.barCount + 4 });
    });
    await settle(page);
    const pane = await paneBox(page);
    const defaultTop = pane.height * 0.08;
    expect(Math.abs((await highestVisibleHigh(page)).y - defaultTop)).toBeLessThan(1.5);

    await labelTool(page, 'stamp-bc');
    const strip = await page.getByTestId('label-strip').boundingBox();
    const stripBottom = strip!.y + strip!.height - pane.y;
    expect(stripBottom).toBeGreaterThan(defaultTop); // the strip would cover labels above the top bar
    expect((await highestVisibleHigh(page)).y - stripBottom).toBeGreaterThanOrEqual(LABEL_REACH);

    await page.getByTestId('tool-pen').click();
    await settle(page);
    expect(Math.abs((await highestVisibleHigh(page)).y - defaultTop)).toBeLessThan(1.5);
  });

  test('picking the label tool mid-stroke makes room under the strip only once the pen lifts', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 560 });
    await openApp(page);
    const input = await Input.create(page);
    const box = await paneBox(page);
    const a = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.6 };
    const b = { x: a.x + 80, y: a.y };
    const before = await highestVisibleHigh(page);
    await input.penDown(a);
    for (const p of lerpPoints(a, b, 6)) await input.penMove(p);
    await page.keyboard.press('l');
    await expect(page.getByTestId('label-strip')).toBeVisible();
    await settle(page);
    expect((await highestVisibleHigh(page)).y).toBe(before.y); // nothing moves under the pen
    await input.penUp(b);
    await settle(page);
    expect((await highestVisibleHigh(page)).y).toBeGreaterThan(before.y + 5);
  });

  test('L picks the labels tool, the strip shows only with it, and stamps survive a reload', async ({ page }) => {
    await openApp(page);
    const input = await Input.create(page);
    await page.keyboard.press('l');
    await expect(page.getByTestId('tool-stamp')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('stamp-3rd-b').click();
    await settle(page);
    const b = await barExtent(page, 25);
    const high = await viewportClient(page, b.t, b.high);
    await input.penStroke([{ x: high.x, y: high.y - 12 }]);
    await page.keyboard.press('p');
    await expect(page.getByTestId('label-strip')).toHaveCount(0);

    const before = await drawings(page);
    expect(before).toMatchObject([{ label: '3rd B', place: 'above', p: b.high }]);
    await expect
      .poll(() => page.evaluate(() => (window as never as { __dacRuntime: { sync: { getStatus(): { pending: number } } } }).__dacRuntime.sync.getStatus().pending))
      .toBe(1);
    await page.reload();
    await waitForChart(page);
    await expect.poll(() => drawings(page)).toEqual(before);
  });
});
