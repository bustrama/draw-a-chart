import { afterEach, describe, expect, it, vi } from 'vitest';
import { NEW_YORK, SessionCalendar, sessionsFromCalendar } from '../../shared/sessions.ts';
import { CandleFeed } from './candleFeed';
import type { SeriesChange } from './candleSeries';
import { FakeProvider, flushMicrotasks, makeCandles } from './testing/fakes';
import { getTimeframe } from './timeframes';
import type { Candle } from './types';

const tf = getTimeframe('1m');
const M = tf.ms;
const T0 = Date.UTC(2026, 5, 1);

function setup(history: Candle[]) {
  const provider = new FakeProvider();
  provider.handler = (req) => {
    let rows = history;
    if (req.startTime !== undefined) rows = rows.filter((c) => c.time >= req.startTime!);
    if (req.endTime !== undefined) rows = rows.filter((c) => c.time <= req.endTime!);
    return req.startTime !== undefined ? rows.slice(0, req.limit) : rows.slice(-req.limit);
  };
  const changes: SeriesChange[] = [];
  const feed = new CandleFeed(provider, 'BTCUSDT', tf, { onChange: (c) => changes.push(c) }, { now: () => T0 + 10_000 * M });
  return { provider, feed, changes };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('CandleFeed', () => {
  it('buffers live updates during the initial load and merges them without duplicates', async () => {
    const history = makeCandles(T0, 50, M);
    const { provider, feed, changes } = setup(history);
    feed.start();
    provider.listener?.onCandle({ ...history[49], close: 999, closed: true });
    provider.listener?.onCandle({ ...history[49], time: T0 + 50 * M, closed: false });
    await flushMicrotasks();
    expect(changes).toEqual([{ kind: 'general' }]);
    expect(feed.series.length).toBe(51);
    expect(feed.series.all()[49].close).toBe(999);
  });

  it('applies live updates as tail changes', async () => {
    const history = makeCandles(T0, 10, M, false);
    const { provider, feed, changes } = setup(history);
    feed.start();
    await flushMicrotasks();
    provider.listener?.onCandle({ ...history[9], close: 123, volume: 999 });
    expect(changes.at(-1)).toMatchObject({ kind: 'tail' });
    expect(feed.series.last?.close).toBe(123);
    expect(feed.series.length).toBe(10);
  });

  it('backfills missed bars when a live update skips ahead', async () => {
    const all = makeCandles(T0, 20, M);
    const { provider, feed } = setup(all.slice(0, 15));
    feed.start();
    await flushMicrotasks();
    provider.handler = (req) => all.filter((c) => c.time >= req.startTime! && c.time <= req.endTime!);
    provider.listener?.onCandle({ ...all[19], closed: false });
    await feed.whenIdle();
    const req = provider.requests.at(-1)!;
    expect(req.startTime).toBe(all[14].time);
    expect(req.endTime).toBe(all[19].time - 1);
    expect(feed.series.findGaps()).toEqual([]);
    expect(feed.series.length).toBe(20);
  });

  it('remembers exchange-side gaps instead of re-fetching them', async () => {
    const history = [...makeCandles(T0, 5, M), ...makeCandles(T0 + 10 * M, 5, M)];
    const { provider, feed } = setup(history);
    feed.start();
    await flushMicrotasks();
    await feed.whenIdle();
    const afterFirstBackfill = provider.requests.length;
    expect(afterFirstBackfill).toBe(2); // initial + one attempt for the gap
    expect(feed.series.findGaps()).toHaveLength(1);
    // Reconnect: only the tail is refreshed, the known gap is not requested again.
    provider.listener?.onResync?.();
    await feed.whenIdle();
    expect(provider.requests.at(-1)?.startTime).toBe(history.at(-1)!.time);
  });

  it('recovers after reconnect by fetching from the last bar', async () => {
    const all = makeCandles(T0, 30, M);
    const { provider, feed } = setup(all.slice(0, 20));
    feed.start();
    await flushMicrotasks();
    provider.handler = (req) => all.filter((c) => c.time >= req.startTime!).slice(0, req.limit);
    provider.listener?.onResync?.();
    await feed.whenIdle();
    expect(feed.series.length).toBe(30);
    expect(provider.requests.at(-1)?.startTime).toBe(all[19].time);
  });

  it('pages older history and detects the end of history', async () => {
    const all = makeCandles(T0, 60, M);
    const { provider, feed, changes } = setup(all);
    provider.handler = (req) => {
      const rows = all.filter((c) => req.endTime === undefined || c.time <= req.endTime);
      return rows.slice(-Math.min(req.limit, 20));
    };
    feed.start();
    await flushMicrotasks();
    expect(feed.series.length).toBe(20);
    await feed.loadOlder();
    expect(changes.at(-1)).toEqual({ kind: 'prepend', count: 20 });
    expect(provider.requests.at(-1)?.endTime).toBe(all[40].time - 1);
    await feed.loadOlder();
    await feed.loadOlder();
    expect(feed.currentState.historyExhausted).toBe(true);
    expect(feed.series.length).toBe(60);
  });

  it('re-fetches a bar whose final update was missed', async () => {
    vi.useFakeTimers();
    const history = makeCandles(T0, 5, M, false); // last bar still open
    const { provider, feed } = setup(history);
    feed.start();
    await vi.advanceTimersByTimeAsync(0);
    provider.handler = (req) => [{ ...history[4], closed: true }, { ...history[4], time: history[4].time + M, closed: false }].filter((c) => c.time >= req.startTime!);
    provider.listener?.onCandle({ ...history[4], time: history[4].time + M, closed: false });
    const before = provider.requests.length;
    await vi.advanceTimersByTimeAsync(1_600);
    await feed.whenIdle();
    expect(provider.requests.length).toBe(before + 1);
    expect(provider.requests.at(-1)?.startTime).toBe(history[4].time);
    expect(feed.series.all()[4].closed).toBe(true);
  });

  it('finalizes a bar that closed while the initial history was loading', async () => {
    vi.useFakeTimers();
    const history = makeCandles(T0, 10, M, false); // REST saw the last bar still open
    const { provider, feed } = setup(history);
    feed.start();
    // The stream already moved on to the next bar before the history arrived.
    provider.listener?.onCandle({ ...history[9], time: history[9].time + M, closed: false });
    const final = { ...history[9], closed: true, volume: 999 };
    provider.handler = (req) => (req.startTime !== undefined ? [final, { ...history[9], time: history[9].time + M, closed: false }].filter((c) => c.time >= req.startTime!) : history);
    await vi.advanceTimersByTimeAsync(0);
    expect(feed.series.all()[9].closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1_600);
    await feed.whenIdle();
    expect(provider.requests.at(-1)?.startTime).toBe(history[9].time);
    expect(feed.series.all()[9]).toMatchObject({ closed: true, volume: 999 });
  });

  it('with complete history, only checks where live updates join it', async () => {
    const history = [...makeCandles(T0, 5, M), ...makeCandles(T0 + 10 * M, 5, M)]; // a hole inside
    const { provider, feed } = setup(history);
    provider.completeHistory = true;
    feed.start();
    await flushMicrotasks();
    await feed.whenIdle();
    expect(provider.requests).toHaveLength(1); // no attempt to fill the hole (e.g. minutes without trades)
  });

  it('ignores late responses after dispose and unsubscribes', async () => {
    const history = makeCandles(T0, 10, M);
    const { provider, feed, changes } = setup(history);
    let release: (v: Candle[]) => void = () => undefined;
    provider.handler = () => new Promise((resolve) => (release = resolve));
    feed.start();
    feed.dispose();
    release(history);
    await flushMicrotasks();
    expect(changes).toEqual([]);
    expect(provider.unsubscribed).toBe(1);
  });
});

describe('CandleFeed with trading sessions', () => {
  const H = 3_600_000;
  const z = (iso: string) => Date.parse(iso);
  const cal = new SessionCalendar(
    sessionsFromCalendar(
      ['2026-09-24', '2026-09-25', '2026-09-28'].map((date) => ({ date, open: '09:30', close: '16:00' })),
      NEW_YORK,
    ),
  );
  const clock = cal.clock(H);
  const tf1h = getTimeframe('1h');

  /** Every hourly bar of the calendar (7 a day), oldest first. */
  function sessionBars(): Candle[] {
    const out: Candle[] = [];
    for (let t = cal.sessions[0].open; t < cal.sessions[2].close; t = clock.next(t)) out.push({ time: t, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1, closed: true });
    return out;
  }

  function sessionSetup(history: Candle[]) {
    const provider = new FakeProvider();
    provider.handler = (req) => {
      let rows = history;
      if (req.startTime !== undefined) rows = rows.filter((c) => c.time >= req.startTime!);
      if (req.endTime !== undefined) rows = rows.filter((c) => c.time <= req.endTime!);
      return req.startTime !== undefined ? rows.slice(0, req.limit) : rows.slice(-req.limit);
    };
    const feed = new CandleFeed(provider, 'AAPL', tf1h, { onChange: () => undefined }, { clock, now: () => z('2026-09-28T21:00:00Z') });
    return { provider, feed };
  }

  it('does not treat nights and weekends as gaps', async () => {
    const all = sessionBars();
    expect(all).toHaveLength(21);
    const { provider, feed } = sessionSetup(all);
    feed.start();
    await flushMicrotasks();
    await feed.whenIdle();
    expect(provider.requests).toHaveLength(1);
    expect(feed.series.findGaps()).toEqual([]);
  });

  it('backfills only when the live feed really skipped a bar', async () => {
    const all = sessionBars();
    const friday = all.filter((c) => c.time < z('2026-09-26T00:00:00Z'));
    const { provider, feed } = sessionSetup(friday.slice(0, -1)); // up to Friday 18:30Z
    feed.start();
    await flushMicrotasks();
    provider.handler = (req) => all.filter((c) => c.time >= req.startTime! && c.time <= req.endTime!);
    // Monday's first bar arrives, but Friday's 19:30Z bar was never seen: fetch it.
    provider.listener?.onCandle({ ...all[14], closed: false });
    await feed.whenIdle();
    expect(provider.requests.at(-1)).toMatchObject({ startTime: z('2026-09-25T18:30:00Z'), endTime: z('2026-09-28T13:30:00Z') - 1 });
    expect(feed.series.findGaps()).toEqual([]);
    // The next bar directly follows: no request.
    const count = provider.requests.length;
    provider.listener?.onCandle({ ...all[15], closed: false });
    await feed.whenIdle();
    expect(provider.requests).toHaveLength(count);
  });
});
