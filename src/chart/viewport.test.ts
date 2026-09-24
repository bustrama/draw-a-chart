import { describe, expect, it } from 'vitest';
import { TimeIndex } from './timeIndex';
import { LinearPriceMapping, Viewport } from './viewport';

const H = 3_600_000;
const T0 = Date.UTC(2026, 0, 1);

function makeViewport(over: Partial<ConstructorParameters<typeof Viewport>[0]> = {}): Viewport {
  const timeIndex = TimeIndex.from(
    Array.from({ length: 100 }, (_, i) => T0 + i * H),
    H,
    1,
  );
  const price = LinearPriceMapping.fromSamples(100, 400, 200, 0);
  if (!price) throw new Error('mapping');
  return new Viewport({ x0: -500, barSpacing: 8, width: 800, height: 400, timeIndex, price, ...over });
}

describe('Viewport', () => {
  it('converts time and price to pane pixels and back', () => {
    const v = makeViewport();
    expect(v.timeToX(T0 + 70 * H)).toBe(-500 + 70 * 8);
    expect(v.timeToX(T0 + 70.5 * H)).toBe(-500 + 70.5 * 8);
    expect(v.priceToY(150)).toBe(200);
    expect(v.xToTime(v.timeToX(T0 + 81.25 * H))).toBeCloseTo(T0 + 81.25 * H, 3);
    expect(v.yToPrice(v.priceToY(123.456))).toBeCloseTo(123.456, 9);
  });

  it('handles the future area to the right of the last bar', () => {
    const v = makeViewport();
    expect(v.timeToX(T0 + 105 * H)).toBe(-500 + 105 * 8);
  });

  it('reports the nominal horizontal scale', () => {
    expect(makeViewport().pxPerMs).toBeCloseTo(8 / H, 15);
  });

  it('rejects degenerate price samples', () => {
    expect(LinearPriceMapping.fromSamples(1, 10, 1, 20)).toBeNull();
    expect(LinearPriceMapping.fromSamples(1, 10, 2, 10)).toBeNull();
  });
});
