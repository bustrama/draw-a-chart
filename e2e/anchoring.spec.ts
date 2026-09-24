import { expect, test, type Page } from '@playwright/test';
import {
  anchorPair,
  barTime,
  colorDistanceAt,
  drawings,
  expectedClient,
  expectNear,
  Input,
  lerpPoints,
  navState,
  openApp,
  paneBox,
  priceRange,
  settle,
  waitForStableView,
} from './helpers';

/** Asserts that a line drawing renders exactly at its chart coordinates in the current view. */
async function assertLineAnchored(page: Page, label: string): Promise<void> {
  await waitForStableView(page);
  const [line] = (await drawings(page)).filter((d) => d.kind === 'line');
  expect(line, 'line drawing exists').toBeTruthy();
  for (const [t, p, name] of [
    [line.t1, line.p1, 'start'],
    [line.t2, line.p2, 'end'],
  ] as const) {
    const { ours, expected } = await anchorPair(page, t, p);
    await expectNear(ours, expected, 0.5, `${label}: ${name} (viewport vs chart coordinates)`);
  }
  // Pixel check: the stroke is actually painted at the midpoint of the expected segment.
  const a = await expectedClient(page, line.t1, line.p1);
  const b = await expectedClient(page, line.t2, line.p2);
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const box = await paneBox(page);
  if (mid.x > box.x + 2 && mid.x < box.x + box.width - 2 && mid.y > box.y + 2 && mid.y < box.y + box.height - 2) {
    expect(await colorDistanceAt(page, mid), `${label}: line pixels at midpoint`).toBeLessThan(60);
  }
}

test.describe('drawing coordinates stay anchored', () => {
  test('a line between two chart coordinates survives pan, zoom, resize and history loading', async ({ page }) => {
    await openApp(page, '&mockHistory=4000');
    const input = await Input.create(page);

    // Target two exact chart coordinates: bar open times and prices inside the visible range.
    const tA = await barTime(page, 60);
    const tB = await barTime(page, 20);
    const range = await priceRange(page);
    const pA = range.from + (range.to - range.from) * 0.3;
    const pB = range.from + (range.to - range.from) * 0.7;
    const a = await expectedClient(page, tA, pA);
    const b = await expectedClient(page, tB, pB);

    const navBefore = await page.evaluate(() => JSON.stringify((window as never as { __dac: { chart: { navState(): unknown } } }).__dac.chart.navState()));
    await input.penStroke(lerpPoints(a, b, 24, 1.5), { holdMs: 750, page });
    await settle(page);

    const all = await drawings(page);
    expect(all).toHaveLength(1);
    expect(all[0].kind).toBe('line');
    // The pen must not have moved the chart.
    const navAfter = await page.evaluate(() => JSON.stringify((window as never as { __dac: { chart: { navState(): unknown } } }).__dac.chart.navState()));
    expect(navAfter).toBe(navBefore);

    // Stored in chart space, at the intended coordinates (within one CSS pixel of input precision).
    const intervalMs = 3_600_000;
    const barSpacing = 8;
    expect(Math.abs(all[0].t1 - tA)).toBeLessThan((intervalMs / barSpacing) * 1.5);
    expect(Math.abs(all[0].t2 - tB)).toBeLessThan((intervalMs / barSpacing) * 1.5);
    await assertLineAnchored(page, 'after drawing');

    const box = await paneBox(page);
    const center = { x: box.x + box.width * 0.5, y: box.y + box.height * 0.5 };
    await page.waitForTimeout(600); // fingers right after the pen are treated as palm

    // 1) Finger pan.
    let nav = await navState(page);
    await input.fingerDrag(center, { x: center.x - 180, y: center.y }, 10);
    await settle(page);
    expect((await navState(page)).time.rightOffset).toBeGreaterThan(nav.time.rightOffset + 10);
    await assertLineAnchored(page, 'after finger pan');

    // 2) Pinch zoom in, then mouse-wheel zoom out.
    nav = await navState(page);
    await input.pinch(center, 160, 320, 10);
    await settle(page);
    expect((await navState(page)).time.barSpacing).toBeCloseTo(nav.time.barSpacing * 2, 1);
    await assertLineAnchored(page, 'after pinch zoom');
    nav = await navState(page);
    await page.mouse.move(center.x, center.y);
    await page.mouse.wheel(0, 300);
    await settle(page, 6);
    expect((await navState(page)).time.barSpacing).toBeLessThan(nav.time.barSpacing);
    await assertLineAnchored(page, 'after wheel zoom');

    // 3) Resize the chart.
    await page.setViewportSize({ width: 1000, height: 680 });
    await settle(page, 6);
    await assertLineAnchored(page, 'after resize');

    // 4) Load older history (prepends bars: every logical index shifts).
    const barsBefore = await page.evaluate(() => (window as never as { __dac: { chart: { barCount: number } } }).__dac.chart.barCount);
    await page.evaluate(() => (window as never as { __dac: { loadOlderHistory(): Promise<void> } }).__dac.loadOlderHistory());
    await settle(page, 6);
    const barsAfter = await page.evaluate(() => (window as never as { __dac: { chart: { barCount: number } } }).__dac.chart.barCount);
    expect(barsAfter).toBeGreaterThan(barsBefore);
    await assertLineAnchored(page, 'after loading older history');

    // Data itself never changed through any of this.
    const final = await drawings(page);
    expect(final[0]).toEqual(all[0]);
  });

  test('handwriting keeps its shape under non-uniform zoom while ink follows the candles', async ({ page }) => {
    await openApp(page);
    const input = await Input.create(page);
    const box = await paneBox(page);
    const o = { x: box.x + box.width * 0.45, y: box.y + box.height * 0.35 };

    // A small letter-like stroke ("N") -> glyph; a wide wavy path -> ink.
    await input.penStroke([o, { x: o.x, y: o.y - 28 }, { x: o.x + 18, y: o.y }, { x: o.x + 18, y: o.y - 28 }]);
    const inkStart = { x: box.x + box.width * 0.2, y: box.y + box.height * 0.7 };
    await input.penStroke(Array.from({ length: 40 }, (_, i) => ({ x: inkStart.x + i * 8, y: inkStart.y + Math.sin(i / 3) * 30 })));
    await settle(page);

    const measure = () =>
      page.evaluate(() => {
        type D = { kind: string; pts: number[]; at: number; ap: number; ref: number };
        type V = { timeToX(t: number): number; priceToY(p: number): number; pxPerMs: number };
        const w = (window as never as { __dac: { chart: { viewport(): V }; engine: { document: { store: { all(): D[] } } } } }).__dac;
        const v = w.chart.viewport();
        const out: Record<string, { w: number; h: number }> = {};
        for (const d of w.engine.document.store.all()) {
          const xs: number[] = [];
          const ys: number[] = [];
          for (let i = 0; i < d.pts.length; i += 3) {
            if (d.kind === 'glyph') {
              const k = Math.min(2, Math.max(0.5, Math.sqrt(v.pxPerMs / d.ref)));
              xs.push(v.timeToX(d.at) + d.pts[i] * k);
              ys.push(v.priceToY(d.ap) + d.pts[i + 1] * k);
            } else {
              xs.push(v.timeToX(d.pts[i]));
              ys.push(v.priceToY(d.pts[i + 1]));
            }
          }
          out[d.kind] = { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
        }
        return out;
      });

    const before = await measure();
    expect(Object.keys(before).sort()).toEqual(['glyph', 'ink']);
    // Touches right after the pen lifts are treated as the resting palm; wait like a user would.
    await page.waitForTimeout(600);
    // Zoom time axis in 2x with a pinch: horizontal only.
    const center = { x: box.x + box.width * 0.5, y: box.y + box.height * 0.5 };
    await input.pinch(center, 150, 300, 10);
    await settle(page);
    const after = await measure();

    const aspect = (m: { w: number; h: number }) => m.w / m.h;
    // Glyph: uniform scale -> aspect ratio preserved (within 3%).
    expect(Math.abs(aspect(after.glyph) / aspect(before.glyph) - 1)).toBeLessThan(0.03);
    // Ink: follows the candles -> stretched horizontally by the zoom.
    expect(after.ink.w / before.ink.w).toBeGreaterThan(1.6);
  });
});
