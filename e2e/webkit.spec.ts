import { expect, test } from '@playwright/test';
import {
  anchorPair,
  barExtent,
  colorDistanceAt,
  drawings,
  expectNear,
  lerpPoints,
  navState,
  openApp,
  paneBox,
  settle,
  SynthInput,
  viewportClient,
  visiblePointOnSegment,
  waitForChart,
  waitForStableView,
} from './helpers';

// WebKit engine with an iPad-like context (see the 'webkit-ipad' project). Synthetic pointer
// events only — this checks engine compatibility, NOT real Apple Pencil behaviour.
test.describe('WebKit (iPad-like context)', () => {
  test('pen draws and straightens; fingers pan; drawings stay anchored at DPR 2', async ({ page }) => {
    await openApp(page);
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(2);
    const input = new SynthInput(page);
    const box = await paneBox(page);
    const a = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.35 };
    const b = { x: box.x + box.width * 0.65, y: box.y + box.height * 0.6 };
    const before = await navState(page);

    await input.penStroke(lerpPoints(a, b, 30, 1.5), { holdMs: 750 });
    await input.penStroke(lerpPoints({ x: a.x, y: a.y + 150 }, { x: b.x, y: b.y + 120 }, 30, 10));
    await settle(page);
    const all = await drawings(page);
    expect(all.map((d) => d.kind).sort()).toEqual(['ink', 'line']);
    expect(await navState(page)).toEqual(before);

    await page.waitForTimeout(600);
    await input.fingerDrag({ x: box.x + box.width / 2, y: box.y + box.height / 2 }, { x: box.x + box.width / 2 - 160, y: box.y + box.height / 2 }, 12);
    await waitForStableView(page);
    expect((await navState(page)).time.rightOffset).toBeGreaterThan(before.time.rightOffset + 10);
    expect(await drawings(page)).toHaveLength(2);

    const line = all.find((d) => d.kind === 'line')!;
    for (const [t, p] of [
      [line.t1, line.p1],
      [line.t2, line.p2],
    ] as const) {
      const { ours, expected } = await anchorPair(page, t, p);
      await expectNear(ours, expected, 0.5, 'line endpoint after pan');
    }
    const s = await anchorPair(page, line.t1, line.p1);
    const e = await anchorPair(page, line.t2, line.p2);
    const visible = visiblePointOnSegment(s.expected, e.expected, await paneBox(page));
    expect(visible, 'part of the line is still on screen').not.toBeNull();
    expect(await colorDistanceAt(page, visible!)).toBeLessThan(60);
  });

  test('a label stamp lands under the low of the tapped bar and is painted at DPR 2', async ({ page }) => {
    await openApp(page);
    const input = new SynthInput(page);
    await page.getByTestId('tool-stamp').click();
    await page.getByTestId('stamp-sc').click();
    const bar = await barExtent(page, 40);
    const low = await viewportClient(page, bar.t, bar.low);
    await input.penStroke([{ x: low.x, y: low.y + 12 }]);
    expect(await drawings(page)).toMatchObject([{ kind: 'stamp', label: 'SC', t: bar.t, p: bar.low, place: 'below' }]);
    await settle(page);
    expect(await colorDistanceAt(page, { x: low.x, y: low.y + 15 }, undefined, 5)).toBeLessThan(60);
  });

  test('persists drawings across reloads and exports a PNG', async ({ page }) => {
    await openApp(page);
    const input = new SynthInput(page);
    const box = await paneBox(page);
    await input.penStroke(lerpPoints({ x: box.x + 200, y: box.y + 200 }, { x: box.x + 500, y: box.y + 260 }, 30, 6));
    await expect
      .poll(() => page.evaluate(() => (window as never as { __dacRuntime: { sync: { getStatus(): { pending: number } } } }).__dacRuntime.sync.getStatus().pending))
      .toBe(1);
    await page.reload();
    await waitForChart(page);
    await expect.poll(async () => (await drawings(page)).length).toBe(1);

    await page.getByTestId('screenshot-button').click();
    await expect(page.getByTestId('screenshot-preview')).toBeVisible();
    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('screenshot-download').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.png$/);
  });
});
