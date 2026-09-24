/** Restrained dark palette for long analysis sessions. Shared by chart, UI and screenshots. */
export const THEME = {
  background: '#0b0e13',
  panel: '#11151c',
  grid: '#151a23',
  border: '#1e2530',
  text: '#8a93a6',
  textStrong: '#d6dbe4',
  crosshair: '#5d6778',
  up: '#26a69a',
  down: '#ef5350',
  upVolume: 'rgba(38, 166, 154, 0.35)',
  downVolume: 'rgba(239, 83, 80, 0.35)',
  watermark: 'rgba(138, 147, 166, 0.07)',
  selection: '#5aa9ff',
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
} as const;

export const PEN_COLORS = ['#f5f5f5', '#ffd166', '#4cc9f0', '#ff5ca8', '#06d6a0', '#ff6b6b'] as const;
export const PEN_WIDTHS = [1.5, 2.5, 4] as const;
