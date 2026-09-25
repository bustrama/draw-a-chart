import type { BarClock } from '../../shared/sessions.ts';
import type { Bar } from './cache.ts';

/**
 * Upstream bars (sorted, any resolution that divides the target) to bars of `clock`: each bar
 * goes to the bar of `clock` containing its open time; bars outside every session (pre- and
 * post-market) are dropped. Several source bars in one target bar are combined: first open,
 * highest high, lowest low, last close, summed volume.
 *
 * Used for US stocks: 30-minute bars become regular-hours hourly (9:30, 10:30 …, the last one
 * 15:30-16:00) and 4-hour bars (9:30, 13:30); native 1/5/15-minute and daily bars only lose their
 * extended-hours bars.
 */
export function toSessionBars(source: readonly Bar[], clock: BarClock): Bar[] {
  const out: Bar[] = [];
  let cur: { t: number; o: number; h: number; l: number; c: number; v: number } | null = null;
  for (const b of source) {
    const t = clock.bucket(b.t);
    if (t === null) continue;
    if (cur && cur.t === t) {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v;
      continue;
    }
    if (cur) out.push(cur);
    cur = { t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
  }
  if (cur) out.push(cur);
  return out;
}
