import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { PEN_COLORS, PEN_WIDTHS } from '../chart/theme';
import type { EngineState, Tool } from '../drawing/DrawingEngine';
import { AutoFitIcon, EraserIcon, LabelIcon, MouseIcon, PenIcon, RedoIcon, SelectIcon, TrashIcon, UndoIcon, WritingIcon } from './icons';

interface ToolbarProps {
  readonly state: EngineState;
  readonly finePointer: boolean;
  readonly onTool: (tool: Tool) => void;
  readonly onColor: (color: string) => void;
  readonly onWidth: (width: number) => void;
  readonly onUndo: () => void;
  readonly onRedo: () => void;
  readonly onDelete: () => void;
  readonly onMouseDraw: (on: boolean) => void;
  readonly onHandwriting: (on: boolean) => void;
  readonly onResetView: () => void;
}

/**
 * Compact tool rail: vertical on the left in landscape, horizontal at the bottom in portrait.
 * It sits beside the chart (never over it) so it can't collide with ink.
 */
export function Toolbar(props: ToolbarProps) {
  const { state } = props;
  // Anchor rectangle of the palette toggle while the palette is open (null = closed).
  const [paletteAt, setPaletteAt] = useState<DOMRect | null>(null);
  const paletteAnchor = useRef<HTMLDivElement>(null);
  const paletteOpen = paletteAt !== null;
  return (
    <aside
      className={[
        'scrollbar-none relative z-10 flex shrink-0 items-center gap-1 border-ink-800 bg-ink-900',
        // Landscape: left rail; the left safe area (notch side) is added to its width.
        'landscape:w-[calc(3rem_+_env(safe-area-inset-left))] landscape:flex-col landscape:overflow-y-auto landscape:border-r',
        'landscape:py-2 landscape:pr-1 landscape:pl-[calc(0.25rem_+_env(safe-area-inset-left))]',
        // Portrait: bottom rail; the home-indicator area is added to its height, not taken from it.
        'portrait:h-[calc(3rem_+_env(safe-area-inset-bottom))] portrait:w-full portrait:flex-row portrait:overflow-x-auto portrait:border-t',
        'portrait:pt-1 portrait:pr-[max(0.25rem,env(safe-area-inset-right))] portrait:pb-[calc(0.25rem_+_env(safe-area-inset-bottom))] portrait:pl-[max(0.25rem,env(safe-area-inset-left))]',
      ].join(' ')}
      aria-label="Drawing tools"
    >
      <ToolButton label="Pen (P)" active={state.tool === 'pen'} onClick={() => props.onTool('pen')} testId="tool-pen">
        <PenIcon />
      </ToolButton>
      <ToolButton label="Eraser (E)" active={state.tool === 'eraser'} onClick={() => props.onTool('eraser')} testId="tool-eraser">
        <EraserIcon />
      </ToolButton>
      <ToolButton label="Select (S)" active={state.tool === 'select'} onClick={() => props.onTool('select')} testId="tool-select">
        <SelectIcon />
      </ToolButton>
      <ToolButton label="Wyckoff labels (L)" active={state.tool === 'stamp'} onClick={() => props.onTool('stamp')} testId="tool-stamp">
        <LabelIcon />
      </ToolButton>

      <Divider />

      <div className="relative" ref={paletteAnchor}>
        <ToolButton
          label="Color and thickness"
          active={paletteOpen}
          onClick={() => setPaletteAt((open) => (open ? null : (paletteAnchor.current?.getBoundingClientRect() ?? null)))}
          testId="palette-toggle"
        >
          <span className="flex items-center justify-center">
            <span className="rounded-full ring-1 ring-white/15" style={{ background: state.color, width: 8 + state.width * 2.4, height: 8 + state.width * 2.4 }} />
          </span>
        </ToolButton>
        {paletteAt && (
          <Palette
            anchor={paletteAt}
            color={state.color}
            width={state.width}
            onColor={(c) => props.onColor(c)}
            onWidth={(w) => props.onWidth(w)}
            onClose={() => setPaletteAt(null)}
          />
        )}
      </div>

      <Divider />

      <ToolButton label="Undo (Ctrl+Z, two-finger tap)" disabled={!state.canUndo} onClick={props.onUndo} testId="undo">
        <UndoIcon />
      </ToolButton>
      <ToolButton label="Redo (Ctrl+Shift+Z, three-finger tap)" disabled={!state.canRedo} onClick={props.onRedo} testId="redo">
        <RedoIcon />
      </ToolButton>
      {state.selectionCount > 0 && (
        <ToolButton label="Delete selection (Del)" onClick={props.onDelete} testId="delete-selection">
          <TrashIcon />
        </ToolButton>
      )}

      <div className="landscape:mt-auto portrait:ml-auto" />

      <ToolButton
        label={state.handwriting ? 'Handwriting detection on (small strokes become notes that stay legible)' : 'Handwriting detection off (all ink anchors point by point)'}
        active={state.handwriting}
        onClick={() => props.onHandwriting(!state.handwriting)}
        testId="handwriting-toggle"
      >
        <WritingIcon />
      </ToolButton>
      {props.finePointer && (
        <ToolButton label="Draw with mouse (D) — hold Space to pan" active={state.mouseDraw} onClick={() => props.onMouseDraw(!state.mouseDraw)} testId="mouse-draw">
          <MouseIcon />
        </ToolButton>
      )}
      <ToolButton label="Reset view (auto-scale, latest bars)" onClick={props.onResetView} testId="reset-view">
        <AutoFitIcon />
      </ToolButton>
    </aside>
  );
}

function Divider() {
  return <span className="shrink-0 bg-ink-800 landscape:my-1 landscape:h-px landscape:w-7 portrait:mx-1 portrait:h-7 portrait:w-px" />;
}

interface ToolButtonProps {
  readonly label: string;
  readonly active?: boolean;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly testId?: string;
  readonly children: ReactNode;
}

function ToolButton({ label, active, disabled, onClick, testId, children }: ToolButtonProps) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      data-testid={testId}
      className={`ui-control flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-colors disabled:opacity-30 ${
        active ? 'bg-ink-700 text-ink-100' : 'text-ink-300 hover:bg-ink-800 hover:text-ink-100'
      }`}
    >
      {children}
    </button>
  );
}

interface PaletteProps {
  /** Rectangle of the toggle; the palette is positioned (fixed) next to it. */
  readonly anchor: DOMRect;
  readonly color: string;
  readonly width: number;
  readonly onColor: (c: string) => void;
  readonly onWidth: (w: number) => void;
  readonly onClose: () => void;
}

const PALETTE_W = 148;
const PALETTE_H = 150;

/**
 * Fixed-position placement: the rail may be a scroll container (narrow layouts), which would
 * clip an absolutely positioned popover.
 */
function palettePosition(anchor: DOMRect): CSSProperties {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const portrait = typeof matchMedia !== 'undefined' && matchMedia('(orientation: portrait)').matches;
  if (portrait) {
    const left = Math.min(Math.max(8, anchor.left + anchor.width / 2 - PALETTE_W / 2), vw - PALETTE_W - 8);
    return { position: 'fixed', left, bottom: vh - anchor.top + 8 };
  }
  return { position: 'fixed', left: anchor.right + 8, top: Math.min(Math.max(8, anchor.top), vh - PALETTE_H - 8) };
}

function Palette({ anchor, color, width, onColor, onWidth, onClose }: PaletteProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      // The wrapper holding the palette toggle counts as inside (the toggle's click closes it).
      const anchor = ref.current?.parentElement ?? ref.current;
      if (anchor && !anchor.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // Defer so the opening tap doesn't immediately close it.
    const id = setTimeout(() => window.addEventListener('pointerdown', onDown, true), 0);
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(id);
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);
  return (
    <div
      ref={ref}
      style={palettePosition(anchor)}
      className="z-40 flex flex-col gap-2 rounded-xl border border-ink-700 bg-ink-850 p-2 shadow-xl shadow-black/40"
      data-testid="palette"
    >
      <div className="grid grid-cols-3 gap-1.5">
        {PEN_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={`Color ${c}`}
            aria-pressed={c === color}
            onClick={() => onColor(c)}
            className={`ui-control h-9 w-9 rounded-full ring-offset-2 ring-offset-ink-850 ${c === color ? 'ring-2 ring-ink-100' : 'ring-1 ring-white/10'}`}
            style={{ background: c }}
          />
        ))}
      </div>
      <div className="flex justify-between gap-1.5 border-t border-ink-700 pt-2">
        {PEN_WIDTHS.map((w) => (
          <button
            key={w}
            type="button"
            aria-label={`Thickness ${w}`}
            aria-pressed={w === width}
            onClick={() => onWidth(w)}
            className={`ui-control flex h-9 w-9 items-center justify-center rounded-lg ${w === width ? 'bg-ink-700' : 'hover:bg-ink-800'}`}
          >
            <span className="rounded-full bg-ink-100" style={{ width: w * 2.2, height: w * 2.2 }} />
          </button>
        ))}
      </div>
    </div>
  );
}
