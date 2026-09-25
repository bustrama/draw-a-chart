import { expect, test } from '@playwright/test';

// Runs against the production build (see the 'pwa' project in playwright.config.ts).
test.describe('PWA (production build)', () => {
  test('ships an installable manifest and a service worker that serves the app offline', async ({ page, context }) => {
    await page.goto('/?provider=mock&mockLive=0&test=1');
    await expect(page.getByTestId('chart-host')).toBeVisible();

    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(manifestHref).toBeTruthy();
    const manifest = await page.evaluate(async (href) => (await fetch(href as string)).json(), manifestHref);
    expect(manifest).toMatchObject({ name: 'Draw-a-Chart', display: 'standalone', start_url: '/' });
    expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
    expect(await page.locator('link[rel="apple-touch-icon"]').getAttribute('href')).toBe('/apple-touch-icon-180x180.png');

    // Activation implies the install step (precaching the app shell) completed.
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const reg = await navigator.serviceWorker.ready;
          return reg.active?.state;
        }),
      )
      .toBe('activated');

    // The app shell loads with no network at all.
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByTestId('chart-host')).toBeVisible();
    await expect(page.getByTestId('tool-pen')).toBeVisible();
    await context.setOffline(false);
  });

  test('every icon is an opaque full-bleed tile', async ({ page }) => {
    await page.goto('/?provider=mock&mockLive=0&test=1');
    await expect(page.getByTestId('chart-host')).toBeVisible();

    // A transparent or white margin around the tile shows up as a frame on Android (maskable
    // icon) and iOS (touch icon): each icon's corners must be the opaque manifest background.
    const { background, icons } = await page.evaluate(async () => {
      const manifestUrl = new URL(document.querySelector('link[rel="manifest"]')!.getAttribute('href')!, location.href);
      const manifest = await (await fetch(manifestUrl)).json();
      const entries: { url: URL; sizes: string }[] = manifest.icons.map((i: { src: string; sizes: string }) => ({
        url: new URL(i.src, manifestUrl),
        sizes: i.sizes,
      }));
      entries.push({ url: new URL(document.querySelector('link[rel="apple-touch-icon"]')!.getAttribute('href')!, location.href), sizes: '180x180' });
      const icons = [];
      for (const { url, sizes } of entries) {
        const blob = await (await fetch(url)).blob();
        const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
        const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!;
        ctx.drawImage(bitmap, 0, 0);
        const [w, h] = [bitmap.width - 1, bitmap.height - 1];
        const corners = [[0, 0], [w, 0], [0, h], [w, h]].map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data));
        icons.push({ path: url.pathname, sizes, actual: `${bitmap.width}x${bitmap.height}`, corners });
      }
      return { background: manifest.background_color as string, icons };
    });
    const rgba = [1, 3, 5].map((i) => parseInt(background.slice(i, i + 2), 16)).concat(255);
    expect(icons.length).toBeGreaterThanOrEqual(5);
    for (const icon of icons) {
      expect(icon.actual, icon.path).toBe(icon.sizes);
      expect(icon.corners, icon.path).toEqual([rgba, rgba, rgba, rgba]);
    }
  });
});
