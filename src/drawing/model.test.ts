import { describe, expect, it } from 'vitest';
import { glyphScale, GLYPH_SCALE_MAX, GLYPH_SCALE_MIN, parseDrawing } from './model';

const style = { color: '#ffd166', width: 2.5 };

describe('parseDrawing', () => {
  it('accepts valid drawings of every kind', () => {
    expect(parseDrawing({ id: 'a', createdAt: 1, style, kind: 'ink', pts: [1, 2, 0.5, 3, 4, 0.5] })?.kind).toBe('ink');
    expect(parseDrawing({ id: 'b', createdAt: 1, style, kind: 'line', t1: 1, p1: 2, t2: 3, p2: 4 })?.kind).toBe('line');
    expect(
      parseDrawing({ id: 'c', createdAt: 1, style, kind: 'glyph', group: 'g', at: 1, ap: 2, ref: 1e-6, pts: [0, 0, 0.5] })?.kind,
    ).toBe('glyph');
  });

  it('rejects malformed or hostile input', () => {
    expect(parseDrawing(null)).toBeNull();
    expect(parseDrawing({ id: 'a', createdAt: 1, style, kind: 'ink', pts: [1, 2] })).toBeNull();
    expect(parseDrawing({ id: 'a', createdAt: 1, style, kind: 'ink', pts: [1, 2, Number.NaN] })).toBeNull();
    expect(parseDrawing({ id: 'a', createdAt: 1, style: { color: 'red; x', width: 2 }, kind: 'line', t1: 1, p1: 1, t2: 1, p2: 1 })).toBeNull();
    expect(parseDrawing({ id: 'a', createdAt: 1, style, kind: 'glyph', group: 'g', at: 1, ap: 2, ref: 0, pts: [0, 0, 1] })).toBeNull();
    expect(parseDrawing({ id: 'a', createdAt: 1, style, kind: 'unknown' })).toBeNull();
  });
});

describe('glyphScale', () => {
  it('is 1 at the reference zoom and damped/clamped elsewhere', () => {
    expect(glyphScale(1, 1)).toBe(1);
    expect(glyphScale(1, 2)).toBeCloseTo(Math.SQRT2, 12);
    expect(glyphScale(1, 100)).toBe(GLYPH_SCALE_MAX);
    expect(glyphScale(1, 0.01)).toBe(GLYPH_SCALE_MIN);
  });
});
