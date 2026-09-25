import { TickMarkType, type Time } from 'lightweight-charts';
import { describe, expect, it } from 'vitest';
import { timeFormatters } from './timeFormat';

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
