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
});
