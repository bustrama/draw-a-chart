import type { PaneRect } from '../../chart/ChartController';

/**
 * Transparent canvas positioned exactly over the chart pane (pointer-events: none). Renders only
 * transient content: the stroke being drawn, QuickShape preview, eraser cursor, lasso,
 * selection outlines and remote live previews. Kept out of the chart's canvases so that
 * (a) redrawing the in-progress stroke never repaints candles, and (b) screenshots contain
 * committed drawings only.
 */
export class LiveLayer {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private rect: PaneRect = { left: 0, top: 0, width: 0, height: 0 };
  private dpr = 1;
  private hasContent = false;

  constructor(host: HTMLElement) {
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.dataset.layer = 'live-ink';
    Object.assign(canvas.style, {
      position: 'absolute',
      left: '0px',
      top: '0px',
      width: '0px',
      height: '0px',
      pointerEvents: 'none',
      zIndex: '3',
    } satisfies Partial<CSSStyleDeclaration>);
    host.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    this.canvas = canvas;
    this.ctx = ctx;
  }

  /** Positions the layer over the pane; resizes the backing store only when needed. */
  setRect(rect: PaneRect): void {
    const dpr = window.devicePixelRatio || 1;
    const same =
      rect.left === this.rect.left &&
      rect.top === this.rect.top &&
      rect.width === this.rect.width &&
      rect.height === this.rect.height &&
      dpr === this.dpr;
    if (same) return;
    this.rect = rect;
    this.dpr = dpr;
    const s = this.canvas.style;
    s.left = `${rect.left}px`;
    s.top = `${rect.top}px`;
    s.width = `${rect.width}px`;
    s.height = `${rect.height}px`;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.hasContent = true; // backing store reset; force a redraw by the caller
  }

  get paneRect(): PaneRect {
    return this.rect;
  }

  /** Clears and redraws. `draw` works in pane-local CSS px and returns whether it drew anything. */
  render(draw: (ctx: CanvasRenderingContext2D, width: number, height: number) => boolean): void {
    const ctx = this.ctx;
    if (this.hasContent) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.hasContent = false;
    }
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, this.rect.width, this.rect.height);
    ctx.clip();
    this.hasContent = draw(ctx, this.rect.width, this.rect.height);
    ctx.restore();
  }

  dispose(): void {
    this.canvas.remove();
  }
}
