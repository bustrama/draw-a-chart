import { dist, pointSegmentDistance, polylineLength, type Pt } from './geometry';

/**
 * QuickShape: draw a stroke, keep the pen still for a moment at its end, and a straight-enough
 * stroke snaps into an exact straight line (like the handwriting apps on iPad/Galaxy tablets).
 * While the pen stays down after the snap, the end point follows the pen.
 */

export const QUICKSHAPE = {
  /** Pen must stay within this radius (CSS px) ... */
  holdRadiusPx: 5,
  /** ... for this long (ms) to trigger recognition. */
  holdMs: 450,
  /** Minimum chord length (CSS px) for a stroke to be considered a line. */
  minLengthPx: 24,
  /** Max perpendicular deviation allowed: max(abs, rel * chord). */
  maxDeviationAbsPx: 6,
  maxDeviationRel: 0.06,
  /** Path length / chord length ratio limit (rejects zig-zags and doubled-back strokes). */
  maxPathRatio: 1.15,
  /** Snap to exact horizontal/vertical within this many degrees. */
  angleSnapDeg: 4,
} as const;

export interface LineFit {
  readonly start: Pt;
  readonly end: Pt;
  readonly chord: number;
  readonly maxDeviation: number;
  readonly pathRatio: number;
}

export function fitLine(points: readonly Pt[]): LineFit | null {
  if (points.length < 2) return null;
  const start = points[0];
  const end = points[points.length - 1];
  const chord = dist(start, end);
  if (chord === 0) return null;
  let maxDeviation = 0;
  for (const p of points) {
    const d = pointSegmentDistance(p, start, end);
    if (d > maxDeviation) maxDeviation = d;
  }
  return { start, end, chord, maxDeviation, pathRatio: polylineLength(points) / chord };
}

/** True when the stroke is straight enough to be straightened. */
export function isLineLike(fit: LineFit | null, cfg = QUICKSHAPE): fit is LineFit {
  if (fit === null) return false;
  if (fit.chord < cfg.minLengthPx) return false;
  if (fit.maxDeviation > Math.max(cfg.maxDeviationAbsPx, cfg.maxDeviationRel * fit.chord)) return false;
  return fit.pathRatio <= cfg.maxPathRatio;
}

/** Returns `end`, adjusted to be exactly horizontal/vertical from `start` if nearly so. */
export function snapLineEnd(start: Pt, end: Pt, toleranceDeg: number = QUICKSHAPE.angleSnapDeg): { end: Pt; snapped: 'h' | 'v' | null } {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return { end, snapped: null };
  const angle = Math.abs((Math.atan2(dy, dx) * 180) / Math.PI); // 0..180
  const fromHorizontal = Math.min(angle, 180 - angle);
  if (fromHorizontal <= toleranceDeg) return { end: { x: end.x, y: start.y }, snapped: 'h' };
  if (Math.abs(90 - angle) <= toleranceDeg) return { end: { x: start.x, y: end.y }, snapped: 'v' };
  return { end, snapped: null };
}

/**
 * Tracks whether the pen has been held still. Jitter inside `radius` does not reset the timer;
 * moving outside re-anchors it. `anchorIndex` is the index of the stroke point where the current
 * hold began, so recognition can ignore the jittery tail recorded while holding.
 */
export class HoldTracker {
  private anchor: Pt = { x: 0, y: 0 };
  private anchorTime = 0;
  private index = 0;
  private readonly radius: number;
  private readonly durationMs: number;

  constructor(radius: number = QUICKSHAPE.holdRadiusPx, durationMs: number = QUICKSHAPE.holdMs) {
    this.radius = radius;
    this.durationMs = durationMs;
  }

  reset(p: Pt, time: number, index: number): void {
    this.anchor = { x: p.x, y: p.y };
    this.anchorTime = time;
    this.index = index;
  }

  /** Feeds a sample; returns true if it broke the hold (and re-anchored at this sample). */
  update(p: Pt, time: number, index: number): boolean {
    if (dist(p, this.anchor) > this.radius) {
      this.reset(p, time, index);
      return true;
    }
    return false;
  }

  get anchorIndex(): number {
    return this.index;
  }

  /** Time at which the hold will be satisfied if the pen does not move. */
  get dueAt(): number {
    return this.anchorTime + this.durationMs;
  }

  isHeld(now: number): boolean {
    return now >= this.dueAt;
  }
}
