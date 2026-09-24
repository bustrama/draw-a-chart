import { describe, expect, it } from 'vitest';
import { capPoints, clampPressure, MAX_STROKE_POINTS } from './DrawingEngine';

interface P {
  x: number;
  y: number;
}

const X = (p: P) => p.x;
const Y = (p: P) => p.y;

function distanceToSegment(p: P, a: P, b: P): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function distanceToPolyline(p: P, line: readonly P[]): number {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) best = Math.min(best, distanceToSegment(p, line[i - 1], line[i]));
  return best;
}

describe('clampPressure', () => {
  it('uses a constant for the mouse and clamps pen pressure to 1', () => {
    expect(clampPressure(0.9, 'mouse')).toBe(0.5);
    expect(clampPressure(0.4, 'pen')).toBe(0.4);
    expect(clampPressure(1.3, 'pen')).toBe(1);
  });

  it('keeps the previous pressure when a pen reports 0 (no blob at the end of fast strokes)', () => {
    expect(clampPressure(0, 'pen', 0.7)).toBe(0.7);
    expect(clampPressure(Number.NaN, 'pen', 0.3)).toBe(0.3);
    expect(clampPressure(0, 'pen')).toBe(0.5);
  });
});

describe('capPoints', () => {
  it('leaves strokes within the limit untouched', () => {
    const pts = Array.from({ length: MAX_STROKE_POINTS }, (_, i) => ({ x: i, y: i % 2 }));
    const out = capPoints(pts, X, Y);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(pts);
    expect(out[0]).not.toBe(pts);
  });

  it('simplifies a long smooth stroke into one drawing that stays within a quarter pixel', () => {
    const pts = Array.from({ length: 10_000 }, (_, i) => ({ x: i * 0.3, y: 20 * Math.sin(i / 15) }));
    const out = capPoints(pts, X, Y);
    expect(out).toHaveLength(1);
    const [kept] = out;
    expect(kept.length).toBeLessThanOrEqual(MAX_STROKE_POINTS);
    expect(kept[0]).toBe(pts[0]);
    expect(kept[kept.length - 1]).toBe(pts[pts.length - 1]);
    const worst = Math.max(...pts.map((p) => distanceToPolyline(p, kept)));
    expect(worst).toBeLessThanOrEqual(0.25 + 1e-9);
  });

  it('splits an incompressible stroke into pieces that share their joins and lose no point', () => {
    // Every point is a zig-zag corner at least ~19 px away from any chord skipping it, so no
    // tolerance up to 2 px can drop one. (With 1 px spacing the zig-zag is nearly vertical and
    // corners do fall within 2 px of the chord.)
    const pts = Array.from({ length: 5_000 }, (_, i) => ({ x: i * 10, y: i % 2 === 0 ? 0 : 100 }));
    const out = capPoints(pts, X, Y);
    expect(out.map((c) => c.length)).toEqual([2000, 2000, 1002]);
    for (let k = 1; k < out.length; k++) expect(out[k][0]).toBe(out[k - 1][out[k - 1].length - 1]);
    const rejoined = [out[0], ...out.slice(1).map((c) => c.slice(1))].flat();
    expect(rejoined).toEqual(pts);
  });
});
