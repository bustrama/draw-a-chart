import { describe, expect, it } from 'vitest';
import { fitLine, HoldTracker, isLineLike, snapLineEnd } from './quickShape';
import type { Pt } from './geometry';

/** Hand-like line: samples along a segment with deterministic wobble. */
function wobblyLine(x1: number, y1: number, x2: number, y2: number, n: number, wobble: number): Pt[] {
  const pts: Pt[] = [];
  const len = Math.hypot(x2 - x1, y2 - y1);
  const nx = -(y2 - y1) / len;
  const ny = (x2 - x1) / len;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const w = Math.sin(t * Math.PI * 3) * wobble;
    pts.push({ x: x1 + (x2 - x1) * t + nx * w, y: y1 + (y2 - y1) * t + ny * w });
  }
  return pts;
}

function arc(cx: number, cy: number, r: number, from: number, to: number, n: number): Pt[] {
  return Array.from({ length: n }, (_, i) => {
    const a = from + ((to - from) * i) / (n - 1);
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });
}

describe('QuickShape line recognition', () => {
  it('accepts a slightly wobbly hand-drawn line', () => {
    expect(isLineLike(fitLine(wobblyLine(10, 10, 310, 140, 80, 3)))).toBe(true);
  });

  it('rejects curves, zig-zags, and tiny strokes', () => {
    expect(isLineLike(fitLine(arc(200, 200, 150, Math.PI, 1.6 * Math.PI, 60)))).toBe(false);
    const zigzag: Pt[] = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 0, y: 3 },
      { x: 100, y: 3 },
    ];
    expect(isLineLike(fitLine(zigzag))).toBe(false);
    expect(isLineLike(fitLine(wobblyLine(0, 0, 12, 4, 10, 0)))).toBe(false);
  });

  it('rejects a V shape that returns near its start', () => {
    const v: Pt[] = [...wobblyLine(0, 0, 100, 100, 20, 0), ...wobblyLine(100, 100, 190, 5, 20, 0)];
    expect(isLineLike(fitLine(v))).toBe(false);
  });

  it('snaps nearly horizontal and vertical lines exactly', () => {
    expect(snapLineEnd({ x: 0, y: 0 }, { x: 200, y: 6 })).toEqual({ end: { x: 200, y: 0 }, snapped: 'h' });
    expect(snapLineEnd({ x: 0, y: 0 }, { x: -200, y: -5 })).toEqual({ end: { x: -200, y: 0 }, snapped: 'h' });
    expect(snapLineEnd({ x: 0, y: 0 }, { x: 5, y: 180 })).toEqual({ end: { x: 0, y: 180 }, snapped: 'v' });
    expect(snapLineEnd({ x: 0, y: 0 }, { x: 100, y: 60 }).snapped).toBeNull();
  });
});

describe('HoldTracker', () => {
  it('ignores jitter inside the radius and fires after the hold duration', () => {
    const hold = new HoldTracker(5, 450);
    hold.reset({ x: 100, y: 100 }, 1000, 10);
    expect(hold.update({ x: 102, y: 101 }, 1100, 11)).toBe(false);
    expect(hold.update({ x: 99, y: 103 }, 1300, 12)).toBe(false);
    expect(hold.isHeld(1449)).toBe(false);
    expect(hold.isHeld(1450)).toBe(true);
    expect(hold.anchorIndex).toBe(10);
  });

  it('re-anchors when the pen moves beyond the radius', () => {
    const hold = new HoldTracker(5, 450);
    hold.reset({ x: 0, y: 0 }, 0, 0);
    expect(hold.update({ x: 10, y: 0 }, 300, 5)).toBe(true);
    expect(hold.isHeld(500)).toBe(false);
    expect(hold.dueAt).toBe(750);
    expect(hold.anchorIndex).toBe(5);
  });
});
