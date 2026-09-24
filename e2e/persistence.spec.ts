import { expect, test } from '@playwright/test';
import { drawings, Input, lerpPoints, openApp, paneBox, settle, waitForChart } from './helpers';

test.describe('local persistence', () => {
  test('drawings survive a reload (IndexedDB) and undo history does not leak across sessions', async ({ page }) => {
    await openApp(page);
    const input = await Input.create(page);
    const box = await paneBox(page);
    const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await input.penStroke(lerpPoints({ x: c.x - 150, y: c.y }, { x: c.x + 150, y: c.y + 40 }, 30, 8));
    await input.penStroke(lerpPoints({ x: c.x - 150, y: c.y + 120 }, { x: c.x + 150, y: c.y + 130 }, 30, 2), { holdMs: 750, page });
    const before = await drawings(page);
    expect(before).toHaveLength(2);
    // Local writes are asynchronous; wait until both are durably queued.
    await expect(page.getByTestId('sync-button')).toHaveAttribute('data-sync-state', 'local-only');
    await expect
      .poll(() => page.evaluate(() => (window as never as { __dacRuntime: { sync: { getStatus(): { pending: number } } } }).__dacRuntime.sync.getStatus().pending))
      .toBe(2);
    await expect(page.getByTestId('pending-count')).toHaveCount(0); // not flagged when sync is not configured

    await page.reload();
    await waitForChart(page);
    await expect.poll(async () => (await drawings(page)).length).toBe(2);
    expect(await drawings(page)).toEqual(before);
    await expect(page.getByTestId('undo')).toBeDisabled();
  });

  test('drawing keeps working while the network is offline', async ({ page, context }) => {
    await page.goto('/?provider=mock&mockLive=0');
    await waitForChart(page);
    await context.setOffline(true);
    const input = await Input.create(page);
    const box = await paneBox(page);
    const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await input.penStroke(lerpPoints({ x: c.x - 100, y: c.y }, { x: c.x + 100, y: c.y + 20 }, 20, 5));
    await settle(page);
    expect(await drawings(page)).toHaveLength(1);
    await context.setOffline(false);
  });
});
