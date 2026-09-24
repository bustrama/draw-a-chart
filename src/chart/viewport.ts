import { TimeIndex } from './timeIndex';

/** Maps price <-> pane y (CSS px). Linear today; a log mapping can implement the same interface. */
export interface PriceMapping {
  toY(price: number): number;
  toPrice(y: number): number;
}

export class LinearPriceMapping implements PriceMapping {
  readonly a: number;
  readonly b: number;

  /** y = a + b * price. `b` is negative for a normal (non-inverted) price scale. */
  constructor(a: number, b: number) {
    this.a = a;
    this.b = b;
  }

  /** Builds the mapping from two sampled (price, y) pairs. */
  static fromSamples(p1: number, y1: number, p2: number, y2: number): LinearPriceMapping | null {
    if (p1 === p2 || !Number.isFinite(y1) || !Number.isFinite(y2)) return null;
    const b = (y2 - y1) / (p2 - p1);
    if (!Number.isFinite(b) || b === 0) return null;
    return new LinearPriceMapping(y1 - b * p1, b);
  }

  toY(price: number): number {
    return this.a + this.b * price;
  }

  toPrice(y: number): number {
    return (y - this.a) / this.b;
  }
}

export interface ViewportParams {
  /** Pane x (CSS px) of logical index 0, i.e. the centre of the first loaded bar. */
  readonly x0: number;
  /** Distance between bar centres in CSS px. */
  readonly barSpacing: number;
  readonly width: number;
  readonly height: number;
  readonly timeIndex: TimeIndex;
  readonly price: PriceMapping;
}

/**
 * Immutable snapshot of the chart's pane transform. All drawing geometry goes through this
 * class, so rendering, hit-testing and input conversion always agree with each other.
 * Coordinates are pane-local CSS pixels (origin at the pane's top-left corner).
 */
export class Viewport {
  readonly x0: number;
  readonly barSpacing: number;
  readonly width: number;
  readonly height: number;
  readonly timeIndex: TimeIndex;
  readonly price: PriceMapping;

  constructor(p: ViewportParams) {
    this.x0 = p.x0;
    this.barSpacing = p.barSpacing;
    this.width = p.width;
    this.height = p.height;
    this.timeIndex = p.timeIndex;
    this.price = p.price;
  }

  logicalToX(logical: number): number {
    return this.x0 + logical * this.barSpacing;
  }

  xToLogical(x: number): number {
    return (x - this.x0) / this.barSpacing;
  }

  timeToX(time: number): number {
    return this.logicalToX(this.timeIndex.timeToLogical(time));
  }

  xToTime(x: number): number {
    return this.timeIndex.logicalToTime(this.xToLogical(x));
  }

  priceToY(price: number): number {
    return this.price.toY(price);
  }

  yToPrice(y: number): number {
    return this.price.toPrice(y);
  }

  /** Nominal horizontal scale: CSS px per millisecond of chart time. */
  get pxPerMs(): number {
    return this.barSpacing / this.timeIndex.intervalMs;
  }

  /** Visible [from, to] time range, optionally padded by `marginPx` on both sides. */
  visibleTimeRange(marginPx = 0): [number, number] {
    return [this.xToTime(-marginPx), this.xToTime(this.width + marginPx)];
  }
}
