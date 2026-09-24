import { describe, expect, it } from 'vitest';
import { classifyStroke, horizontalBacktrack, joinsNote } from './classify';
import type { Pt } from './geometry';

function loopyWord(x: number, y: number, width: number, height: number, loops: number): Pt[] {
  // Cursive-like: progresses right while drawing loops that travel back left.
  const pts: Pt[] = [];
  const n = loops * 24;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = t * loops * Math.PI * 2;
    pts.push({ x: x + t * width - Math.sin(a) * (height * 0.45), y: y + height / 2 - Math.cos(a) * (height / 2) });
  }
  return pts;
}

function path(points: Array<[number, number]>): Pt[] {
  return points.map(([x, y]) => ({ x, y }));
}

describe('classifyStroke', () => {
  it('treats letter-sized strokes and dots as handwriting', () => {
    expect(classifyStroke(path([[0, 0], [10, 30], [20, 0]]))).toBe('glyph');
    expect(classifyStroke(path([[5, 5]]))).toBe('glyph');
  });

  it('treats a cursive word as handwriting', () => {
    const word = loopyWord(0, 0, 180, 36, 6);
    expect(horizontalBacktrack(word)).toBeGreaterThan(0.25);
    expect(classifyStroke(word)).toBe('glyph');
  });

  it('treats price paths, long lines and boxes as ink', () => {
    const projectedPath = path([[0, 40], [40, 10], [80, 45], [120, 5], [160, 30], [200, 0]]);
    expect(classifyStroke(projectedPath)).toBe('ink');
    expect(classifyStroke(path([[0, 0], [300, 4]]))).toBe('ink');
    const box = path([[0, 0], [200, 0], [200, 120], [0, 120], [0, 0]]);
    expect(classifyStroke(box)).toBe('ink');
  });
});

describe('joinsNote', () => {
  const note = { box: { minX: 100, minY: 100, maxX: 160, maxY: 130 }, lastEndAt: 1000, lineHeight: 30 };

  it('joins a nearby stroke written shortly after', () => {
    expect(joinsNote(note, { minX: 170, minY: 102, maxX: 190, maxY: 128 }, 1500)).toBe(true);
  });

  it('starts a new note after a pause or far away', () => {
    expect(joinsNote(note, { minX: 170, minY: 102, maxX: 190, maxY: 128 }, 4000)).toBe(false);
    expect(joinsNote(note, { minX: 400, minY: 100, maxX: 420, maxY: 130 }, 1200)).toBe(false);
  });

  it('continues onto the next line below', () => {
    expect(joinsNote(note, { minX: 100, minY: 140, maxX: 120, maxY: 165 }, 1400)).toBe(true);
  });
});
