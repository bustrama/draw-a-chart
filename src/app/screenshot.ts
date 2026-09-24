import type { Workspace } from './Workspace';

export interface Snapshot {
  readonly canvas: HTMLCanvasElement;
  /** Encoded PNG (starts encoding immediately). */
  readonly blob: Promise<Blob>;
  readonly filename: string;
  readonly title: string;
}

/**
 * Captures exactly what the chart shows: panes, axes and committed drawings (the drawings are
 * painted inside the chart's own canvases). Crosshair, the stroke in progress and selection
 * outlines are transient and not included.
 */
export function takeSnapshot(ws: Workspace): Snapshot {
  const canvas = ws.chart.takeScreenshot();
  const blob = new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the PNG'))), 'image/png');
  });
  const { symbol, timeframe } = ws.market;
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return { canvas, blob, filename: `${symbol}_${timeframe}_${stamp}.png`, title: `${symbol} ${timeframe}` };
}

export function clipboardImageSupported(): boolean {
  if (typeof ClipboardItem === 'undefined' || typeof navigator.clipboard?.write !== 'function') return false;
  const supports = (ClipboardItem as unknown as { supports?: (type: string) => boolean }).supports;
  return typeof supports === 'function' ? supports('image/png') : true;
}

/**
 * Writes the PNG to the clipboard. MUST be called synchronously from the tap/click handler:
 * Safari only honours clipboard writes made during the user gesture, and accepts a promise
 * for the data so the encoding may finish afterwards.
 */
export function copyImage(blob: Promise<Blob>): Promise<void> {
  const item = new ClipboardItem({ 'image/png': blob });
  return navigator.clipboard.write([item]);
}

export function downloadImage(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function canShareFile(file: File): boolean {
  try {
    return typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

/** Native share sheet (iPad: Copy / Save Image / Files; Android: any app). Call from the gesture. */
export function shareImage(file: File, title: string): Promise<void> {
  return navigator.share({ files: [file], title });
}

/** iOS/iPadOS (including iPadOS reporting as Mac with touch). Download links are unreliable in Home Screen apps there. */
export function isAppleTouchDevice(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
