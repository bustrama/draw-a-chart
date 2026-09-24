import { describe, expect, it } from 'vitest';
import { PALM, PalmPolicy } from './palmPolicy';

const finger = (x = 100, y = 100) => ({ x, y, width: 18, height: 18 });

describe('PalmPolicy', () => {
  it('accepts normal finger touches when the pen is idle', () => {
    const p = new PalmPolicy();
    expect(p.acceptTouch(1, 10_000, finger())).toBe(true);
    expect(p.isRejected(1)).toBe(false);
  });

  it('rejects touches while the pen is down and shortly after it lifts', () => {
    const p = new PalmPolicy();
    p.penDown();
    expect(p.acceptTouch(1, 1_000, finger())).toBe(false);
    p.penUp(2_000);
    expect(p.acceptTouch(2, 2_000 + PALM.graceAfterPenMs - 1, finger(900, 900))).toBe(false);
    expect(p.acceptTouch(3, 2_000 + PALM.graceAfterPenMs + 1, finger(900, 100))).toBe(true);
  });

  it('rejects touches while the pen hovers', () => {
    const p = new PalmPolicy();
    p.penHover(5_000);
    expect(p.acceptTouch(1, 5_100, finger())).toBe(false);
    expect(p.acceptTouch(2, 5_000 + PALM.hoverGuardMs + 1, finger(800, 800))).toBe(true);
  });

  it('rejects large contacts (palm-sized) but ignores unknown sizes', () => {
    const p = new PalmPolicy();
    expect(p.acceptTouch(1, 10_000, { x: 0, y: 0, width: 90, height: 70 })).toBe(false);
    expect(p.acceptTouch(2, 10_000, { x: 900, y: 900, width: 1, height: 1 })).toBe(true);
  });

  it('keeps rejecting near a resting palm but allows the other hand far away', () => {
    const p = new PalmPolicy();
    p.reject(7, 500, 500);
    expect(p.acceptTouch(8, 10_000, finger(560, 540))).toBe(false);
    expect(p.acceptTouch(9, 10_000, finger(100, 100))).toBe(true);
    p.moveRejected(7, 150, 120); // the palm slid
    expect(p.acceptTouch(10, 10_000, finger(160, 130))).toBe(false);
    p.release(7);
    p.release(10);
    expect(p.acceptTouch(11, 10_000, finger(160, 130))).toBe(true);
  });

  it('rolls back only recent gestures', () => {
    const p = new PalmPolicy();
    expect(p.shouldRollback(1_000, 1_000 + PALM.retroWindowMs)).toBe(true);
    expect(p.shouldRollback(1_000, 1_000 + PALM.retroWindowMs + 1)).toBe(false);
  });

  it('reports recent pen activity for compatibility-event filtering', () => {
    const p = new PalmPolicy();
    expect(p.penRecentlyActive(0)).toBe(false);
    p.penDown();
    expect(p.penRecentlyActive(0)).toBe(true);
    p.penUp(100);
    expect(p.penRecentlyActive(100 + PALM.graceAfterPenMs - 1)).toBe(true);
    expect(p.penRecentlyActive(100 + PALM.graceAfterPenMs)).toBe(false);
  });
});
