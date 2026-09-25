import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';

/** Minimum gap between a popover and the viewport's left edge, in CSS px. */
const VIEWPORT_MARGIN = 8;

interface PopoverProps {
  readonly onClose: () => void;
  /** Which edge of the anchor the panel lines up with (default: right). */
  readonly align?: 'left' | 'right';
  readonly className?: string;
  readonly testId?: string;
  readonly children: ReactNode;
}

/**
 * Anchored panel that closes on outside press or Escape. The anchor wrapper (the popover's parent,
 * which also holds the toggle button) counts as inside, so pressing the toggle closes the panel
 * through its own click instead of closing and immediately reopening it.
 *
 * The panel is aligned to its anchor's right (or left) edge; on narrow screens (Slide Over, 320 px)
 * it is shifted just enough to stay inside the viewport, and its width is capped to the viewport.
 */
export function Popover({ onClose, align = 'right', className = '', testId, children }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.transform = '';
      const rect = el.getBoundingClientRect();
      const overflowLeft = VIEWPORT_MARGIN - rect.left;
      const overflowRight = rect.right - (window.innerWidth - VIEWPORT_MARGIN);
      if (overflowLeft > 0) el.style.transform = `translateX(${overflowLeft}px)`;
      else if (overflowRight > 0) el.style.transform = `translateX(${-Math.min(overflowRight, rect.left - VIEWPORT_MARGIN)}px)`;
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const anchor = ref.current?.parentElement ?? ref.current;
      if (anchor && !anchor.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
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
      data-testid={testId}
      className={`absolute top-full ${align === 'left' ? 'left-0' : 'right-0'} z-30 mt-1.5 max-w-[calc(100vw-16px)] rounded-xl border border-ink-700 bg-ink-850 p-3 text-sm shadow-2xl shadow-black/50 ${className}`}
    >
      {children}
    </div>
  );
}
