import type { Clock, StreamSocket } from '../binance/stream';
import { clockFor, getTimeframe } from '../timeframes';
import type { Candle, CandleRequest, LiveCandleListener, MarketDataProvider, PreparedChart, SymbolInfo, TimeframeId } from '../types';

/** Deterministic timer implementation for tests. */
export class ManualClock implements Clock {
  private t: number;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();
  private nextId = 1;

  constructor(start = 0) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(id: unknown): void {
    this.timers.delete(id as number);
  }

  /** Advances time, running due timers in order (including ones scheduled while advancing). */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let nextId = -1;
      let nextAt = Infinity;
      for (const [id, timer] of this.timers) {
        if (timer.at <= end && timer.at < nextAt) {
          nextAt = timer.at;
          nextId = id;
        }
      }
      if (nextId === -1) break;
      const timer = this.timers.get(nextId);
      this.timers.delete(nextId);
      this.t = nextAt;
      timer?.fn();
    }
    this.t = end;
  }

  get pendingTimers(): number {
    return this.timers.size;
  }
}

export class FakeSocket implements StreamSocket {
  readyState = 0;
  readonly sent: string[] = [];
  closedByClient = false;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  /** Simulates the server or network closing the connection. */
  drop(): void {
    this.readyState = 3;
    this.onclose?.({});
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closedByClient = true;
    this.readyState = 3;
    this.onclose?.({});
  }
}

export class FakeProvider implements MarketDataProvider {
  readonly id = 'fake';
  readonly name = 'Fake';
  readonly maxCandlesPerRequest: number;
  completeHistory = false;
  readonly requests: CandleRequest[] = [];
  listener: LiveCandleListener | null = null;
  unsubscribed = 0;
  handler: (req: CandleRequest) => Candle[] | Promise<Candle[]> = () => [];

  constructor(maxCandlesPerRequest = 1000) {
    this.maxCandlesPerRequest = maxCandlesPerRequest;
  }

  symbols(): readonly SymbolInfo[] {
    return [];
  }

  async prepare(symbol: string, timeframe: TimeframeId): Promise<PreparedChart> {
    return { info: { symbol, base: symbol, quote: '', pricePrecision: 2, minMove: 0.01 }, clock: clockFor(getTimeframe(timeframe)) };
  }

  async fetchCandles(req: CandleRequest): Promise<Candle[]> {
    this.requests.push(req);
    return this.handler(req);
  }

  subscribeCandles(_symbol: string, _timeframe: TimeframeId, listener: LiveCandleListener): () => void {
    this.listener = listener;
    return () => {
      this.unsubscribed++;
      this.listener = null;
    };
  }
}

/** Generates a deterministic candle history at the given interval. */
export function makeCandles(start: number, count: number, intervalMs: number, closedAll = true): Candle[] {
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = open + Math.sin(i / 3) * 2;
    out.push({
      time: start + i * intervalMs,
      open,
      high: Math.max(open, close) + 1,
      low: Math.min(open, close) - 1,
      close,
      volume: 10 + (i % 7),
      closed: closedAll || i < count - 1,
    });
    price = close;
  }
  return out;
}

export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
