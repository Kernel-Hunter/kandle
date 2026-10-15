import type { DataLoader, DataLoaderGetBarsParams, DataLoaderSubscribeBarParams, DataLoaderUnsubscribeBarParams, KLineData, Period } from 'klinecharts';

export interface ChartContext {
  ticker: string;
  period: Period;
}

export interface ReplayFeed {
  /** Bars to show when the chart (re)loads in replay. */
  initial(): KLineData[];
  /** The symbol and period the replay was started on. */
  context: ChartContext;
}

const contextKey = (c: ChartContext) => `${c.ticker}|${c.period.type}|${c.period.span}`;

/**
 * Sits between the chart and the live data loader. Normally it passes calls through;
 * during replay it serves bars from a ReplayFeed instead. It also tells listeners when a
 * new symbol or period starts loading and when the first page has arrived, which the
 * layout sync, alerts and agent bridge use.
 *
 * Every 'init' load starts a new generation; callbacks from older generations are
 * dropped so a slow live request can never overwrite replay bars, or the reverse.
 */
export class SwitchingLoader implements DataLoader {
  private generation = 0;
  private feed: ReplayFeed | null = null;
  private replayPush: ((bar: KLineData) => void) | null = null;
  private readonly contextListeners = new Set<(c: ChartContext) => void>();
  private readonly loadListeners = new Set<(c: ChartContext, bars: number) => void>();
  private readonly exitListeners = new Set<() => void>();

  constructor(private readonly live: DataLoader) {}

  get replaying(): boolean {
    return this.feed !== null;
  }

  onContext(listener: (c: ChartContext) => void): () => void {
    this.contextListeners.add(listener);
    return () => this.contextListeners.delete(listener);
  }

  onLoaded(listener: (c: ChartContext, bars: number) => void): () => void {
    this.loadListeners.add(listener);
    return () => this.loadListeners.delete(listener);
  }

  /** Called when replay ends because the symbol or period changed underneath it. */
  onReplayInterrupted(listener: () => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** Resolves after the next initial load finishes, or rejects after `timeoutMs`. */
  nextLoad(timeoutMs = 15_000): Promise<number> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error('Timed out waiting for chart data'));
      }, timeoutMs);
      const off = this.onLoaded((_c, bars) => {
        clearTimeout(timer);
        off();
        resolve(bars);
      });
    });
  }

  /** Switch to replay. The caller then resets the chart so it reloads through the feed. */
  enterReplay(feed: ReplayFeed): void {
    this.feed = feed;
    this.replayPush = null;
  }

  exitReplay(): void {
    this.feed = null;
    this.replayPush = null;
  }

  /** Appends (or updates) a bar while replaying. */
  push(bar: KLineData): void {
    this.replayPush?.(bar);
  }

  getBars(params: DataLoaderGetBarsParams): void | Promise<void> {
    const context: ChartContext = { ticker: params.symbol.ticker, period: params.period };
    if (params.type === 'init') {
      this.generation += 1;
      if (this.feed && contextKey(this.feed.context) !== contextKey(context)) {
        this.exitReplay();
        for (const l of this.exitListeners) l();
      }
      for (const l of this.contextListeners) l(context);
    }
    const generation = this.generation;
    const callback = params.callback;
    const guarded: DataLoaderGetBarsParams = {
      ...params,
      callback: (data, more) => {
        if (generation !== this.generation) return;
        callback(data, more);
        if (params.type === 'init') for (const l of this.loadListeners) l(context, data.length);
      },
    };
    if (this.feed) {
      if (params.type === 'init') guarded.callback(this.feed.initial(), { forward: false, backward: false });
      else guarded.callback([], false);
      return;
    }
    return this.live.getBars(guarded);
  }

  subscribeBar(params: DataLoaderSubscribeBarParams): void {
    const generation = this.generation;
    const callback = params.callback;
    const guarded = (bar: KLineData) => {
      if (generation === this.generation) callback(bar);
    };
    if (this.feed) {
      this.replayPush = guarded;
      return;
    }
    this.live.subscribeBar?.({ ...params, callback: guarded });
  }

  unsubscribeBar(params: DataLoaderUnsubscribeBarParams): void {
    this.replayPush = null;
    this.live.unsubscribeBar?.(params);
  }
}
