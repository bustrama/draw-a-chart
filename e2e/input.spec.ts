import { expect, test, type Page } from '@playwright/test';
import { drawings, Input, lerpPoints, navState, openApp, paneBox, settle, waitForStableView, type XY } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */

async function paneCenter(page: Page): Promise<XY> {
  const box = await paneBox(page);
  return { x: box.x + box.width * 0.5, y: box.y + box.height * 0.5 };
}

async function engineState(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => (window as any).__dac.engine.getState());
}

/** Synthetic (untrusted) pointer event dispatched at the element under the point. */
async function synthPointer(page: Page, type: string, p: XY, init: Record<string, unknown>): Promise<void> {
  await page.evaluate(
    ([t, pt, extra]) => {
      const target = document.elementFromPoint(pt.x, pt.y) ?? document.body;
      target.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, composed: true, clientX: pt.x, clientY: pt.y, isPrimary: true, ...extra }));
    },
    [type, p, init] as const,
  );
}

test.describe('input routing: pen draws, fingers navigate', () => {
  test('pen strokes create drawings and never move the chart', async ({ page }) => {
    await openApp(page);
    const input = await Input.create(page);
    const c = await paneCenter(page);
    const before = await navState(page);
    await input.penStroke(lerpPoints({ x: c.x - 150, y: c.y }, { x: c.x + 150, y: c.y + 60 }, 30, 12));
    await settle(page);
    expect(await drawings(page)).toHaveLength(1);
    expect(await navState(page)).toEqual(before);
    expect((await engineState(page)).strokeActive).toBe(false);
  });

  test('finger drags pan the chart and never draw', async ({ page }) => {
    await openApp(page);
    const input = await Input.create(page);
    const c = await paneCenter(page);
    const before = await navState(page);
    await input.fingerDrag(c, { x: c.x + 200, y: c.y }, 10);
    await waitForStableView(page);
    const after = await navState(page);
    expect(after.time.rightOffset).toBeLessThan(before.time.rightOffset - 15); // dragged right = older bars
    expect(await drawings(page)).toHaveLength(0);
  });

  test('a deliberate vertical finger drag pans price and turns auto-scale off', async ({ page }) => {
    await openApp(page);
    const input = await Input.create(page);
    const c = await paneCenter(page);
    expect((await navState(page)).price?.auto).toBe(true);
    await input.fingerDrag({ x: c.x, y: c.y - 100 }, { x: c.x, y: c.y + 100 }, 12);
    await waitForStableView(page);
    const after = await navState(page);
    expect(after.price?.auto).toBe(false);
    expect(await drawings(page)).toHaveLength(0);
  });

  test('pinch zoom keeps the chart point under the fingers fixed', async ({ page }) => {
    await openApp(page);
    const input = await Input.create(page);
    const box = await paneBox(page);
    const center = { x: box.x + box.width * 0.4, y: box.y + box.height * 0.5 };
    const logicalAt = () =>
      page.evaluate((x) => {
        const w = (window as any).__dac;
        return w.chart.viewport().xToLogical(x - (document.querySelector('[data-testid=chart-host]') as HTMLElement).getBoundingClientRect().left - w.chart.paneRect().left);
      }, center.x);
    const before = await logicalAt();
    const nav = await navState(page);
    await input.pinch(center, 120, 360, 12);
    await waitForStableView(page);
    const after = await navState(page);
    expect(after.time.barSpacing / nav.time.barSpacing).toBeCloseTo(3, 1);
    // The logical index under the pinch centre moved by less than a tenth of a bar.
    expect(Math.abs((await logicalAt()) - before)).toBeLessThan(0.1);
  });

  test('mouse drag pans natively; mouse-draw mode draws instead', async ({ page }) => {
    await openApp(page);
    const c = await paneCenter(page);
    const before = await navState(page);
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(c.x + 150, c.y, { steps: 8 });
    await page.mouse.up();
    await waitForStableView(page);
    expect((await navState(page)).time.rightOffset).toBeLessThan(before.time.rightOffset - 10);
    expect(await drawings(page)).toHaveLength(0);

    await page.keyboard.press('d'); // mouse-draw mode
    const mid = await navState(page);
    await page.mouse.move(c.x - 100, c.y + 40);
    await page.mouse.down();
    await page.mouse.move(c.x + 100, c.y - 40, { steps: 15 });
    await page.mouse.up();
    await settle(page);
    expect(await drawings(page)).toHaveLength(1);
    expect(await navState(page)).toEqual(mid);
  });

  test('pen hover and strokes never show the crosshair; the mouse still does', async ({ page }) => {
    await openApp(page);
    // Pixels painted by the crosshair layer = difference between screenshots with and without it.
    const crosshairPixels = () =>
      page.evaluate(() => {
        const chart = (window as any).__dac.chart.chart;
        const withTop: HTMLCanvasElement = chart.takeScreenshot(true, true);
        const without: HTMLCanvasElement = chart.takeScreenshot(false, false);
        const a = (withTop.getContext('2d') as CanvasRenderingContext2D).getImageData(0, 0, withTop.width, withTop.height).data;
        const b = (without.getContext('2d') as CanvasRenderingContext2D).getImageData(0, 0, without.width, without.height).data;
        let diff = 0;
        for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) diff++;
        return diff;
      });
    const input = await Input.create(page);
    const c = await paneCenter(page);
    for (let i = 0; i < 6; i++) await input.penHover({ x: c.x - 60 + i * 20, y: c.y - 40 });
    await settle(page);
    expect(await crosshairPixels(), 'pen hover').toBe(0);
    await input.penStroke(lerpPoints({ x: c.x - 60, y: c.y }, { x: c.x + 60, y: c.y + 20 }, 12));
    await settle(page);
    expect(await crosshairPixels(), 'after pen stroke').toBe(0);
    await page.waitForTimeout(600);
    await page.mouse.move(c.x + 100, c.y - 50);
    await page.mouse.move(c.x + 120, c.y - 40);
    await settle(page);
    expect(await crosshairPixels(), 'mouse hover').toBeGreaterThan(100);
  });

  test('pen taps produce no chart clicks (compatibility mouse events are suppressed)', async ({ page }) => {
    await openApp(page);
    await page.evaluate(() => {
      const w = (window as any).__dac;
      (window as any).__clicks = 0;
      w.chart.chart.subscribeClick(() => ((window as any).__clicks += 1));
    });
    const input = await Input.create(page);
    const c = await paneCenter(page);
    await input.penDown(c);
    await input.penUp(c);
    await settle(page);
    expect(await page.evaluate(() => (window as any).__clicks)).toBe(0);
    await page.waitForTimeout(600);
    await page.mouse.click(c.x + 40, c.y);
    await settle(page);
    expect(await page.evaluate(() => (window as any).__clicks)).toBe(1);
  });
});

test.describe('palm rejection', () => {
  test('touches during a pen stroke are ignored', async ({ page }) => {
    await openApp(page);
    const input = await Input.create(page);
    const c = await paneCenter(page);
    const before = await navState(page);
    await input.penDown({ x: c.x - 100, y: c.y });
    await input.penMove({ x: c.x - 80, y: c.y + 5 });
    // Palm lands and drags while writing.
    await input.touch('touchStart', [{ x: c.x + 150, y: c.y + 100, id: 5 }]);
    for (let i = 1; i <= 6; i++) await input.touch('touchMove', [{ x: c.x + 150 + i * 20, y: c.y + 100, id: 5 }]);
    await input.penMove({ x: c.x - 40, y: c.y + 10 });
    await input.penUp({ x: c.x - 40, y: c.y + 10 });
    await input.touchEnd();
    await waitForStableView(page);
    expect(await navState(page)).toEqual(before);
    expect(await drawings(page)).toHaveLength(1);
  });

  test('a palm that lands just before the pen is rolled back', async ({ page }) => {
    await openApp(page);
    const input = await Input.create(page);
    const c = await paneCenter(page);
    const before = await navState(page);
    // Palm touches down and drags the chart a little...
    await input.touch('touchStart', [{ x: c.x + 120, y: c.y + 80, id: 9 }]);
    for (let i = 1; i <= 5; i++) await input.touch('touchMove', [{ x: c.x + 120 + i * 12, y: c.y + 80, id: 9 }]);
    await settle(page);
    expect((await navState(page)).time.rightOffset, 'the palm did move the chart').not.toBe(before.time.rightOffset);
    // ...then the nib lands within the retro window.
    await input.penDown({ x: c.x - 120, y: c.y - 40 });
    await input.penMove({ x: c.x - 60, y: c.y - 30 });
    await input.penUp({ x: c.x - 60, y: c.y - 30 });
    await input.touchEnd();
    await waitForStableView(page);
    expect(await navState(page)).toEqual(before);
    expect(await drawings(page)).toHaveLength(1);
  });

  test('ink starts exactly under the nib when the pen lands during a palm rollback', async ({ page }) => {
    await openApp(page);
    const input = await Input.create(page);
    const c = await paneCenter(page);
    // The palm drags the chart 60 px...
    await input.touch('touchStart', [{ x: c.x + 150, y: c.y + 90, id: 9 }]);
    for (let i = 1; i <= 6; i++) await input.touch('touchMove', [{ x: c.x + 150 + i * 10, y: c.y + 90, id: 9 }]);
    await settle(page);
    // ...then the nib lands (rollback requested) and draws immediately.
    const start = { x: c.x - 120, y: c.y - 30 };
    await input.penDown(start);
    for (let i = 1; i <= 10; i++) await input.penMove({ x: start.x + i * 8, y: start.y + i * 3 });
    await input.penUp({ x: start.x + 80, y: start.y + 30 });
    await input.touchEnd();
    await waitForStableView(page);
    const first = await page.evaluate(() => {
      const w = (window as any).__dac;
      const d = w.engine.document.store.all()[0];
      const v = w.chart.viewport();
      const host = (document.querySelector('[data-testid=chart-host]') as HTMLElement).getBoundingClientRect();
      const pane = w.chart.paneRect();
      return { kind: d.kind, x: host.left + pane.left + v.timeToX(d.pts[0]), y: host.top + pane.top + v.priceToY(d.pts[1]) };
    });
    expect(first.kind).toBe('ink');
    expect(Math.abs(first.x - start.x), 'no hook: first ink point under the nib').toBeLessThan(1.5);
    expect(Math.abs(first.y - start.y)).toBeLessThan(1.5);
  });

  test('a pen pressed on an axis and lifted elsewhere does not lock out the fingers', async ({ page }) => {
    await openApp(page);
    const input = await Input.create(page);
    const box = await paneBox(page);
    const onTimeAxis = { x: box.x + box.width / 2, y: box.y + box.height + 12 };
    await input.penDown(onTimeAxis);
    await input.penMove({ x: onTimeAxis.x, y: onTimeAxis.y + 30 });
    await input.penUp({ x: 20, y: onTimeAxis.y + 30 }); // lifts over the tool rail
    await page.waitForTimeout(600);
    const before = await navState(page);
    const c = await paneCenter(page);
    await input.fingerDrag(c, { x: c.x + 120, y: c.y }, 8);
    await waitForStableView(page);
    expect((await navState(page)).time.rightOffset).not.toBe(before.time.rightOffset);
  });

  test('touches right after the pen lifts are treated as the resting hand', async ({ page }) => {
    await openApp(page);
    const input = await Input.create(page);
    const c = await paneCenter(page);
    await input.penStroke(lerpPoints({ x: c.x - 80, y: c.y }, { x: c.x + 40, y: c.y + 20 }, 10));
    const before = await navState(page);
    await input.fingerDrag(c, { x: c.x + 150, y: c.y }, 8); // immediately after
    await waitForStableView(page);
    expect(await navState(page)).toEqual(before);
    await page.waitForTimeout(600);
    await input.fingerDrag(c, { x: c.x + 150, y: c.y }, 8); // after the grace period
    await waitForStableView(page);
    expect((await navState(page)).time.rightOffset).not.toBe(before.time.rightOffset);
  });
});

test.describe('interrupted interactions clean up', () => {
  test('pointercancel mid-stroke keeps the ink, ends the session and releases deferred updates', async ({ page }) => {
    await openApp(page);
    const c = await paneCenter(page);
    await synthPointer(page, 'pointerdown', { x: c.x - 100, y: c.y }, { pointerId: 42, pointerType: 'pen', buttons: 1, button: 0, pressure: 0.5 });
    for (let i = 1; i <= 10; i++) {
      await synthPointer(page, 'pointermove', { x: c.x - 100 + i * 12, y: c.y + i * 2 }, { pointerId: 42, pointerType: 'pen', buttons: 1, button: -1, pressure: 0.5 });
    }
    expect((await engineState(page)).strokeActive).toBe(true);
    expect(await page.evaluate(() => (window as any).__dac.chart.isDeferring)).toBe(true);
    await synthPointer(page, 'pointercancel', { x: c.x + 20, y: c.y + 20 }, { pointerId: 42, pointerType: 'pen', buttons: 0, button: -1 });
    expect((await engineState(page)).strokeActive).toBe(false);
    expect(await page.evaluate(() => (window as any).__dac.chart.isDeferring)).toBe(false);
    expect(await drawings(page)).toHaveLength(1);

    // Fingers work normally afterwards.
    await page.waitForTimeout(600);
    const input = await Input.create(page);
    const before = await navState(page);
    await input.fingerDrag(c, { x: c.x + 150, y: c.y }, 8);
    await waitForStableView(page);
    expect((await navState(page)).time.rightOffset).not.toBe(before.time.rightOffset);
  });

  test('window blur mid-stroke finishes the stroke cleanly', async ({ page }) => {
    await openApp(page);
    const input = await Input.create(page);
    const c = await paneCenter(page);
    await input.penDown({ x: c.x - 60, y: c.y });
    await input.penMove({ x: c.x, y: c.y + 10 });
    await input.penMove({ x: c.x + 40, y: c.y + 20 });
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    expect((await engineState(page)).strokeActive).toBe(false);
    expect(await drawings(page)).toHaveLength(1);
    await input.penUp({ x: c.x + 40, y: c.y + 20 }); // late pointerup is harmless
    await input.penStroke(lerpPoints({ x: c.x - 50, y: c.y + 80 }, { x: c.x + 50, y: c.y + 90 }, 10));
    expect(await drawings(page)).toHaveLength(2);
  });

  test('an OS-cancelled touch gesture (iPadOS palm cancel) is rolled back', async ({ page }) => {
    await openApp(page);
    const input = await Input.create(page);
    const c = await paneCenter(page);
    const before = await navState(page);
    await input.touch('touchStart', [{ x: c.x, y: c.y, id: 3 }]);
    for (let i = 1; i <= 6; i++) await input.touch('touchMove', [{ x: c.x + i * 20, y: c.y, id: 3 }]);
    await settle(page);
    expect((await navState(page)).time.rightOffset, 'the touch did move the chart').not.toBe(before.time.rightOffset);
    await input.touchCancel();
    await waitForStableView(page);
    expect(await navState(page)).toEqual(before);
  });
});

test.describe('gestures', () => {
  test('two-finger tap undoes and three-finger tap redoes', async ({ page }) => {
    await openApp(page);
    const input = await Input.create(page);
    const c = await paneCenter(page);
    await input.penStroke(lerpPoints({ x: c.x - 100, y: c.y }, { x: c.x + 100, y: c.y + 30 }, 20, 6));
    expect(await drawings(page)).toHaveLength(1);
    await page.waitForTimeout(600);
    const before = await navState(page);

    await input.touch('touchStart', [
      { x: c.x - 30, y: c.y, id: 1 },
      { x: c.x + 30, y: c.y, id: 2 },
    ]);
    await input.touchEnd();
    await waitForStableView(page);
    expect(await drawings(page)).toHaveLength(0);
    expect(await navState(page)).toEqual(before);

    await input.touch('touchStart', [
      { x: c.x - 40, y: c.y, id: 1 },
      { x: c.x, y: c.y + 10, id: 2 },
      { x: c.x + 40, y: c.y, id: 3 },
    ]);
    await input.touchEnd();
    await settle(page);
    expect(await drawings(page)).toHaveLength(1);
  });

  test('QuickShape straightens a held stroke and snaps near-horizontal lines to exactly horizontal', async ({ page }) => {
    await openApp(page);
    const input = await Input.create(page);
    const c = await paneCenter(page);
    await input.penStroke(lerpPoints({ x: c.x - 200, y: c.y }, { x: c.x + 200, y: c.y + 9 }, 40, 2), { holdMs: 750, page });
    const [d] = await drawings(page);
    expect(d.kind).toBe('line');
    expect(d.p1).toBe(d.p2); // exact horizontal price level
    // Without holding, the same stroke stays freehand ink.
    await input.penStroke(lerpPoints({ x: c.x - 200, y: c.y + 100 }, { x: c.x + 200, y: c.y + 109 }, 40, 2));
    const all = await drawings(page);
    expect(all.map((x) => x.kind).sort()).toEqual(['ink', 'line']);
  });

  test('after QuickShape snaps, moving the held pen adjusts the end point', async ({ page }) => {
    await openApp(page);
    const input = await Input.create(page);
    const c = await paneCenter(page);
    const pts = lerpPoints({ x: c.x - 150, y: c.y + 60 }, { x: c.x + 50, y: c.y - 20 }, 30, 1);
    await input.penDown(pts[0]);
    for (const p of pts.slice(1)) await input.penMove(p);
    await page.waitForTimeout(750); // snap
    await input.penMove({ x: c.x + 120, y: c.y - 90 });
    await input.penUp({ x: c.x + 120, y: c.y - 90 });
    const [d] = await drawings(page);
    expect(d.kind).toBe('line');
    const end = await page.evaluate(
      ([t, p]) => {
        const w = (window as any).__dac;
        const v = w.chart.viewport();
        const host = (document.querySelector('[data-testid=chart-host]') as HTMLElement).getBoundingClientRect();
        return { x: host.left + w.chart.paneRect().left + v.timeToX(t), y: host.top + v.priceToY(p) };
      },
      [d.t2, d.p2] as const,
    );
    expect(Math.abs(end.x - (c.x + 120))).toBeLessThan(1.5);
    expect(Math.abs(end.y - (c.y - 90))).toBeLessThan(1.5);
  });
});
