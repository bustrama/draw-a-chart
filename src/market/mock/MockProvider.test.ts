import { describe, expect, it } from 'vitest';
import { MOCK_FUTURES_SYMBOLS, mockFuturesCalendar, MockProvider } from './MockProvider';

// Monday 28 Sep 2026, 12:00 New York.
const NOW = Date.parse('2026-09-28T16:00:00Z');

describe('MockProvider', () => {
  it('pages older futures daily bars without repeating the first one', async () => {
    const provider = new MockProvider({ now: () => NOW, liveIntervalMs: null, calendar: mockFuturesCalendar(), symbols: MOCK_FUTURES_SYMBOLS });
    const latest = await provider.fetchCandles({ symbol: 'ES', timeframe: '1d', limit: 3 });
    expect(latest.map((c) => new Date(c.time).toISOString().slice(0, 10))).toEqual(['2026-09-24', '2026-09-25', '2026-09-28']);
    // Older than Thursday's bar (whose session opened on Wednesday evening).
    const older = await provider.fetchCandles({ symbol: 'ES', timeframe: '1d', limit: 2, endTime: latest[0].time - 1 });
    expect(older.map((c) => new Date(c.time).toISOString().slice(0, 10))).toEqual(['2026-09-22', '2026-09-23']);
  });
});
