import type {
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesPrimitive,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  Time,
} from 'lightweight-charts';
import type { Viewport } from '../../chart/viewport';

type CanvasRenderingTarget2D = Parameters<IPrimitivePaneRenderer['draw']>[0];
import type { Drawing } from '../model';
import { renderDrawings } from './strokes';

export interface DrawingsSource {
  viewport(): Viewport | null;
  drawings(): readonly Drawing[];
  hidden(): ReadonlySet<string>;
}

/**
 * Renders committed drawings inside the chart's own paint pass (series primitive, 'normal'
 * z-order = main canvas above the candles). Consequences:
 * - drawings move in perfect lockstep with panning/zooming/kinetic scrolling (same frame,
 *   same transform), with no separate synchronisation;
 * - they are included in chart.takeScreenshot();
 * - they are NOT repainted on crosshair moves ('top' z-order primitives live on the crosshair
 *   canvas, which is redrawn on every mouse move and excluded from default screenshots).
 */
export class DrawingsPrimitive implements ISeriesPrimitive<Time> {
  private requestUpdate: (() => void) | null = null;
  private readonly views: readonly IPrimitivePaneView[];
  lastDrawnCount = 0;

  constructor(source: DrawingsSource) {
    const renderer: IPrimitivePaneRenderer = {
      draw: (target: CanvasRenderingTarget2D) => {
        target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
          const v = source.viewport();
          if (!v) return;
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, mediaSize.width, mediaSize.height);
          ctx.clip();
          this.lastDrawnCount = renderDrawings(ctx, source.drawings(), v, { hidden: source.hidden() });
          ctx.restore();
        });
      },
    };
    const view: IPrimitivePaneView = {
      zOrder: (): PrimitivePaneViewZOrder => 'normal',
      renderer: () => renderer,
    };
    this.views = [view];
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.requestUpdate = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  /** Asks the chart to repaint (drawings changed). */
  invalidate(): void {
    this.requestUpdate?.();
  }
}
