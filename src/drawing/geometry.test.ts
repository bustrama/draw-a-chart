import { describe, expect, it } from 'vitest';
import { segmentBoxDistance } from './geometry';

const box = { minX: 10, minY: 20, maxX: 30, maxY: 40 };

describe('segmentBoxDistance', () => {
  it('is 0 for a point or segment inside the box', () => {
    expect(segmentBoxDistance({ x: 15, y: 25 }, { x: 15, y: 25 }, box)).toBe(0);
    expect(segmentBoxDistance({ x: 15, y: 25 }, { x: 100, y: 100 }, box)).toBe(0);
  });

  it('is 0 for a segment crossing the box without an end inside', () => {
    expect(segmentBoxDistance({ x: 0, y: 30 }, { x: 50, y: 30 }, box)).toBe(0);
  });

  it('measures to the nearest edge or corner from outside', () => {
    expect(segmentBoxDistance({ x: 20, y: 5 }, { x: 20, y: 5 }, box)).toBeCloseTo(15, 9);
    expect(segmentBoxDistance({ x: 33, y: 44 }, { x: 33, y: 44 }, box)).toBeCloseTo(5, 9);
    expect(segmentBoxDistance({ x: 0, y: 50 }, { x: 40, y: 50 }, box)).toBeCloseTo(10, 9);
  });
});
