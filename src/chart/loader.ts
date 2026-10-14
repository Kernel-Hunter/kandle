import type { DataLoader, DataLoaderGetBarsParams, KLineData } from 'klinecharts';
import type { Candle, DataSource, StreamStatus } from '../data/types';
import type { TimeframeId } from '../data/timeframes';

export const PAGE_SIZE = 500;

export function candleToKLine(c: Candle): KLineData {
  return { timestamp: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
}

export interface LoaderHooks {
  /** Resolves the data source and timeframe for the chart's current symbol. */
  resolve(): { source: DataSource; symbol: string; timeframe: TimeframeId };
  onError?(message: string): void;
  onLoading?(loading: boolean): void;
  onLiveCandle?(candle: Candle): void;
  onStreamStatus?(status: StreamStatus): void;
}

/**
 * Bridges a DataSource to the chart engine: first page on init, older pages when the user
 * scrolls left ("forward" in the engine's terms), and a live stream once history is in.
 */
export function createDataLoader(hooks: LoaderHooks): DataLoader & { generation(): number } {
  let generation = 0;
  let unsubscribe: (() => void) | null = null;
  let lastCandle: Candle | undefined;

  const stopStream = () => {
    unsubscribe?.();
    unsubscribe = null;
  };

  return {
    generation: () => generation,

    async getBars(params: DataLoaderGetBarsParams) {
      const { source, symbol, timeframe } = hooks.resolve();
      if (params.type === 'init') {
        generation += 1;
        lastCandle = undefined;
      }
      const myGeneration = generation;
      // The engine only asks for older data ('forward') and the initial page here.
      if (params.type !== 'init' && params.type !== 'forward') {
        params.callback([], false);
        return;
      }
      const before = params.type === 'forward' ? params.timestamp ?? undefined : undefined;
      if (params.type === 'init') hooks.onLoading?.(true);
      try {
        const candles = await source.fetchCandles(symbol, timeframe, { before, limit: PAGE_SIZE });
        if (myGeneration !== generation) return; // symbol or timeframe changed meanwhile
        if (params.type === 'init') lastCandle = candles[candles.length - 1];
        params.callback(candles.map(candleToKLine), { forward: candles.length > 0, backward: false });
      } catch (error) {
        if (myGeneration !== generation) return;
        const message = error instanceof Error ? error.message : String(error);
        hooks.onError?.(`Could not load ${symbol} ${timeframe}: ${message}`);
        if (params.type === 'init') {
          params.callback([], false);
        } else {
          // Let the user retry by scrolling again, but not in a tight loop.
          setTimeout(() => {
            if (myGeneration === generation) params.callback([], { forward: true, backward: false });
          }, 3000);
        }
      } finally {
        if (params.type === 'init' && myGeneration === generation) hooks.onLoading?.(false);
      }
    },

    subscribeBar(params) {
      stopStream();
      const { source, symbol, timeframe } = hooks.resolve();
      const myGeneration = generation;
      unsubscribe = source.subscribe(
        symbol,
        timeframe,
        (candle) => {
          if (myGeneration !== generation) return;
          lastCandle = candle;
          params.callback(candleToKLine(candle));
          hooks.onLiveCandle?.(candle);
        },
        { seed: lastCandle, onStatus: (s) => hooks.onStreamStatus?.(s) },
      );
    },

    unsubscribeBar() {
      stopStream();
    },
  };
}
