export type TimeframeId = '1m' | '5m' | '15m' | '1h' | '4h' | '1D' | '1W';

export interface Timeframe {
  id: TimeframeId;
  label: string;
  ms: number;
  period: { type: 'minute' | 'hour' | 'day' | 'week'; span: number };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const TIMEFRAMES: readonly Timeframe[] = [
  { id: '1m', label: '1m', ms: MINUTE, period: { type: 'minute', span: 1 } },
  { id: '5m', label: '5m', ms: 5 * MINUTE, period: { type: 'minute', span: 5 } },
  { id: '15m', label: '15m', ms: 15 * MINUTE, period: { type: 'minute', span: 15 } },
  { id: '1h', label: '1H', ms: HOUR, period: { type: 'hour', span: 1 } },
  { id: '4h', label: '4H', ms: 4 * HOUR, period: { type: 'hour', span: 4 } },
  { id: '1D', label: '1D', ms: DAY, period: { type: 'day', span: 1 } },
  { id: '1W', label: '1W', ms: 7 * DAY, period: { type: 'week', span: 1 } },
];

export function getTimeframe(id: string): Timeframe | undefined {
  return TIMEFRAMES.find((tf) => tf.id === id);
}

export function isTimeframeId(id: unknown): id is TimeframeId {
  return typeof id === 'string' && TIMEFRAMES.some((tf) => tf.id === id);
}

/** Start of the bar containing `time`. Weekly bars start on Monday 00:00 UTC. */
export function bucketStart(timeframe: TimeframeId, time: number): number {
  if (timeframe === '1W') {
    const dayStart = Math.floor(time / DAY) * DAY;
    const weekday = new Date(dayStart).getUTCDay(); // 0 = Sunday
    const daysSinceMonday = (weekday + 6) % 7;
    return dayStart - daysSinceMonday * DAY;
  }
  const ms = getTimeframe(timeframe)!.ms;
  return Math.floor(time / ms) * ms;
}

/** Number of decimals implied by an increment string such as "0.00100000" (3) or "1" (0). */
export function precisionFromIncrement(increment: string | number): number {
  const text = typeof increment === 'number' ? String(increment) : increment.trim();
  if (/e-/i.test(text)) {
    const exp = Number(text.split(/e-/i)[1]);
    return Number.isFinite(exp) ? exp : 2;
  }
  const dot = text.indexOf('.');
  if (dot === -1) return 0;
  const decimals = text.slice(dot + 1).replace(/0+$/, '');
  return decimals.length;
}
