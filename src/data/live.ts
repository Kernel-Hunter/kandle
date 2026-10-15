import { bucketStart, getTimeframe, type TimeframeId } from './timeframes';
import { ProviderError, RateLimitError, errorMessage } from './http';
import type { Candle, StreamStatus } from './types';

const DAY = 86_400_000;

const dateFormats = new Map<string, Intl.DateTimeFormat>();

/**
 * UTC midnight of the calendar date `time` falls on in `timeZone`. Daily stock bars are stored
 * at UTC midnight of the trading date, so a trade at 19:30 in New York still belongs to that
 * day even though it is already the next day in UTC.
 */
export function dayStartInZone(time: number, timeZone: string): number {
  if (timeZone === 'UTC') return Math.floor(time / DAY) * DAY;
  let fmt = dateFormats.get(timeZone);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    } catch {
      return Math.floor(time / DAY) * DAY;
    }
    dateFormats.set(timeZone, fmt);
  }
  const parts = Object.fromEntries(fmt.formatToParts(new Date(time)).map((p) => [p.type, p.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
}

/** How far back one page needs to reach to hold `bars` bars, counting nights, weekends and holidays. */
export function sessionLookback(timeframe: TimeframeId, bars: number): number {
  const ms = getTimeframe(timeframe)!.ms;
  if (timeframe === '1D') return Math.ceil(bars * 1.5) * DAY + 10 * DAY;
  if (timeframe === '1W') return bars * 7 * DAY + 10 * DAY;
  // A US session with extended hours is 16 h, so a calendar day holds at most 16 h of bars.
  return Math.ceil((bars * ms * 24) / 16) * 1.5 + 5 * DAY;
}

/**
 * Start of the bar a trade at `time` belongs to.
 *
 * Intraday bars of stock markets are often anchored to the session open (09:30 in New York
 * gives 1h bars at 09:30, 10:30 and so on), so intraday buckets keep the offset of `anchor`,
 * the open time of a bar we already have. Daily and weekly bars use the exchange's calendar.
 */
export function sessionBucketStart(timeframe: TimeframeId, time: number, anchor?: number, timeZone = 'UTC'): number {
  if (timeframe === '1D') return dayStartInZone(time, timeZone);
  if (timeframe === '1W') return bucketStart('1W', dayStartInZone(time, timeZone));
  const ms = getTimeframe(timeframe)!.ms;
  if (anchor === undefined) return Math.floor(time / ms) * ms;
  const offset = ((anchor % ms) + ms) % ms;
  return Math.floor((time - offset) / ms) * ms + offset;
}

export interface Tick {
  price: number;
  /** Traded size. 0 when the feed only has prices. */
  size: number;
  time: number;
}

/**
 * Folds one trade or price update into the bar in progress. A new bar starts only when a trade
 * arrives in a later bucket, so nights, weekends and holidays never get empty placeholder bars.
 */
export function applyTick(current: Candle | null, timeframe: TimeframeId, tick: Tick, timeZone = 'UTC'): Candle {
  const start = sessionBucketStart(timeframe, tick.time, current?.time, timeZone);
  const size = Number.isFinite(tick.size) && tick.size > 0 ? tick.size : 0;
  if (!current || start > current.time) {
    return { time: start, open: tick.price, high: tick.price, low: tick.price, close: tick.price, volume: size };
  }
  if (start < current.time) return current; // late trade for a closed bar
  return {
    ...current,
    high: Math.max(current.high, tick.price),
    low: Math.min(current.low, tick.price),
    close: tick.price,
    volume: current.volume + size,
  };
}

export interface PollingOptions {
  intervalMs: number;
  /** Returns the latest bars, oldest first. */
  poll: () => Promise<Candle[]>;
  onCandle: (candle: Candle) => void;
  onStatus?: (status: StreamStatus) => void;
  onError?: (message: string) => void;
  /** Skip the first request, e.g. when history was just loaded. Default true. */
  delayFirst?: boolean;
}

/**
 * Polls a REST endpoint for the latest bars. Respects rate limits: after a RateLimitError it
 * waits as long as the error says before trying again. Returns a stop function.
 */
export function startPolling(options: PollingOptions): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastError = '';
  let lastTime = -Infinity;

  const schedule = (ms: number) => {
    if (!stopped) timer = setTimeout(run, ms);
  };

  const run = async () => {
    if (stopped) return;
    let next = options.intervalMs;
    try {
      const candles = await options.poll();
      if (stopped) return;
      lastError = '';
      options.onStatus?.('polling');
      for (const c of candles) {
        if (c.time < lastTime) continue;
        lastTime = c.time;
        options.onCandle(c);
      }
    } catch (error) {
      if (stopped) return;
      const message = errorMessage(error);
      if (error instanceof RateLimitError) next = Math.max(next, error.retryAfter * 1000);
      // Report each distinct problem once rather than every poll.
      if (message !== lastError) options.onError?.(message);
      lastError = message;
      // Polling again cannot fix a missing or refused key.
      if (error instanceof ProviderError && (error.kind === 'auth' || error.kind === 'no-key')) {
        stopped = true;
        options.onStatus?.('closed');
        return;
      }
    }
    schedule(next);
  };

  options.onStatus?.('polling');
  if (options.delayFirst === false) void run();
  else schedule(options.intervalMs);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    options.onStatus?.('closed');
  };
}
