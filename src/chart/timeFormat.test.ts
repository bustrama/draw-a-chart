import { TickMarkType, type Time, type TickMarkWeightValue } from 'lightweight-charts';
import { describe, expect, it } from 'vitest';
import { timeFormatters, ZonedTimeScale } from './timeFormat';

const t = (iso: string) => (Date.parse(iso) / 1000) as Time;

describe('timeFormatters', () => {
  it('labels US charts in New York time', () => {
    const f = timeFormatters('America/New_York');
    expect(f.timeFormatter(t('2026-09-25T13:30:00Z'))).toBe("Fri 25 Sep '26  09:30");
    expect(f.tickMarkFormatter(t('2026-01-15T14:30:00Z'), TickMarkType.Time, 'en')).toBe('09:30');
    expect(f.tickMarkFormatter(t('2026-09-25T13:30:00Z'), TickMarkType.DayOfMonth, 'en')).toBe('25');
    expect(f.tickMarkFormatter(t('2026-09-25T13:30:00Z'), TickMarkType.Month, 'en')).toBe('Sep');
  });

  it('shows only the date on daily charts (bars open at New York midnight)', () => {
    expect(timeFormatters('America/New_York', true).timeFormatter(t('2026-09-25T04:00:00Z'))).toBe("Fri 25 Sep '26");
  });

  it('keeps UTC for crypto', () => {
    expect(timeFormatters().timeFormatter(t('2026-09-25T23:15:00Z'))).toBe("Fri 25 Sep '26  23:15");
  });
});

/** Time-scale points as the chart builds them. */
const points = (scale: ZonedTimeScale, isos: readonly string[]) =>
  isos.map((iso) => ({ timeWeight: 0 as TickMarkWeightValue, time: scale.convertHorzItemToInternal(t(iso)), originalTime: t(iso) }));
// Lightweight Charts' weights of day and month marks.
const DAY = 50;
const MONTH = 60;

describe('ZonedTimeScale', () => {
  // A futures weekend in New York (EDT): Friday 15:00 and 16:00, then Sunday 18:00 to Monday 01:00.
  const HOURS = ['2026-09-25T19:00:00Z', '2026-09-25T20:00:00Z', '2026-09-27T22:00:00Z', '2026-09-27T23:00:00Z', '2026-09-28T00:00:00Z', '2026-09-28T01:00:00Z', '2026-09-28T04:00:00Z', '2026-09-28T05:00:00Z'];
  const weights = (scale: ZonedTimeScale) => {
    const p = points(scale, HOURS);
    scale.fillWeightsForPoints(p, 0);
    return Object.fromEntries(HOURS.map((iso, i) => [iso.slice(5, 16), p[i].timeWeight as number]));
  };

  it('puts day marks where the date changes in New York', () => {
    const scale = new ZonedTimeScale();
    scale.timeZone = 'America/New_York';
    const w = weights(scale);
    expect(w['09-27T22:00']).toBe(DAY); // Sunday 18:00: the first bar of the 27th
    expect(w['09-28T00:00']).toBeLessThan(DAY); // 20:00 in New York: UTC midnight means nothing there
    expect(w['09-28T04:00']).toBe(DAY); // midnight in New York
  });

  it('keeps UTC marks for crypto', () => {
    const w = weights(new ZonedTimeScale());
    expect(w['09-28T00:00']).toBe(DAY);
    expect(w['09-28T04:00']).toBeLessThan(DAY);
  });

  it('marks the month in New York, also when only new bars are weighed', () => {
    const scale = new ZonedTimeScale();
    scale.timeZone = 'America/New_York';
    const p = points(scale, ['2026-09-30T23:00:00Z', '2026-10-01T00:00:00Z', '2026-10-01T03:00:00Z', '2026-10-01T04:00:00Z']);
    scale.fillWeightsForPoints(p, 0);
    p[3].timeWeight = 0 as TickMarkWeightValue;
    scale.fillWeightsForPoints(p, 3); // a new bar at the end
    expect(p[1].timeWeight).toBeLessThan(MONTH); // 20:00 on 30 September in New York
    expect(p[3].timeWeight).toBe(MONTH); // midnight, 1 October in New York
  });
});
