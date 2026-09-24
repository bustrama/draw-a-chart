import { expect, test, type Page } from '@playwright/test';
import { drawings, Input, lerpPoints, openApp, paneBox, settle, STROKE_COLOR } from './helpers';

/** Decodes a PNG in the page and returns the best colour match near a point (image pixels). */
async function pngColorDistance(page: Page, base64: string, x: number, y: number, radius = 2): Promise<{ distance: number; width: number; height: number }> {
  return page.evaluate(
    async ([data, px, py, r, color]) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
      ctx.drawImage(img, 0, 0);
      let best = Infinity;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const d = ctx.getImageData(Math.round(px) + dx, Math.round(py) + dy, 1, 1).data;
          best = Math.min(best, Math.hypot(d[0] - color.r, d[1] - color.g, d[2] - color.b));
        }
      }
      return { distance: best, width: img.naturalWidth, height: img.naturalHeight };
    },
    [base64, x, y, radius, STROKE_COLOR] as const,
  );
}

test.describe('screenshot export', () => {
  test('download produces a PNG of the whole visible chart including the drawing', async ({ page }) => {
    await openApp(page);
    const input = await Input.create(page);
    const box = await paneBox(page);
    const a = { x: box.x + box.width * 0.3, y: box.y + box.height * 0.4 };
    const b = { x: box.x + box.width * 0.7, y: box.y + box.height * 0.6 };
    await input.penStroke(lerpPoints(a, b, 30), { holdMs: 750, page });
    expect((await drawings(page))[0].kind).toBe('line');
    await page.mouse.move(box.x + 50, box.y + 50); // crosshair visible on screen
    await settle(page);

    await page.getByTestId('screenshot-button').click();
    await expect(page.getByTestId('screenshot-preview')).toBeVisible();
    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('screenshot-download').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^BTCUSDT_1h_\d{4}-\d{2}-\d{2}-\d{2}-\d{2}\.png$/);
    const path = await download.path();
    const fs = await import('node:fs');
    const bytes = fs.readFileSync(path);
    expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');

    // The line's midpoint is painted in the exported image (host-relative coordinates, DPR 1).
    const host = await page.getByTestId('chart-host').boundingBox();
    const mid = { x: (a.x + b.x) / 2 - (host?.x ?? 0), y: (a.y + b.y) / 2 - (host?.y ?? 0) };
    const result = await pngColorDistance(page, bytes.toString('base64'), mid.x, mid.y);
    expect(result.distance).toBeLessThan(60);
    const chartBox = await page.evaluate(() => {
      const w = (window as never as { __dac: { chart: { chart: { chartElement(): HTMLElement } } } }).__dac;
      const r = w.chart.chart.chartElement().getBoundingClientRect();
      return { width: Math.round(r.width), height: Math.round(r.height) };
    });
    expect(result.width).toBe(chartBox.width);
    expect(result.height).toBe(chartBox.height);
  });

  test('copy writes an image/png to the clipboard (Chromium)', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openApp(page);
    await page.getByTestId('screenshot-button').click();
    await expect(page.getByTestId('screenshot-preview')).toBeVisible();
    await page.getByTestId('screenshot-copy').click();
    await expect(page.getByTestId('screenshot-feedback')).toHaveText('Copied to clipboard');
    const types = await page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      return items.flatMap((i) => i.types);
    });
    expect(types).toContain('image/png');
  });
});
