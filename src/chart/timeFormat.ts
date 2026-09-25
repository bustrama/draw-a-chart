import { TickMarkType, type Time, type TickMarkFormatter } from 'lightweight-charts';

export interface TimeFormatters {
  /** Time-axis labels. */
  readonly tickMarkFormatter: TickMarkFormatter;
  /** Crosshair label. */
  readonly timeFormatter: (time: Time) => string;
}

const cache = new Map<string, TimeFormatters>();

/**
 * Axis and crosshair labels in the exchange's time zone (New York for US stocks, UTC for crypto).
 * Bar times stay absolute UTC timestamps; only the labels change. Lightweight Charts picks tick
 * positions from UTC calendar boundaries, which works because a US session never crosses UTC
 * midnight and New York's offset is a whole number of hours.
 */
export function timeFormatters(timeZone = 'UTC', daily = false): TimeFormatters {
  const key = `${timeZone}|${daily}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const make = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { timeZone, ...options });
  const hm = make({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const hms = make({ hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const dayOfMonth = make({ day: 'numeric' });
  const month = new Intl.DateTimeFormat('en-US', { timeZone, month: 'short' }); // "Sep", not "Sept"
  const year = make({ year: 'numeric' });
  // "Wed 23 Sep '26", composed from parts: locales disagree on punctuation ("Wed.", "Sept").
  const dateParts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', day: 'numeric', month: 'short', year: '2-digit' });
  const date = {
    format: (d: Date) => {
      const p = Object.fromEntries(dateParts.formatToParts(d).map((x) => [x.type, x.value]));
      return `${p.weekday} ${p.day} ${p.month} '${p.year}`;
    },
  };
  const toDate = (time: Time) => new Date((time as number) * 1000);
  const formatters: TimeFormatters = {
    tickMarkFormatter: (time, type) => {
      const d = toDate(time);
      switch (type) {
        case TickMarkType.Year:
          return year.format(d);
        case TickMarkType.Month:
          return month.format(d);
        case TickMarkType.DayOfMonth:
          return dayOfMonth.format(d);
        case TickMarkType.TimeWithSeconds:
          return hms.format(d);
        default:
          return hm.format(d);
      }
    },
    timeFormatter: (time) => {
      const d = toDate(time);
      return daily ? date.format(d) : `${date.format(d)}  ${hm.format(d)}`;
    },
  };
  cache.set(key, formatters);
  return formatters;
}
