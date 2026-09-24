import type { Candle } from '../types';

/**
 * Parses one REST kline row:
 * [openTime, open, high, low, close, volume, closeTime, quoteVolume, trades, takerBase, takerQuote, ignore]
 * `now` decides whether the bar is still forming (the newest row usually is).
 */
export function parseRestKline(row: unknown, now: number): Candle | null {
  if (!Array.isArray(row) || row.length < 9) return null;
  const time = row[0];
  const closeTime = row[6];
  if (typeof time !== 'number' || typeof closeTime !== 'number') return null;
  const candle: Candle = {
    time,
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    trades: typeof row[8] === 'number' ? row[8] : undefined,
    closed: closeTime < now,
  };
  return isFiniteCandle(candle) ? candle : null;
}

export interface StreamKline {
  readonly symbol: string;
  readonly interval: string;
  readonly candle: Candle;
}

/** Parses the `data` object of a kline stream event (`{ e: 'kline', s, k: {...} }`). */
export function parseStreamKline(data: unknown): StreamKline | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.e !== 'kline' || typeof d.k !== 'object' || d.k === null) return null;
  const k = d.k as Record<string, unknown>;
  if (typeof k.t !== 'number' || typeof k.s !== 'string' || typeof k.i !== 'string') return null;
  const candle: Candle = {
    time: k.t,
    open: Number(k.o),
    high: Number(k.h),
    low: Number(k.l),
    close: Number(k.c),
    volume: Number(k.v),
    trades: typeof k.n === 'number' ? k.n : undefined,
    closed: k.x === true,
  };
  if (!isFiniteCandle(candle)) return null;
  return { symbol: k.s, interval: k.i, candle };
}

export function klineStreamName(symbol: string, interval: string): string {
  // Stream names must be lowercase; an uppercase name connects but never delivers data.
  return `${symbol.toLowerCase()}@kline_${interval}`;
}

function isFiniteCandle(c: Candle): boolean {
  return (
    Number.isFinite(c.time) &&
    Number.isFinite(c.open) &&
    Number.isFinite(c.high) &&
    Number.isFinite(c.low) &&
    Number.isFinite(c.close) &&
    Number.isFinite(c.volume)
  );
}
