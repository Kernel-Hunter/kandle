import { ProviderError, RateLimitError, errorMessage } from '../data/http';
import { computeChange, type Ticker, type TickerFeed } from '../data/tickers';
import type { TimeframeId } from '../data/timeframes';
import type { DataSource, StreamStatus } from '../data/types';
import type { KeyValueStorage } from '../store/layout';
import { addItem, itemKey, loadWatchlist, moveItem, removeItem, saveWatchlist, type WatchItem, type WatchlistConfig } from './store';

/**
 * What a row's change is measured against.
 * `24h`: the price 24 hours ago, from the exchange's rolling 24 h ticker.
 * `prev_close`: the close of the previous daily bar (sources that need a key).
 * `prev_bar`: the bar before the last one (imported CSV data).
 */
export type ChangeBasis = '24h' | 'prev_close' | 'prev_bar';

/**
 * `live`: streamed. `polled`: from a REST request. `chart`: the last price a chart on screen
 * loaded. `static`: imported data. `paused`: the panel or the tab is hidden, values are the last seen.
 */
export type QuoteStatus = 'loading' | 'live' | 'polled' | 'chart' | 'static' | 'paused' | 'no-key' | 'error';

export interface Quote {
  price: number | null;
  reference: number | null;
  basis: ChangeBasis;
  /** When the price was last updated, ms. */
  time: number | null;
  status: QuoteStatus;
  error?: string;
}

export const BASIS_LABELS: Record<ChangeBasis, string> = {
  '24h': 'Change over the last 24 hours (rolling window)',
  prev_close: 'Change since the previous daily close',
  prev_bar: 'Last close of the imported data against the bar before it',
};

/**
 * How often rows of sources without a ticker stream are refreshed, and the gap between two
 * requests to the same source. Charts share these providers' free-plan budgets (Twelve Data 8
 * a minute and 800 a day, Polygon 5 a minute, Alpaca 200 a minute), so the watchlist stays well
 * under them. Polygon's free plan is end-of-day data, so there is little point asking often.
 */
export const POLL_PLAN: Record<string, { intervalMs: number; spacingMs: number }> = {
  twelvedata: { intervalMs: 10 * 60_000, spacingMs: 20_000 },
  polygon: { intervalMs: 30 * 60_000, spacingMs: 20_000 },
  alpaca: { intervalMs: 2 * 60_000, spacingMs: 2_000 },
  csv: { intervalMs: 60_000, spacingMs: 100 },
};
const DEFAULT_POLL = { intervalMs: 10 * 60_000, spacingMs: 20_000 };

/** A price from a chart counts as current for this long. */
const CHART_FRESH_MS = 60_000;

/** Streams stop this long after the tab is hidden, and start again when it is shown. */
export const HIDDEN_GRACE_MS = 60_000;

export interface WatchlistDeps {
  storage: KeyValueStorage;
  source(id: string): DataSource | undefined;
  /** True when the source needs no key or the user saved one. */
  hasKey(source: DataSource): boolean;
  /** Ticker streams by source id. Sources without one are polled. */
  feeds: Readonly<Record<string, TickerFeed>>;
  now?: () => number;
  /** Open the panel on first run (no saved watchlist yet). */
  openByDefault?: boolean;
  pollPlan?: Record<string, { intervalMs: number; spacingMs: number }>;
  hiddenGraceMs?: number;
}

export interface WatchlistRow {
  exchange: string;
  symbol: string;
  price: number | null;
  change: number | null;
  change_percent: number | null;
  basis: ChangeBasis;
  updated_at: string | null;
  status: QuoteStatus;
  error?: string;
}

const round = (v: number | null): number | null => (v === null || !Number.isFinite(v) ? null : Number(v.toPrecision(10)));

/**
 * The watchlist's symbols and their quotes. Streams and polls run only while something wants
 * them: the open panel in a visible tab, or an agent asking for fresh prices.
 */
export class WatchlistController {
  private config: WatchlistConfig;
  private readonly quotes = new Map<string, Quote>();
  private readonly listeners = new Set<() => void>();
  private readonly streams = new Map<string, { key: string; stop: () => void }>();
  private readonly streamStatus = new Map<string, StreamStatus>();
  /** One polling loop per source without a stream; `timer` is null while a request runs. */
  private readonly pollers = new Map<string, { timer: ReturnType<typeof setTimeout> | null }>();
  /** When each polled row was last asked for, by item key. */
  private readonly polledAt = new Map<string, number>();
  private readonly now: () => number;
  private tabPaused = false;
  private hiddenTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeHolds = 0;
  private disposed = false;

  constructor(private readonly deps: WatchlistDeps) {
    this.now = deps.now ?? Date.now;
    this.config = loadWatchlist(deps.storage, (id) => !!deps.source(id), deps.openByDefault ?? false);
  }

  /** Starts the feeds if the saved state has the panel open. Call once the page is ready. */
  start(): void {
    this.sync();
  }

  // ---------------------------------------------------------------- list

  items(): WatchItem[] {
    return this.config.items.map((i) => ({ ...i }));
  }

  get open(): boolean {
    return this.config.open;
  }

  /** True while streams and polls are running. */
  get running(): boolean {
    return this.streams.size > 0 || this.pollers.size > 0;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  private persist(): void {
    saveWatchlist(this.deps.storage, this.config);
  }

  setOpen(open: boolean): void {
    if (open === this.config.open) return;
    this.config = { ...this.config, open };
    this.persist();
    this.sync();
    this.emit();
  }

  /** Returns false when the symbol is already listed or the list is full. */
  add(item: WatchItem, index?: number): boolean {
    if (!this.deps.source(item.source)) return false;
    const next = addItem(this.config.items, item, index);
    if (!next) return false;
    this.config = { ...this.config, items: next };
    this.persist();
    this.sync();
    this.emit();
    return true;
  }

  remove(item: WatchItem): boolean {
    const next = removeItem(this.config.items, item);
    if (!next) return false;
    this.config = { ...this.config, items: next };
    this.quotes.delete(itemKey(item));
    this.polledAt.delete(itemKey(item));
    this.persist();
    this.sync();
    this.emit();
    return true;
  }

  move(from: number, to: number): void {
    if (from === to) return;
    this.config = { ...this.config, items: moveItem(this.config.items, from, to) };
    this.persist();
    this.emit();
  }

  // ---------------------------------------------------------------- quotes

  basisFor(sourceId: string): ChangeBasis {
    if (this.deps.feeds[sourceId]) return '24h';
    return this.deps.source(sourceId)?.local ? 'prev_bar' : 'prev_close';
  }

  quote(item: WatchItem): Quote {
    return this.quotes.get(itemKey(item)) ?? { price: null, reference: null, basis: this.basisFor(item.source), time: null, status: this.running ? 'loading' : 'paused' };
  }

  /** Stream state of a source's ticker feed, for sources that have one. */
  feedStatus(sourceId: string): StreamStatus | undefined {
    return this.streamStatus.get(sourceId);
  }

  private setQuote(item: WatchItem, patch: Partial<Quote>): void {
    const key = itemKey(item);
    if (!this.config.items.some((i) => itemKey(i) === key)) return;
    this.quotes.set(key, { ...this.quote(item), ...patch });
    this.emit();
  }

  /**
   * A price from a chart on screen. Rows of polled sources take it, so a symbol that is also on a
   * chart moves with it. Streamed rows keep their own feed so price and change come from one place.
   */
  onChartPrice(source: string, symbol: string, price: number, time: number): void {
    if (this.deps.feeds[source] || !Number.isFinite(price)) return;
    const item = { source, symbol };
    if (!this.config.items.some((i) => i.source === source && i.symbol === symbol)) return;
    const current = this.quote(item);
    if (current.price === price && current.status === 'chart') return;
    this.setQuote(item, { price, time: Number.isFinite(time) ? time : this.now(), status: current.status === 'static' ? 'static' : 'chart', error: undefined });
  }

  report(): WatchlistRow[] {
    return this.config.items.map((item) => {
      const q = this.quote(item);
      const change = q.price !== null && q.reference !== null ? computeChange(q.price, q.reference) : null;
      return {
        exchange: item.source,
        symbol: item.symbol,
        price: round(q.price),
        change: change ? round(change.change) : null,
        change_percent: change && change.percent !== null ? Number(change.percent.toFixed(3)) : null,
        basis: q.basis,
        updated_at: q.time !== null ? new Date(q.time).toISOString() : null,
        status: q.status,
        ...(q.error ? { error: q.error } : {}),
      };
    });
  }

  /**
   * Starts the feeds for a moment if they are not running (panel closed or tab hidden), waits
   * until every row has a price or `timeoutMs` passes, and keeps them on for `lingerMs` so
   * calls in quick succession reuse the same connections.
   */
  async refresh(timeoutMs = 4000, lingerMs = 30_000): Promise<void> {
    this.wakeHolds += 1;
    this.sync();
    try {
      await new Promise<void>((resolve) => {
        const ready = () =>
          this.config.items.every((i) => {
            const q = this.quotes.get(itemKey(i));
            // Rows whose stream just (re)started say loading until their first update.
            return q && q.status !== 'loading' && q.status !== 'paused';
          });
        if (ready()) return resolve();
        const timer = setTimeout(done, timeoutMs);
        const off = this.onChange(() => ready() && done());
        function done() {
          clearTimeout(timer);
          off();
          resolve();
        }
      });
    } finally {
      setTimeout(() => {
        this.wakeHolds -= 1;
        this.sync();
      }, lingerMs);
    }
  }

  /** Call when the page is hidden or shown. Feeds stop after a grace period and resume on show. */
  setPageVisible(visible: boolean): void {
    if (visible) {
      if (this.hiddenTimer) clearTimeout(this.hiddenTimer);
      this.hiddenTimer = null;
      if (this.tabPaused) {
        this.tabPaused = false;
        this.sync();
      }
      return;
    }
    if (this.hiddenTimer || this.tabPaused) return;
    this.hiddenTimer = setTimeout(() => {
      this.hiddenTimer = null;
      this.tabPaused = true;
      this.sync();
    }, this.deps.hiddenGraceMs ?? HIDDEN_GRACE_MS);
  }

  /** Call when a source's key was saved or removed, so its rows are asked for again. */
  keysChanged(sourceId: string): void {
    for (const item of this.config.items) {
      if (item.source !== sourceId) continue;
      this.polledAt.delete(itemKey(item));
      this.quotes.delete(itemKey(item));
    }
    this.sync();
    this.emit();
  }

  dispose(): void {
    this.disposed = true;
    if (this.hiddenTimer) clearTimeout(this.hiddenTimer);
    this.stopAll();
    this.listeners.clear();
  }

  // ---------------------------------------------------------------- feeds

  private wanted(): boolean {
    return !this.disposed && ((this.config.open && !this.tabPaused) || this.wakeHolds > 0);
  }

  private stopAll(): void {
    const was = this.running;
    for (const s of this.streams.values()) s.stop();
    this.streams.clear();
    this.streamStatus.clear();
    for (const p of this.pollers.values()) if (p.timer) clearTimeout(p.timer);
    this.pollers.clear();
    if (!was) return;
    for (const [key, q] of this.quotes) if (q.status === 'live' || q.status === 'loading') this.quotes.set(key, { ...q, status: 'paused' });
    this.emit();
  }

  /** Starts, restarts or stops feeds so they match the list and whether anything wants them. */
  private sync(): void {
    if (!this.wanted()) {
      this.stopAll();
      return;
    }
    const bySource = new Map<string, string[]>();
    for (const item of this.config.items) bySource.set(item.source, [...(bySource.get(item.source) ?? []), item.symbol]);

    for (const [sourceId, stream] of this.streams) {
      const symbols = bySource.get(sourceId);
      if (!symbols || stream.key !== [...symbols].sort().join(',')) {
        stream.stop();
        this.streams.delete(sourceId);
        this.streamStatus.delete(sourceId);
      }
    }
    for (const [sourceId, poller] of this.pollers) {
      if (!bySource.has(sourceId)) {
        if (poller.timer) clearTimeout(poller.timer);
        this.pollers.delete(sourceId);
      }
    }

    for (const [sourceId, symbols] of bySource) {
      const feed = this.deps.feeds[sourceId];
      if (feed) {
        if (!this.streams.has(sourceId)) this.startStream(sourceId, feed, symbols);
      } else if (!this.pollers.has(sourceId)) {
        const poller = { timer: null };
        this.pollers.set(sourceId, poller);
        this.pollTick(sourceId, poller);
      }
    }
  }

  private startStream(sourceId: string, feed: TickerFeed, symbols: string[]): void {
    for (const symbol of symbols) {
      const item = { source: sourceId, symbol };
      const q = this.quote(item);
      if (q.status === 'paused') this.quotes.set(itemKey(item), { ...q, status: 'loading' });
    }
    const stop = feed.watch(
      symbols,
      (t: Ticker) => this.setQuote({ source: sourceId, symbol: t.symbol }, { price: t.price, reference: t.reference, time: t.time, status: 'live', basis: '24h', error: undefined }),
      (status) => {
        this.streamStatus.set(sourceId, status);
        this.emit();
      },
    );
    this.streams.set(sourceId, { key: [...symbols].sort().join(','), stop });
  }

  /** Asks for the row of this source that is most overdue, then waits the source's spacing. */
  private pollTick(sourceId: string, poller: { timer: ReturnType<typeof setTimeout> | null }): void {
    if (this.pollers.get(sourceId) !== poller) return;
    poller.timer = null;
    const plan = (this.deps.pollPlan ?? POLL_PLAN)[sourceId] ?? DEFAULT_POLL;
    const now = this.now();
    const due = this.config.items
      .filter((i) => i.source === sourceId)
      .map((item) => ({ item, at: this.polledAt.get(itemKey(item)) }))
      .filter((r) => r.at === undefined || now - r.at >= plan.intervalMs)
      .sort((a, b) => (a.at ?? -Infinity) - (b.at ?? -Infinity))[0];
    const next = () => {
      // Stopped or replaced while the request ran.
      if (this.pollers.get(sourceId) === poller) poller.timer = setTimeout(() => this.pollTick(sourceId, poller), plan.spacingMs);
    };
    if (!due) {
      next();
      return;
    }
    this.polledAt.set(itemKey(due.item), now);
    void this.pollOne(due.item, plan.intervalMs).finally(next);
  }

  private async pollOne(item: WatchItem, intervalMs: number): Promise<void> {
    const source = this.deps.source(item.source);
    const basis = this.basisFor(item.source);
    if (!source) return;
    if (!this.deps.hasKey(source)) {
      this.setQuote(item, { status: 'no-key', basis, error: `Add your ${source.name} API key in Data sources` });
      return;
    }
    // Daily bars give the previous close; imported data uses its own bar size.
    const timeframes = source.timeframesFor?.(item.symbol) ?? source.timeframes;
    const timeframe: TimeframeId = source.local ? (timeframes[0] ?? '1D') : '1D';
    try {
      const bars = await source.fetchCandles(item.symbol, timeframe, { limit: 2 });
      const last = bars[bars.length - 1];
      const prev = bars.length > 1 ? bars[bars.length - 2] : null;
      if (!last) throw new Error(`${source.name} has no recent bars for ${item.symbol}`);
      const current = this.quote(item);
      // A chart streaming this symbol right now has a fresher price than a delayed daily bar.
      const keepChart = current.status === 'chart' && current.time !== null && this.now() - current.time < CHART_FRESH_MS;
      this.setQuote(item, {
        price: keepChart ? current.price : last.close,
        time: keepChart ? current.time : source.local ? last.time : this.now(),
        reference: prev ? prev.close : null,
        basis,
        status: keepChart ? 'chart' : source.local ? 'static' : 'polled',
        error: undefined,
      });
    } catch (error) {
      if (error instanceof RateLimitError) {
        // Try again once the provider allows it instead of waiting a whole interval.
        this.polledAt.set(itemKey(item), this.now() - intervalMs + error.retryAfter * 1000);
        return;
      }
      const noKey = error instanceof ProviderError && (error.kind === 'no-key' || error.kind === 'auth');
      this.setQuote(item, { status: noKey ? 'no-key' : 'error', basis, error: errorMessage(error) });
    }
  }
}
