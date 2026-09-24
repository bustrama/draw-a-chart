import type { Timeframe, TimeframeId } from './types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const TIMEFRAMES: readonly Timeframe[] = [
  { id: '1m', label: '1m', ms: MINUTE },
  { id: '5m', label: '5m', ms: 5 * MINUTE },
  { id: '15m', label: '15m', ms: 15 * MINUTE },
  { id: '1h', label: '1h', ms: HOUR },
  { id: '4h', label: '4h', ms: 4 * HOUR },
  { id: '1d', label: '1D', ms: 24 * HOUR },
];

const BY_ID = new Map<TimeframeId, Timeframe>(TIMEFRAMES.map((tf) => [tf.id, tf]));

export function getTimeframe(id: TimeframeId): Timeframe {
  const tf = BY_ID.get(id);
  if (!tf) throw new Error(`Unknown timeframe: ${id}`);
  return tf;
}

export function isTimeframeId(value: string): value is TimeframeId {
  return BY_ID.has(value as TimeframeId);
}

/** Open time of the bar containing `time`. Valid for UTC-aligned fixed intervals (all supported timeframes). */
export function barOpenTime(time: number, intervalMs: number): number {
  return Math.floor(time / intervalMs) * intervalMs;
}
