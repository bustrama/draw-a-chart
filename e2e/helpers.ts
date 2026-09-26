import { expect, type CDPSession, type Page } from '@playwright/test';

/** Fixed mock clock: every run sees identical bars. */
export const MOCK_NOW = Date.UTC(2026, 8, 20, 12, 0, 0);
export const STROKE_COLOR = { r: 0xff, g: 0xd1, b: 0x66 }; // default pen colour #ffd166

export interface XY {
  x: number;
  y: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Page-side accessor for the workspace exposed on window in dev/test builds. */
export const dacExpr = '(window.__dac)';

export async function openApp(page: Page, extraQuery = ''): Promise<void> {
  await page.goto(`/?provider=mock&mockNow=${MOCK_NOW}&mockLive=0${extraQuery}`);
  await waitForChart(page);
}

export async function waitForChart(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const w = (window as any).__dac;
    return !!w && w.getStatus().feed.initialLoaded && w.chart.barCount > 0 && w.chart.viewport() !== null;
  });
  await settle(page);
}

/** Waits for a few animation frames so the chart (and overlay) have painted. */
export async function settle(page: Page, frames = 4): Promise<void> {
  await page.evaluate(
    (n) =>
      new Promise<void>((resolve) => {
        let i = 0;
        const step = () => (++i >= n ? resolve() : requestAnimationFrame(step));
        requestAnimationFrame(step);
      }),
    frames,
  );
}

export interface PaneBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Pane rectangle in viewport (client) CSS px. */
export async function paneBox(page: Page): Promise<PaneBox> {
  return page.evaluate(() => {
    const w = (window as any).__dac;
    const host = (document.querySelector('[data-testid=chart-host]') as HTMLElement).getBoundingClientRect();
    const p = w.chart.paneRect();
    return { x: host.left + p.left, y: host.top + p.top, width: p.width, height: p.height };
  });
}

export async function navState(page: Page): Promise<{ time: { barSpacing: number; rightOffset: number }; price: { from: number; to: number; auto: boolean } | null }> {
  return page.evaluate(() => (window as any).__dac.chart.navState());
}

export async function drawings(page: Page): Promise<Array<Record<string, any>>> {
  return page.evaluate(() => (window as any).__dac.engine.document.store.all());
}

/** Bar open time (ms) of the bar `fromEnd` bars before the last one. */
export async function barTime(page: Page, fromEnd: number): Promise<number> {
  return page.evaluate((k) => {
    const idx = (window as any).__dac.chart.currentTimeIndex;
    return idx.timeAt(idx.length - 1 - k);
  }, fromEnd);
}

/**
 * Open time, high and low of the displayed bar `fromEnd` bars before the last one, read from the
 * chart library's own data by time (independent of the app's index-based `barAt`).
 */
export async function barExtent(page: Page, fromEnd: number): Promise<{ t: number; high: number; low: number }> {
  return page.evaluate((k) => {
    const w = (window as any).__dac;
    const idx = w.chart.currentTimeIndex;
    const t = idx.timeAt(idx.length - 1 - k);
    const bar = w.chart.candles.data().find((d: { time: number }) => d.time === t / 1000);
    return { t, high: bar.high, low: bar.low };
  }, fromEnd);
}

/** Highest high of the bars on screen and where it is, in pane px. */
export async function highestVisibleHigh(page: Page): Promise<{ price: number; y: number }> {
  return page.evaluate(() => {
    const w = (window as any).__dac;
    const range = w.chart.chart.timeScale().getVisibleLogicalRange();
    const data = w.chart.candles.data();
    let price = -Infinity;
    for (let i = Math.max(0, Math.ceil(range.from)); i <= Math.min(data.length - 1, Math.floor(range.to)); i++) price = Math.max(price, data[i].high);
    return { price, y: w.chart.viewport().priceToY(price) };
  });
}

/** Visible price range [low, high] of the candle series. */
export async function priceRange(page: Page): Promise<{ from: number; to: number }> {
  return page.evaluate(() => (window as any).__dac.chart.candles.priceScale().getVisibleRange());
}

/**
 * Independent expected client position of a chart point: uses Lightweight Charts' OWN coordinate
 * of the surrounding bars (timeToCoordinate) and interpolates by time between them, plus the
 * series' priceToCoordinate. This does not go through our TimeIndex/Viewport code.
 */
export async function expectedClient(page: Page, t: number, p: number): Promise<XY> {
  return page.evaluate(
    ([time, price]) => {
      const w = (window as any).__dac;
      const ts = w.chart.chart.timeScale();
      const idx = w.chart.currentTimeIndex;
      const n = idx.length;
      let i = 0;
      while (i < n - 2 && idx.timeAt(i + 1) <= time) i++;
      const t0 = idx.timeAt(i);
      const t1 = idx.timeAt(i + 1);
      const x0 = ts.timeToCoordinate(t0 / 1000);
      const x1 = ts.timeToCoordinate(t1 / 1000);
      const x = x0 + ((time - t0) / (t1 - t0)) * (x1 - x0);
      const y = w.chart.candles.priceToCoordinate(price);
      const host = (document.querySelector('[data-testid=chart-host]') as HTMLElement).getBoundingClientRect();
      const pane = w.chart.paneRect();
      return { x: host.left + pane.left + x, y: host.top + pane.top + y };
    },
    [t, p] as const,
  );
}

/**
 * Atomically (same task, same chart state) computes where our Viewport renders a chart point and
 * where Lightweight Charts' own bar coordinates say it should be.
 */
export async function anchorPair(page: Page, t: number, p: number): Promise<{ ours: XY; expected: XY }> {
  return page.evaluate(
    ([time, price]) => {
      const w = (window as any).__dac;
      const ts = w.chart.chart.timeScale();
      const idx = w.chart.currentTimeIndex;
      const n = idx.length;
      let i = 0;
      while (i < n - 2 && idx.timeAt(i + 1) <= time) i++;
      const t0 = idx.timeAt(i);
      const t1 = idx.timeAt(i + 1);
      const x0 = ts.timeToCoordinate(t0 / 1000);
      const x1 = ts.timeToCoordinate(t1 / 1000);
      const host = (document.querySelector('[data-testid=chart-host]') as HTMLElement).getBoundingClientRect();
      const pane = w.chart.paneRect();
      const ox = host.left + pane.left;
      const oy = host.top + pane.top;
      const v = w.chart.viewport();
      return {
        expected: { x: ox + x0 + ((time - t0) / (t1 - t0)) * (x1 - x0), y: oy + w.chart.candles.priceToCoordinate(price) },
        ours: { x: ox + v.timeToX(time), y: oy + v.priceToY(price) },
      };
    },
    [t, p] as const,
  );
}

/** Waits until the chart's view stops changing (kinetic scrolling, deferred range application). */
export async function waitForStableView(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const w = (window as any).__dac;
        let last = '';
        let stable = 0;
        const step = () => {
          const now = JSON.stringify(w.chart.navState());
          stable = now === last ? stable + 1 : 0;
          last = now;
          if (stable >= 3) resolve();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
  );
}

/** Where our own Viewport says a chart point is (client px). */
export async function viewportClient(page: Page, t: number, p: number): Promise<XY> {
  return page.evaluate(
    ([time, price]) => {
      const w = (window as any).__dac;
      const v = w.chart.viewport();
      const host = (document.querySelector('[data-testid=chart-host]') as HTMLElement).getBoundingClientRect();
      const pane = w.chart.paneRect();
      return { x: host.left + pane.left + v.timeToX(time), y: host.top + pane.top + v.priceToY(price) };
    },
    [t, p] as const,
  );
}

/**
 * Best colour match to `rgb` within `radius` px of a client point, read from the chart's own
 * screenshot canvas (i.e. what the chart actually painted, including drawings).
 * Returns the smallest RGB distance found (0 = exact colour).
 */
export async function colorDistanceAt(page: Page, client: XY, rgb = STROKE_COLOR, radius = 2): Promise<number> {
  return page.evaluate(
    ([pt, color, r]) => {
      const w = (window as any).__dac;
      const canvas: HTMLCanvasElement = w.chart.takeScreenshot();
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
      const host = (document.querySelector('[data-testid=chart-host]') as HTMLElement).getBoundingClientRect();
      const pane = w.chart.paneRect();
      const dpr = canvas.width / (pane.width + w.chart.chart.priceScale('right').width() + pane.left);
      const px = Math.round((pt.x - host.left) * dpr);
      const py = Math.round((pt.y - host.top) * dpr);
      let best = Infinity;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const d = ctx.getImageData(px + dx, py + dy, 1, 1).data;
          best = Math.min(best, Math.hypot(d[0] - color.r, d[1] - color.g, d[2] - color.b));
        }
      }
      return best;
    },
    [client, rgb, radius] as const,
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Trusted input through the Chrome DevTools Protocol (real browser event pipeline). */
export class Input {
  private readonly cdp: CDPSession;

  private constructor(cdp: CDPSession) {
    this.cdp = cdp;
  }

  static async create(page: Page): Promise<Input> {
    return new Input(await page.context().newCDPSession(page));
  }

  // ---- pen (Input.dispatchMouseEvent with pointerType 'pen') ----

  async penDown(p: XY, pressure = 0.5): Promise<void> {
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'pen', force: pressure });
  }

  async penMove(p: XY, pressure = 0.5): Promise<void> {
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'left', buttons: 1, pointerType: 'pen', force: pressure });
  }

  async penHover(p: XY): Promise<void> {
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', buttons: 0, pointerType: 'pen' });
  }

  async penUp(p: XY): Promise<void> {
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'pen' });
  }

  /** Draws through the given points; optionally holds still at the end before lifting. */
  async penStroke(points: XY[], opts: { holdMs?: number; page?: Page } = {}): Promise<void> {
    await this.penDown(points[0]);
    for (const p of points.slice(1)) await this.penMove(p);
    if (opts.holdMs && opts.page) await opts.page.waitForTimeout(opts.holdMs);
    await this.penUp(points[points.length - 1]);
  }

  // ---- touch (Input.dispatchTouchEvent) ----

  async touch(type: 'touchStart' | 'touchMove', points: Array<XY & { id: number }>, radius = 8): Promise<void> {
    await this.cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: p.id, radiusX: radius, radiusY: radius, force: 1 })),
    });
  }

  async touchEnd(): Promise<void> {
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }

  async touchCancel(): Promise<void> {
    await this.cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
  }

  /** One-finger drag. */
  async fingerDrag(from: XY, to: XY, steps = 12): Promise<void> {
    await this.touch('touchStart', [{ ...from, id: 1 }]);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await this.touch('touchMove', [{ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, id: 1 }]);
    }
    await this.touchEnd();
  }

  /** Two-finger horizontal pinch around `center`. */
  async pinch(center: XY, fromDist: number, toDist: number, steps = 12): Promise<void> {
    const pts = (d: number) => [
      { x: center.x - d / 2, y: center.y, id: 1 },
      { x: center.x + d / 2, y: center.y, id: 2 },
    ];
    await this.touch('touchStart', pts(fromDist));
    for (let i = 1; i <= steps; i++) await this.touch('touchMove', pts(fromDist + ((toDist - fromDist) * i) / steps));
    await this.touchEnd();
  }
}

/**
 * Synthetic (untrusted) pointer input dispatched at the element under the point. Works in every
 * engine (no CDP), e.g. WebKit. Pointer capture cannot be taken for synthetic ids; the router
 * tolerates that because events still pass through the chart host.
 */
export class SynthInput {
  private readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async pointer(type: string, p: XY, init: Record<string, unknown>): Promise<void> {
    await this.page.evaluate(
      ([t, pt, extra]) => {
        const target = document.elementFromPoint(pt.x, pt.y) ?? document.body;
        target.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, composed: true, clientX: pt.x, clientY: pt.y, isPrimary: true, ...extra }));
      },
      [type, p, init] as const,
    );
  }

  async penStroke(points: XY[], opts: { holdMs?: number; pointerId?: number } = {}): Promise<void> {
    const id = opts.pointerId ?? 101;
    await this.pointer('pointerdown', points[0], { pointerId: id, pointerType: 'pen', buttons: 1, button: 0, pressure: 0.5 });
    for (const p of points.slice(1)) await this.pointer('pointermove', p, { pointerId: id, pointerType: 'pen', buttons: 1, button: -1, pressure: 0.5 });
    if (opts.holdMs) await this.page.waitForTimeout(opts.holdMs);
    await this.pointer('pointerup', points[points.length - 1], { pointerId: id, pointerType: 'pen', buttons: 0, button: 0, pressure: 0 });
  }

  /**
   * One-finger drag. Synthetic events arrive microseconds apart, which reads as a violent fling;
   * `holdMs` keeps the finger still before lifting (a deliberate drag, no kinetic scroll).
   */
  async fingerDrag(from: XY, to: XY, steps = 10, pointerId = 201, holdMs = 150): Promise<void> {
    const base = { pointerId, pointerType: 'touch', width: 16, height: 16 };
    await this.pointer('pointerdown', from, { ...base, buttons: 1, button: 0, pressure: 0.5 });
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await this.pointer('pointermove', { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }, { ...base, buttons: 1, button: -1, pressure: 0.5 });
    }
    if (holdMs > 0) await this.page.waitForTimeout(holdMs);
    await this.pointer('pointerup', to, { ...base, buttons: 0, button: 0, pressure: 0 });
  }
}

/** A point on segment ab that lies inside the box (with a margin), or null if none does. */
export function visiblePointOnSegment(a: XY, b: XY, box: PaneBox, margin = 6): XY | null {
  for (const t of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.1, 0.9]) {
    const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    if (p.x > box.x + margin && p.x < box.x + box.width - margin && p.y > box.y + margin && p.y < box.y + box.height - margin) return p;
  }
  return null;
}

export function lerpPoints(a: XY, b: XY, n: number, wobble = 0): XY[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t + Math.sin(t * Math.PI * 4) * wobble };
  });
}

export async function expectNear(actual: XY, expected: XY, tolerancePx: number, label: string): Promise<void> {
  expect(Math.abs(actual.x - expected.x), `${label} x (${actual.x} vs ${expected.x})`).toBeLessThanOrEqual(tolerancePx);
  expect(Math.abs(actual.y - expected.y), `${label} y (${actual.y} vs ${expected.y})`).toBeLessThanOrEqual(tolerancePx);
}
