import { defaultHorzScaleBehavior, TickMarkType, type Mutable, type Time, type TickMarkFormatter, type TimeScalePoint } from 'lightweight-charts';
import { offsetAt } from '../../shared/sessions.ts';

export interface TimeFormatters {
  /** Time-axis labels. */
  readonly tickMarkFormatter: TickMarkFormatter;
  /** Crosshair label. */
  readonly timeFormatter: (time: Time) => string;
}

const cache = new Map<string, TimeFormatters>();

/**
 * Axis and crosshair labels in the exchange's time zone (New York for stocks and futures, UTC for
 * crypto). Bar times stay absolute UTC timestamps; only the labels change. Which bars get a day,
 * month or year mark is decided by `ZonedTimeScale` in the same zone.
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

const TimeScaleBase = defaultHorzScaleBehavior();

/**
 * Lightweight Charts' time scale with tick marks weighed in the exchange's time zone: day, month
 * and year marks go where the date changes there, not in UTC. (Futures sessions run across UTC
 * midnight, which is 20:00 in New York: UTC weights put the day mark in the evening.) Bar times
 * stay absolute UTC timestamps. Set `timeZone` before replacing the data.
 */
export class ZonedTimeScale extends TimeScaleBase {
  private zone = 'UTC';
  /** Offset (s) of the zone per UTC hour: daylight saving time changes on the hour. */
  private readonly offsets = new Map<number, number>();

  get timeZone(): string {
    return this.zone;
  }

  set timeZone(zone: string) {
    if (zone === this.zone) return;
    this.zone = zone;
    this.offsets.clear();
  }

  override fillWeightsForPoints(points: readonly Mutable<TimeScalePoint>[], startIndex: number): void {
    if (this.zone === 'UTC' || points.some((p, i) => i >= startIndex - 1 && typeof p.originalTime !== 'number')) {
      super.fillWeightsForPoints(points, startIndex);
      return;
    }
    // The library weighs by UTC calendar fields: hand it the wall-clock times as if they were UTC.
    const from = Math.max(0, startIndex - 1);
    const shifted = points.slice(from).map((p) => ({
      timeWeight: p.timeWeight,
      time: this.convertHorzItemToInternal(this.wall(p.originalTime as number) as Time),
      originalTime: p.originalTime,
    }));
    super.fillWeightsForPoints(shifted, startIndex - from);
    for (let i = startIndex; i < points.length; i++) points[i].timeWeight = shifted[i - from].timeWeight;
  }

  /** Wall-clock time in the zone, in UTC seconds. */
  private wall(seconds: number): number {
    const hour = Math.floor(seconds / 3600);
    let offset = this.offsets.get(hour);
    if (offset === undefined) {
      offset = offsetAt(seconds * 1000, this.zone) / 1000;
      this.offsets.set(hour, offset);
    }
    return seconds + offset;
  }
}
