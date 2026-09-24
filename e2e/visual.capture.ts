/**
 * Visual capture script (not part of the test suite): renders the app at tablet/desktop sizes
 * with representative drawings and writes PNGs to test-results/visual/.
 *   npx playwright test --config e2e/visual.config.ts
 */
import { test } from '@playwright/test';
import { Input, openApp, paneBox, settle, type XY } from './helpers';

const sizes = [
  { name: 'ipad-landscape', width: 1194, height: 834 },
  { name: 'ipad-portrait', width: 834, height: 1194 },
  { name: 'desktop', width: 1440, height: 900 },
  // iPad Slide Over / 1/3 Split View width.
  { name: 'slide-over', width: 320, height: 700 },
];

function seg(points: XY[], n: number): XY[] {
  const out: XY[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    for (let k = 1; k <= n; k++) {
      out.push({ x: points[i - 1].x + ((points[i].x - points[i - 1].x) * k) / n, y: points[i - 1].y + ((points[i].y - points[i - 1].y) * k) / n });
    }
  }
  return out;
}

for (const size of sizes) {
  test(`capture ${size.name}`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await openApp(page);
    const input = await Input.create(page);
    const b = await paneBox(page);
    const P = (fx: number, fy: number): XY => ({ x: b.x + b.width * fx, y: b.y + b.height * fy });

    // Trading range box (ink), support + resistance (QuickShape), projected path (ink), notes (glyphs).
    await input.penStroke(seg([P(0.45, 0.3), P(0.72, 0.3), P(0.72, 0.62), P(0.45, 0.62), P(0.45, 0.305)], 14));
    await input.penStroke(seg([P(0.3, 0.7), P(0.8, 0.705)], 40), { holdMs: 700, page });
    await input.penStroke(Array.from({ length: 45 }, (_, i) => ({ x: P(0.73, 0).x + i * 5, y: P(0, 0.55).y - Math.sin(i / 5) * 22 - i * 2.4 })));
    // "SC" as two cursive-ish letters
    const s0 = P(0.5, 0.24);
    await input.penStroke(Array.from({ length: 30 }, (_, i) => {
      const t = i / 29;
      return { x: s0.x + 11 * Math.cos(Math.PI * 3 * t + 0.4) * (1 - t * 0.15), y: s0.y - 14 + 28 * t };
    }));
    await input.penStroke(Array.from({ length: 24 }, (_, i) => {
      const a = -0.9 + (Math.PI * 1.75 * i) / 23;
      return { x: s0.x + 36 - 12 * Math.cos(a), y: s0.y + 13 * Math.sin(a) };
    }));
    await settle(page, 6);
    const out = (name: string) => test.info().outputPath(`${size.name}${name}.png`);
    await page.screenshot({ path: out('') });

    await page.waitForTimeout(600);
    await page.getByTestId('palette-toggle').click();
    await page.screenshot({ path: out('-palette') });
    await page.keyboard.press('Escape');
    await page.getByTestId('screenshot-button').click();
    await page.getByTestId('screenshot-preview').waitFor();
    await page.screenshot({ path: out('-screenshot-panel') });
    await page.keyboard.press('Escape');
    await page.getByTestId('account-button').click();
    await page.screenshot({ path: out('-account-panel') });
  });
}
