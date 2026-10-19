/**
 * Series that scripts request with request.security, loaded through the same DataSource
 * adapters as the chart. Each series is kept in memory and shared by every script that
 * asks for it, extended to older history as the chart scrolls back, and kept current with
 * a live stream on keyless sources or a slow refresh on keyed ones (their free plans
 * allow few requests).
 */
import type { RequestFeeds, RequestSeries, ResolvedRequest } from '../script/security';
import { requestKey } from '../script/security';
import type { Candle as ScriptCandle } from '../script/runtime';
import { RateLimitError } from './http';
import { getTimeframe } from './timeframes';
import type { Candle, DataSource } from './types';

/** Bars loaded per request. Adapters clamp it to their API limit. */
const PAGE = 1000;
/** Requested bars kept before the chart's first bar, so indicators have history to start from. */
export const WARMUP_BARS = 500;
/** At most this many bars per series. Lower timeframes may not reach back as far as the chart. */
export const MAX_FEED_BARS = 5000;
/** Keyed sources refresh the latest bars at most this often. */
const KEYED_REFRESH_MS = 5 * 60_000;
/** A series nobody asked for in this long loses its live stream. */
const IDLE_MS = 2 * 60_000;

interface Entry {
  req: ResolvedRequest;
  bars: ScriptCandle[];
  version: number;
  error: string | null;
  loading: Promise<void> | null;
  /** The source has no older bars. */
  exhausted: boolean;
  /** Earliest time callers asked for. */
  wanted: number;
  retryAt: number;
  lastFetch: number;
  lastNeeded: number;
  unsubscribe: (() => void) | null;
}

export interface SeriesFeedsOptions {
  source(id: string): DataSource | undefined;
  now?: () => number;
}

const toScript = (c: Candle): ScriptCandle => ({ timestamp: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });

export class SeriesFeeds implements RequestFeeds {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(key: string) => void>();
  private readonly now: () => number;
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: SeriesFeedsOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Called with a series key after its history changed (first load, older bars). */
  onChange(fn: (key: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  hasSource(id: string): boolean {
    return this.options.source(id) !== undefined;
  }

  series(req: ResolvedRequest): RequestSeries | null {
    const entry = this.entries.get(requestKey(req));
    if (!entry) return null;
    if (entry.error && entry.bars.length === 0) return { bars: entry.bars, version: entry.version, error: entry.error };
    return entry.version > 0 ? { bars: entry.bars, version: entry.version } : null;
  }

  need(req: ResolvedRequest, from: number): void {
    const entry = this.entry(req);
    entry.lastNeeded = this.now();
    if (!this.covers(entry, from)) void this.load(req, from);
    else this.refresh(entry);
  }

  /** Loads a series back to `from` (ms). Resolves when it is covered or failed; never rejects. */
  load(req: ResolvedRequest, from: number): Promise<void> {
    const entry = this.entry(req);
    entry.wanted = Math.min(entry.wanted, from);
    if (entry.loading) return entry.loading;
    if (this.covers(entry, from) || this.now() < entry.retryAt) return Promise.resolve();
    entry.loading = this.fill(entry).finally(() => {
      entry.loading = null;
    });
    return entry.loading;
  }

  /** Drops live streams of series no script has used for a while. Runs on a timer. */
  sweep(now = this.now()): void {
    for (const entry of this.entries.values()) {
      if (entry.unsubscribe && now - entry.lastNeeded > IDLE_MS) {
        entry.unsubscribe();
        entry.unsubscribe = null;
      }
    }
    if (this.sweeper && ![...this.entries.values()].some((e) => e.unsubscribe)) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
  }

  private entry(req: ResolvedRequest): Entry {
    const key = requestKey(req);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { req, bars: [], version: 0, error: null, loading: null, exhausted: false, wanted: Infinity, retryAt: 0, lastFetch: 0, lastNeeded: 0, unsubscribe: null };
      this.entries.set(key, entry);
    }
    return entry;
  }

  private target(entry: Entry): number {
    return entry.wanted - WARMUP_BARS * getTimeframe(entry.req.timeframe)!.ms;
  }

  private covers(entry: Entry, from: number): boolean {
    if (entry.version === 0) return false;
    if (entry.exhausted || entry.bars.length >= MAX_FEED_BARS) return true;
    const want = Math.min(entry.wanted, from) - WARMUP_BARS * getTimeframe(entry.req.timeframe)!.ms;
    return entry.bars.length > 0 && entry.bars[0].timestamp <= want;
  }

  private async fill(entry: Entry): Promise<void> {
    const { req } = entry;
    const source = this.options.source(req.source);
    if (!source) {
      entry.error = `Unknown data source ${req.source}`;
      entry.version++;
      this.notify(entry);
      return;
    }
    try {
      if (entry.bars.length === 0) {
        const latest = await source.fetchCandles(req.symbol, req.timeframe, { limit: PAGE });
        entry.bars = latest.map(toScript);
        entry.lastFetch = this.now();
        if (latest.length === 0) entry.exhausted = true;
      }
      while (!entry.exhausted && entry.bars.length > 0 && entry.bars.length < MAX_FEED_BARS && entry.bars[0].timestamp > this.target(entry)) {
        const first = entry.bars[0].timestamp;
        const older = await source.fetchCandles(req.symbol, req.timeframe, { before: first, limit: PAGE });
        const fresh = older.filter((c) => c.time < first).map(toScript);
        if (fresh.length === 0) entry.exhausted = true;
        else entry.bars = fresh.concat(entry.bars);
      }
      entry.error = null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      entry.retryAt = this.now() + (error instanceof RateLimitError ? error.retryAfter * 1000 : 30_000);
      // Keep what loaded; only a series with no bars at all is an error for the script.
      if (entry.bars.length === 0) entry.error = message;
      else entry.exhausted = true;
    }
    entry.version++;
    this.subscribe(entry, source);
    this.notify(entry);
  }

  /** Keyless sources stream; local data never changes. */
  private subscribe(entry: Entry, source: DataSource): void {
    if (entry.unsubscribe || source.auth || source.local || entry.bars.length === 0) return;
    const last = entry.bars[entry.bars.length - 1];
    entry.unsubscribe = source.subscribe(entry.req.symbol, entry.req.timeframe, (c) => this.merge(entry, [c]), {
      seed: { time: last.timestamp, open: last.open, high: last.high, low: last.low, close: last.close, volume: last.volume ?? 0 },
    });
    this.sweeper ??= setInterval(() => this.sweep(), 30_000);
  }

  /** Keyed sources: fetch the latest page now and then, and soon after a requested bar closes. */
  private refresh(entry: Entry): void {
    const source = this.options.source(entry.req.source);
    if (!source || !source.auth || source.local || entry.loading || entry.bars.length === 0) return;
    const now = this.now();
    if (now < entry.retryAt) return;
    const last = entry.bars[entry.bars.length - 1];
    const closed = now >= last.timestamp + getTimeframe(entry.req.timeframe)!.ms;
    if (now - entry.lastFetch < (closed ? 60_000 : KEYED_REFRESH_MS)) return;
    entry.lastFetch = now;
    entry.loading = source
      .fetchCandles(entry.req.symbol, entry.req.timeframe, { limit: 50 })
      .then((latest) => this.merge(entry, latest))
      .catch((error: unknown) => {
        entry.retryAt = this.now() + (error instanceof RateLimitError ? error.retryAfter * 1000 : 60_000);
      })
      .finally(() => {
        entry.loading = null;
      });
  }

  /** Replaces bars with the same time and appends newer ones. */
  private merge(entry: Entry, candles: readonly Candle[]): void {
    const bars = entry.bars;
    let changed = false;
    for (const c of candles) {
      const last = bars[bars.length - 1];
      if (!last || c.time > last.timestamp) {
        bars.push(toScript(c));
        changed = true;
        continue;
      }
      for (let i = bars.length - 1; i >= 0 && bars[i].timestamp >= c.time; i--) {
        if (bars[i].timestamp === c.time) {
          bars[i] = toScript(c);
          changed = true;
          break;
        }
      }
    }
    if (changed) entry.version++;
  }

  private notify(entry: Entry): void {
    const key = requestKey(entry.req);
    for (const fn of this.listeners) fn(key);
  }
}
