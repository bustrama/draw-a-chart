import { Fragment, useLayoutEffect, useRef, type WheelEvent } from 'react';
import { STAMP_LABELS, type StampGroup } from '../drawing/stamps';

interface LabelStripProps {
  /** The armed label (what a tap on the chart places). */
  readonly armed: string;
  /** Pen colour: the armed chip shows the colour the stamp will have. */
  readonly color: string;
  readonly onPick: (label: string) => void;
  /** Where the strip ends, in CSS px from the top of the chart (null once it is gone). */
  readonly onBottom?: (px: number | null) => void;
}

const GROUPS: ReadonlyArray<{ readonly group: StampGroup; readonly caption: string | null }> = [
  { group: 'accumulation', caption: 'acc' },
  { group: 'distribution', caption: 'dist' },
  { group: 'waves', caption: null },
  { group: 'phases', caption: 'phase' },
];

/** Test id of a label's chip, e.g. `stamp-sc`, `stamp-1st-b`, `stamp-phase-c`. */
function stampTestId(text: string): string {
  return `stamp-${text.toLowerCase().replace(/\s+/g, '-')}`;
}

/** A mouse wheel scrolls the row sideways (it has no scrollbar). */
function scrollSideways(e: WheelEvent<HTMLDivElement>): void {
  if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
  e.currentTarget.scrollLeft += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
}

/**
 * The stamp tool's labels, over the top edge of the chart (the chart keeps room below it, see
 * `onBottom`). Tap a chip to arm it, then tap bars to place it. The row scrolls sideways with a
 * finger or the mouse wheel when it is wider than the chart.
 */
export function LabelStrip({ armed, color, onPick, onBottom }: LabelStripProps) {
  const row = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = row.current;
    if (!el || !onBottom) return;
    // The wrapper sits at the top of the chart's container, so this is px from the chart's top.
    const report = () => onBottom(el.offsetTop + el.offsetHeight);
    report();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(report);
    observer?.observe(el);
    return () => {
      observer?.disconnect();
      onBottom(null);
    };
  }, [onBottom]);

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex px-2 pt-2">
      <div
        ref={row}
        role="group"
        aria-label="Wyckoff labels"
        data-testid="label-strip"
        onWheel={scrollSideways}
        className="scrollbar-none pointer-events-auto flex max-w-[calc(100%-4.5rem)] items-center gap-0.5 overflow-x-auto rounded-xl border border-ink-700 bg-ink-900/90 p-1 shadow-lg shadow-black/30"
      >
        {GROUPS.map(({ group, caption }, i) => (
          <Fragment key={group}>
            {i > 0 && <span aria-hidden="true" className="mx-1 h-6 w-px shrink-0 bg-ink-700" />}
            {caption && (
              <span aria-hidden="true" className="shrink-0 px-1 text-[10px] font-semibold tracking-wide text-ink-400 uppercase">
                {caption}
              </span>
            )}
            {STAMP_LABELS.filter((l) => l.group === group).map((l) => {
              const on = l.text === armed;
              const name = l.group === 'phases' ? l.name : `${l.text}: ${l.name}`;
              return (
                <button
                  key={l.text}
                  type="button"
                  title={name}
                  aria-label={name}
                  aria-pressed={on}
                  data-testid={stampTestId(l.text)}
                  onClick={() => onPick(l.text)}
                  className={`ui-control h-8 min-w-8 shrink-0 rounded-md px-2 text-[13px] font-bold whitespace-nowrap transition-colors ${
                    on ? 'bg-ink-700 ring-1 ring-ink-400' : 'text-ink-200 hover:bg-ink-800 hover:text-ink-100'
                  }`}
                  style={on ? { color } : undefined}
                >
                  {l.chip}
                </button>
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
