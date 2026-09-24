import { describe, expect, it } from 'vitest';
import type { NavState, PriceView, TimeView } from '../chart/ChartController';
import { TimeIndex } from '../chart/timeIndex';
import { LinearPriceMapping, Viewport } from '../chart/viewport';
import { PalmPolicy } from './palmPolicy';
import { NAV, TouchNavigator, type NavScheduler, type NavTarget } from './TouchNavigator';

const H = 3_600_000;
const WIDTH = 800;
const HEIGHT = 500;
const BARS = 1000;

/** Chart stand-in implementing the same linear time-scale formula as ChartController. */
class FakeChart implements NavTarget {
  barCount = BARS;
  time: TimeView = { barSpacing: 8, rightOffset: 10 };
  price: PriceView = { from: 100, to: 200, auto: true };
  crosshair: { x: number; y: number } | null = null;
  resets = 0;
  paneRect() {
    return { left: 0, top: 0, width: WIDTH, height: HEIGHT };
  }
  navState(): NavState {
    return { time: { ...this.time }, price: { ...this.price } };
  }
  setTimeView(view: TimeView) {
    this.time = { ...view };
  }
  logicalAt(view: TimeView, x: number) {
    const to = this.barCount - 1 + view.rightOffset;
    return to + 0.5 - (WIDTH - 1 - x) / view.barSpacing;
  }
  timeViewAnchored(anchorLogical: number, anchorX: number, barSpacing: number): TimeView {
    const to = anchorLogical - 0.5 + (WIDTH - 1 - anchorX) / barSpacing;
    return { barSpacing, rightOffset: to - (this.barCount - 1) };
  }
  viewport() {
    const x0 = this.logicalAt(this.time, 0) * -this.time.barSpacing; // x of logical 0
    const price = LinearPriceMapping.fromSamples(this.price.from, HEIGHT, this.price.to, 0);
    if (!price) return null;
    const idx = TimeIndex.from(Array.from({ length: BARS }, (_, i) => i * H), H, 1);
    return new Viewport({ x0, barSpacing: this.time.barSpacing, width: WIDTH, height: HEIGHT, timeIndex: idx, price });
  }
  setPriceView(view: PriceView | null) {
    if (view) this.price = { ...view };
  }
  restoreNav(state: NavState) {
    this.time = { ...state.time };
    if (state.price) this.price = { ...state.price };
  }
  resetView() {
    this.resets++;
  }
  setAutoScale(on: boolean) {
    this.price = { ...this.price, auto: on };
  }
  showCrosshairAt(x: number, y: number) {
    this.crosshair = { x, y };
  }
  hideCrosshair() {
    this.crosshair = null;
  }
}

class ManualScheduler implements NavScheduler {
  t = 1_000;
  frames = new Map<number, () => void>();
  timeouts = new Map<number, { at: number; fn: () => void }>();
  private id = 1;
  now() {
    return this.t;
  }
  requestFrame(fn: () => void) {
    const id = this.id++;
    this.frames.set(id, fn);
    return id;
  }
  cancelFrame(id: number) {
    this.frames.delete(id);
  }
  setTimeout(fn: () => void, ms: number) {
    const id = this.id++;
    this.timeouts.set(id, { at: this.t + ms, fn });
    return id;
  }
  clearTimeout(id: unknown) {
    this.timeouts.delete(id as number);
  }
  advance(ms: number) {
    this.t += ms;
    for (const [id, t] of [...this.timeouts]) {
      if (t.at <= this.t) {
        this.timeouts.delete(id);
        t.fn();
      }
    }
  }
  runFrames(n: number, dt = 16) {
    for (let i = 0; i < n; i++) {
      this.t += dt;
      const fns = [...this.frames.values()];
      this.frames.clear();
      for (const f of fns) f();
    }
  }
}

function setup() {
  const chart = new FakeChart();
  const s = new ManualScheduler();
  const calls: string[] = [];
  const nav = new TouchNavigator(chart, new PalmPolicy(), { onTwoFingerTap: () => calls.push('undo'), onThreeFingerTap: () => calls.push('redo') }, s);
  const touch = (_id: number, x: number, y: number) => ({ x, y, width: 16, height: 16 });
  return { chart, s, nav, calls, touch };
}

describe('TouchNavigator', () => {
  it('pans with one finger and continues with kinetic scrolling after a fling', () => {
    const { chart, s, nav, touch } = setup();
    nav.down(1, touch(1, 400, 250), s.t);
    for (let i = 1; i <= 5; i++) {
      s.t += 16;
      nav.move(1, 400 + i * 20, 250, s.t);
    }
    // Tracking starts where the pan was recognized (first move past the tap slop, at x=420).
    expect(chart.time.rightOffset).toBeCloseTo(10 - 80 / 8, 6);
    nav.up(1, s.t);
    const afterRelease = chart.time.rightOffset;
    s.runFrames(5);
    expect(chart.time.rightOffset).toBeLessThan(afterRelease); // still gliding toward older bars
    nav.down(2, touch(2, 100, 100), s.t + 2000); // any new touch stops the glide
    const stopped = chart.time.rightOffset;
    s.runFrames(5);
    expect(chart.time.rightOffset).toBe(stopped);
  });

  it('hands a pinch over to a one-finger pan without jumping', () => {
    const { chart, s, nav, touch } = setup();
    nav.down(1, touch(1, 300, 250), s.t);
    nav.down(2, touch(2, 500, 250), s.t);
    nav.move(2, 700, 250, (s.t += 16)); // spread 200 -> 400: zoom 2x
    expect(chart.time.barSpacing).toBeCloseTo(16, 6);
    const view = { ...chart.time };
    nav.up(1, (s.t += 16));
    expect(chart.time).toEqual(view); // lifting a finger changes nothing by itself
    nav.move(2, 732, 250, (s.t += 16)); // the remaining finger pans from where it is
    expect(chart.time.rightOffset).toBeCloseTo(view.rightOffset - 32 / 16, 6);
    expect(chart.time.barSpacing).toBeCloseTo(16, 6);
  });

  it('does not fling when the fingers of a pinch lift one after the other', () => {
    const { chart, s, nav, touch } = setup();
    nav.down(1, touch(1, 300, 250), s.t);
    nav.down(2, touch(2, 500, 250), s.t);
    for (let i = 1; i <= 6; i++) {
      s.t += 16;
      nav.move(1, 300 - i * 20, 250, s.t);
      nav.move(2, 500 + i * 20, 250, s.t);
    }
    const view = { ...chart.time };
    nav.up(1, (s.t += 5));
    nav.up(2, (s.t += 5));
    s.runFrames(10);
    expect(chart.time).toEqual(view);
  });

  it('keeps a pinch anchored when older history is prepended mid-gesture', () => {
    const { chart, s, nav, touch } = setup();
    nav.down(1, touch(1, 300, 250), s.t);
    nav.down(2, touch(2, 500, 250), s.t);
    nav.move(2, 600, 250, (s.t += 16));
    const before = { ...chart.time };
    // 1000 older bars arrive; the chart keeps its offset from the last bar.
    chart.barCount += 1000;
    nav.move(2, 602, 250, (s.t += 16));
    expect(Math.abs(chart.time.rightOffset - before.rightOffset)).toBeLessThan(1);
    expect(chart.time.barSpacing).toBeCloseTo((8 * 302) / 200, 6);
  });

  it('scales price by dragging the price axis and resets on double tap', () => {
    const { chart, s, nav, touch } = setup();
    nav.down(1, touch(1, 820, 200), s.t); // right of the pane = price axis
    nav.move(1, 820, 300, (s.t += 16));
    expect(chart.price.auto).toBe(false);
    expect(chart.price.to - chart.price.from).toBeGreaterThan(100);
    nav.up(1, (s.t += 16));
    s.t += 1_000;
    nav.down(2, touch(2, 820, 200), s.t);
    nav.up(2, (s.t += 50));
    nav.down(3, touch(3, 820, 200), (s.t += 100));
    nav.up(3, (s.t += 50));
    expect(chart.price.auto).toBe(true);
  });

  it('toggles the crosshair with a tap and tracks it after a long press', () => {
    const { chart, s, nav, touch } = setup();
    nav.down(1, touch(1, 200, 200), s.t);
    nav.up(1, (s.t += 80));
    expect(chart.crosshair).toEqual({ x: 200, y: 200 });
    s.advance(1_000);
    nav.down(2, touch(2, 210, 210), s.t);
    nav.up(2, (s.t += 80));
    expect(chart.crosshair).toBeNull();
    nav.down(3, touch(3, 300, 300), s.t);
    s.advance(NAV.longPressMs + 10);
    nav.move(3, 350, 320, (s.t += 16));
    expect(chart.crosshair).toEqual({ x: 350, y: 320 });
    expect(chart.time.rightOffset).toBe(10); // tracking, not panning
  });

  it('recognizes two- and three-finger taps and restores any tiny zoom', () => {
    const { chart, s, nav, calls, touch } = setup();
    nav.down(1, touch(1, 300, 250), s.t);
    nav.down(2, touch(2, 400, 250), s.t + 20);
    nav.move(2, 404, 251, s.t + 40);
    nav.up(1, s.t + 120);
    nav.up(2, s.t + 130);
    expect(calls).toEqual(['undo']);
    expect(chart.time).toEqual({ barSpacing: 8, rightOffset: 10 });
    s.t += 1_000;
    for (const id of [1, 2, 3]) nav.down(id, touch(id, 200 + id * 60, 250), s.t);
    for (const id of [1, 2, 3]) nav.up(id, s.t + 100);
    expect(calls).toEqual(['undo', 'redo']);
  });

  it('freezes and rolls back a recent gesture when the pen lands', () => {
    const { chart, s, nav, touch } = setup();
    nav.down(1, touch(1, 400, 250), s.t);
    nav.move(1, 420, 250, (s.t += 30)); // pan recognized
    nav.move(1, 460, 250, (s.t += 20));
    expect(chart.time.rightOffset).not.toBe(10);
    nav.freezeForPen((s.t += 100));
    expect(chart.time).toEqual({ barSpacing: 8, rightOffset: 10 });
    nav.move(1, 520, 250, (s.t += 16)); // the palm keeps sliding: ignored
    expect(chart.time).toEqual({ barSpacing: 8, rightOffset: 10 });
    expect(nav.activeTouchCount).toBe(0);
  });
});
