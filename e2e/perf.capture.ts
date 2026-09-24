/**
 * Rendering performance probe (not a test gate): many drawings, then continuous panning while
 * measuring the chart's paint time per frame. Run with:
 *   npx playwright test --config e2e/visual.config.ts perf
 */
import { test } from '@playwright/test';
import { openApp, settle } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
test('perf: pan with 300 ink strokes + 60 glyphs + 40 lines', async ({ page }) => {
  await page.setViewportSize({ width: 1194, height: 834 });
  await openApp(page, '&mockHistory=5000');

  const stats = await page.evaluate(async () => {
    const w = (window as any).__dac;
    const doc = w.engine.document;
    const idx = w.chart.currentTimeIndex;
    const n = idx.length;
    const range = w.chart.candles.priceScale().getVisibleRange();
    const mid = (range.from + range.to) / 2;
    const span = range.to - range.from;
    const H = 3_600_000;
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const muts: any[] = [];
    for (let s = 0; s < 300; s++) {
      const t0 = idx.timeAt(Math.floor(n - 200 + rnd() * 190));
      const p0 = mid + (rnd() - 0.5) * span;
      const pts: number[] = [];
      for (let i = 0; i < 150; i++) pts.push(t0 + i * H * 0.08, p0 + Math.sin(i / 9 + s) * span * 0.05, 0.3 + 0.4 * rnd());
      muts.push({ op: 'put', drawing: { id: `ink-${s}`, kind: 'ink', style: { color: '#ffd166', width: 2.5 }, createdAt: s, pts } });
    }
    for (let g = 0; g < 60; g++) {
      const pts: number[] = [];
      for (let i = 0; i < 40; i++) pts.push(Math.cos(i / 6) * 10 + i * 0.5, Math.sin(i / 3) * 12, 0.5);
      muts.push({ op: 'put', drawing: { id: `g-${g}`, kind: 'glyph', group: `grp-${g % 10}`, style: { color: '#4cc9f0', width: 2 }, createdAt: 1000 + g, at: idx.timeAt(n - 150 + g), ap: mid, ref: 8 / H, pts } });
    }
    for (let l = 0; l < 40; l++) {
      muts.push({ op: 'put', drawing: { id: `l-${l}`, kind: 'line', style: { color: '#ff6b6b', width: 1.5 }, createdAt: 2000 + l, t1: idx.timeAt(n - 190 + l), p1: mid - span * 0.3, t2: idx.timeAt(n - 20), p2: mid + span * 0.3 } });
    }
    doc.commit('perf', muts);

    // Time the chart's paint of the drawings layer by wrapping the renderer's draw().
    const prim = w.engine.primitive;
    const renderer = prim.paneViews()[0].renderer();
    const orig = renderer.draw.bind(renderer);
    const times: number[] = [];
    renderer.draw = (target: any) => {
      const t = performance.now();
      orig(target);
      times.push(performance.now() - t);
    };
    const frameGaps: number[] = [];
    let last = performance.now();
    // Pan continuously for ~2 s (both directions) through the absolute setter used by touch pans.
    const start = w.chart.navState().time;
    await new Promise<void>((resolve) => {
      let f = 0;
      const step = () => {
        const now = performance.now();
        frameGaps.push(now - last);
        last = now;
        f++;
        w.chart.setTimeView({ barSpacing: start.barSpacing, rightOffset: start.rightOffset + 25 * Math.sin(f / 20) });
        if (f < 120) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
    renderer.draw = orig;
    const sorted = [...times].sort((a, b) => a - b);
    const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
    return {
      drawings: doc.store.size,
      paints: times.length,
      drawMsMedian: pct(0.5),
      drawMsP95: pct(0.95),
      drawMsMax: sorted[sorted.length - 1],
      lastRendered: w.engine.lastRenderedCount,
      frameGapMedian: [...frameGaps].sort((a, b) => a - b)[Math.floor(frameGaps.length / 2)],
    };
  });
  await settle(page);
  console.log('PERF', JSON.stringify(stats));
});
