/**
 * Palm rejection for finger navigation. Fingers never draw, so a palm can at worst navigate
 * the chart; this policy stops that. Deterministic and clock-injected for tests.
 *
 * Rules:
 * 1. While the pen touches the screen, every new touch is a palm.
 * 2. Touches starting shortly after the pen lifted, or while the pen hovers (Apple Pencil hover,
 *    S Pen Air View), are palms: the hand is still resting / about to rest.
 * 3. Contacts reporting a large contact size are palms (heuristic; only where the platform
 *    reports width/height).
 * 4. New touches close to a resting (rejected) contact are palm too; far away ones are allowed
 *    (e.g. the other hand panning while the writing hand rests).
 * 5. A touch gesture that started shortly before the pen landed is rolled back (the palm usually
 *    lands a moment before the nib). A touch cancelled by the OS is treated the same way.
 * Rejected touches stay rejected until they lift.
 */
export const PALM = {
  graceAfterPenMs: 450,
  hoverGuardMs: 350,
  retroWindowMs: 600,
  maxFingerContactPx: 60,
  rejectedNeighbourhoodPx: 160,
} as const;

export interface ContactInfo {
  readonly x: number;
  readonly y: number;
  /** PointerEvent width/height in CSS px (1 or 0 when unknown). */
  readonly width: number;
  readonly height: number;
}

export class PalmPolicy {
  private penIsDown = false;
  private penUpAt = -Infinity;
  private hoverAt = -Infinity;
  private readonly rejected = new Map<number, { x: number; y: number }>();
  private readonly cfg: typeof PALM;

  constructor(cfg: typeof PALM = PALM) {
    this.cfg = cfg;
  }

  penDown(): void {
    this.penIsDown = true;
  }

  penUp(now: number): void {
    this.penIsDown = false;
    this.penUpAt = now;
  }

  penHover(now: number): void {
    this.hoverAt = now;
  }

  get isPenDown(): boolean {
    return this.penIsDown;
  }

  /** True shortly after pen activity: compat mouse events from the pen must be ignored then. */
  penRecentlyActive(now: number): boolean {
    return this.penIsDown || now - this.penUpAt < this.cfg.graceAfterPenMs;
  }

  /** Decides at touch start. Rejected touches are remembered until `release`. */
  acceptTouch(id: number, now: number, c: ContactInfo): boolean {
    const reject =
      this.penIsDown ||
      now - this.penUpAt < this.cfg.graceAfterPenMs ||
      now - this.hoverAt < this.cfg.hoverGuardMs ||
      Math.max(c.width, c.height) > this.cfg.maxFingerContactPx ||
      this.nearRejected(c.x, c.y);
    if (reject) this.rejected.set(id, { x: c.x, y: c.y });
    return !reject;
  }

  reject(id: number, x: number, y: number): void {
    this.rejected.set(id, { x, y });
  }

  isRejected(id: number): boolean {
    return this.rejected.has(id);
  }

  /** Tracks where a rejected contact rests (palms drift). */
  moveRejected(id: number, x: number, y: number): void {
    const r = this.rejected.get(id);
    if (r) {
      r.x = x;
      r.y = y;
    }
  }

  release(id: number): void {
    this.rejected.delete(id);
  }

  /** Whether a gesture that started at `startedAt` should be undone because the pen landed. */
  shouldRollback(startedAt: number, now: number): boolean {
    return now - startedAt <= this.cfg.retroWindowMs;
  }

  private nearRejected(x: number, y: number): boolean {
    const r2 = this.cfg.rejectedNeighbourhoodPx ** 2;
    for (const p of this.rejected.values()) {
      const dx = p.x - x;
      const dy = p.y - y;
      if (dx * dx + dy * dy < r2) return true;
    }
    return false;
  }
}
