import { expect, test, type Page } from '@playwright/test';
import { anchorPair, drawings, Input, lerpPoints, openApp, paneBox, settle, type XY } from './helpers';

async function center(page: Page): Promise<XY> {
  const box = await paneBox(page);
  return { x: box.x + box.width * 0.5, y: box.y + box.height * 0.5 };
}

test.describe('drawing operations', () => {
  test('eraser removes only the strokes it touches; undo restores them', async ({ page }) => {
    await openApp(page);
    const input = await Input.create(page);
    const c = await center(page);
    await input.penStroke(lerpPoints({ x: c.x - 200, y: c.y - 60 }, { x: c.x + 200, y: c.y - 60 }, 30, 8));
    await input.penStroke(lerpPoints({ x: c.x - 200, y: c.y + 80 }, { x: c.x + 200, y: c.y + 80 }, 30, 8));
    const both = await drawings(page);
    expect(both).toHaveLength(2);
    // Lower on screen = lower price.
    const lowerId = both[0].pts[1] < both[1].pts[1] ? both[0].id : both[1].id;

    await page.getByTestId('tool-eraser').click();
    // Vertical eraser stroke that crosses only the upper stroke.
    await input.penStroke(lerpPoints({ x: c.x, y: c.y - 120 }, { x: c.x, y: c.y + 10 }, 20));
    await settle(page);
    const left = await drawings(page);
    expect(left).toHaveLength(1);
    expect(left[0].id).toBe(lowerId); // only the crossed (upper) stroke was erased

    await page.getByTestId('undo').click();
    expect(await drawings(page)).toHaveLength(2);
    await page.getByTestId('redo').click();
    expect(await drawings(page)).toHaveLength(1);
  });

  test('lasso select, move and delete', async ({ page }) => {
    await openApp(page);
    const input = await Input.create(page);
    const c = await center(page);
    await input.penStroke(lerpPoints({ x: c.x - 120, y: c.y }, { x: c.x - 20, y: c.y - 40 }, 20), { holdMs: 750, page });
    await input.penStroke(lerpPoints({ x: c.x + 150, y: c.y + 100 }, { x: c.x + 260, y: c.y + 120 }, 20, 5));
    const [line] = (await drawings(page)).filter((d) => d.kind === 'line');
    expect(line).toBeTruthy();

    await page.getByTestId('tool-select').click();
    // Lasso around the line only.
    const ring: XY[] = [];
    for (let i = 0; i <= 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      ring.push({ x: c.x - 70 + Math.cos(a) * 90, y: c.y - 20 + Math.sin(a) * 60 });
    }
    await input.penStroke(ring);
    await expect.poll(() => page.evaluate(() => (window as never as { __dac: { engine: { getState(): { selectionCount: number } } } }).__dac.engine.getState().selectionCount)).toBe(1);

    // Drag the selection 60 px right and 30 px down with the pen.
    const before = await anchorPair(page, line.t1, line.p1);
    const grab = { x: (before.ours.x + c.x - 20) / 2, y: (before.ours.y + c.y - 40) / 2 };
    await input.penStroke(lerpPoints(grab, { x: grab.x + 60, y: grab.y + 30 }, 12));
    await settle(page);
    const moved = (await drawings(page)).find((d) => d.id === line.id);
    expect(moved).toBeTruthy();
    const after = await anchorPair(page, moved!.t1, moved!.p1);
    expect(after.ours.x - before.ours.x).toBeCloseTo(60, 0);
    expect(after.ours.y - before.ours.y).toBeCloseTo(30, 0);

    // Delete via keyboard; undo brings it back at the moved position.
    await page.keyboard.press('Delete');
    expect((await drawings(page)).find((d) => d.id === line.id)).toBeUndefined();
    await page.keyboard.press('Control+z');
    expect((await drawings(page)).find((d) => d.id === line.id)).toEqual(moved);
  });

  test('cancelling a selection move (Esc) leaves the drawings visible and in place', async ({ page }) => {
    await openApp(page);
    const input = await Input.create(page);
    const c = await center(page);
    await input.penStroke(lerpPoints({ x: c.x - 100, y: c.y }, { x: c.x + 100, y: c.y - 40 }, 20), { holdMs: 750, page });
    const [line] = await drawings(page);
    await page.getByTestId('tool-select').click();
    await input.penStroke(Array.from({ length: 25 }, (_, i) => ({ x: c.x + Math.cos((i / 24) * Math.PI * 2) * 150, y: c.y - 20 + Math.sin((i / 24) * Math.PI * 2) * 60 })));
    // Grab the selection and press Esc mid-drag.
    const grab = { x: c.x, y: c.y - 20 };
    await input.penDown(grab);
    await input.penMove({ x: grab.x + 30, y: grab.y + 20 });
    await page.keyboard.press('Escape');
    await input.penMove({ x: grab.x + 60, y: grab.y + 40 });
    await input.penUp({ x: grab.x + 60, y: grab.y + 40 });
    await settle(page);
    const state = await page.evaluate(() => {
      const w = (window as never as { __dac: { engine: { hiddenIds: Set<string>; lastRenderedCount: number } } }).__dac;
      return { hidden: w.engine.hiddenIds.size, rendered: w.engine.lastRenderedCount };
    });
    expect(state.hidden).toBe(0);
    expect(state.rendered).toBe(1);
    expect((await drawings(page))[0]).toEqual(line); // not moved
  });

  test('the palette toggle closes an open palette', async ({ page }) => {
    await openApp(page);
    await page.getByTestId('palette-toggle').click();
    await expect(page.getByTestId('palette')).toBeVisible();
    await page.getByTestId('palette-toggle').click();
    await expect(page.getByTestId('palette')).toBeHidden();
    await page.getByTestId('screenshot-button').click();
    await expect(page.getByTestId('screenshot-panel')).toBeVisible();
    await page.getByTestId('screenshot-button').click();
    await expect(page.getByTestId('screenshot-panel')).toBeHidden();
  });

  test('panels stay inside a Slide Over (320 px) viewport', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await openApp(page);
    for (const [button, panel] of [
      ['screenshot-button', 'screenshot-panel'],
      ['account-button', 'account-panel'],
      ['palette-toggle', 'palette'],
    ] as const) {
      await page.getByTestId(button).click();
      await expect(page.getByTestId(panel)).toBeVisible();
      const box = (await page.getByTestId(panel).boundingBox())!;
      expect(box.x, panel).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, panel).toBeLessThanOrEqual(320);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId(panel)).toBeHidden();
    }
  });

  test('palette sets colour and width for new strokes; keyboard undo/redo', async ({ page }) => {
    await openApp(page);
    const input = await Input.create(page);
    const c = await center(page);
    await page.getByTestId('palette-toggle').click();
    await page.getByRole('button', { name: 'Color #4cc9f0' }).click();
    await page.getByRole('button', { name: 'Thickness 4' }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('palette')).toBeHidden();
    // Shortcuts keep working even after the symbol <select> had focus.
    await page.getByTestId('symbol-select').focus();
    await input.penStroke(lerpPoints({ x: c.x - 100, y: c.y }, { x: c.x + 100, y: c.y + 40 }, 20, 6));
    const [d] = await drawings(page);
    expect(d.style).toEqual({ color: '#4cc9f0', width: 4 });
    await page.keyboard.press('Control+z');
    expect(await drawings(page)).toHaveLength(0);
    await page.keyboard.press('Control+Shift+z');
    expect(await drawings(page)).toHaveLength(1);
  });

  test('drawings are kept per chart (symbol/timeframe) and restored when switching back', async ({ page }) => {
    await openApp(page);
    const input = await Input.create(page);
    const c = await center(page);
    await input.penStroke(lerpPoints({ x: c.x - 100, y: c.y }, { x: c.x + 100, y: c.y + 40 }, 20, 6));
    expect(await drawings(page)).toHaveLength(1);
    await page.getByTestId('tf-4h').click();
    await expect.poll(() => page.evaluate(() => (window as never as { __dac: { getStatus(): { feed: { initialLoaded: boolean } } } }).__dac.getStatus().feed.initialLoaded)).toBe(true);
    expect(await drawings(page)).toHaveLength(0);
    await page.getByTestId('tf-1h').click();
    await expect.poll(async () => (await drawings(page)).length).toBe(1);
  });
});
