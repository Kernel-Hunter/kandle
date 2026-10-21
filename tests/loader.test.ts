import { describe, expect, it, vi } from 'vitest';
import type { DataLoaderGetBarsParams, KLineData } from 'klinecharts';
import { createDataLoader, PAGE_SIZE } from '../src/chart/loader';
import type { Candle, DataSource, FetchCandlesOptions } from '../src/data/types';

const MIN = 60_000;
const candle = (time: number): Candle => ({ time, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 });

function stubSource(fetchImpl: (opts: FetchCandlesOptions) => Promise<Candle[]>): DataSource {
  return {
    id: 'stub',
    name: 'Stub',
    timeframes: ['1m'],
    listSymbols: async () => [],
    getSymbol: async () => null,
    fetchCandles: (_s, _tf, opts = {}) => fetchImpl(opts),
    subscribe: () => () => undefined,
  };
}

function request(type: 'init' | 'forward' | 'backward', timestamp: number | null = null) {
  const callback = vi.fn<(data: KLineData[], more?: unknown) => void>();
  const params = {
    type,
    timestamp,
    symbol: { ticker: 'BTCUSDT', pricePrecision: 2, volumePrecision: 2 },
    period: { type: 'minute', span: 1 },
    callback,
  } as DataLoaderGetBarsParams;
  return { params, callback };
}

describe('createDataLoader', () => {
  it('loads the first page and asks for more history', async () => {
    const fetchCandles = vi.fn(async () => [candle(MIN), candle(2 * MIN)]);
    const loader = createDataLoader({ resolve: () => ({ source: stubSource(fetchCandles), symbol: 'BTCUSDT', timeframe: '1m' }) });
    const { params, callback } = request('init');
    await loader.getBars(params);
    expect(fetchCandles).toHaveBeenCalledWith({ before: undefined, limit: PAGE_SIZE });
    expect(callback).toHaveBeenCalledWith(
      [
        { timestamp: MIN, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 },
        { timestamp: 2 * MIN, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 },
      ],
      { forward: true, backward: false },
    );
  });

  it('uses the oldest bar as the cursor when scrolling back, and stops at an empty page', async () => {
    const fetchCandles = vi.fn(async (opts: FetchCandlesOptions) => (opts.before === 5 * MIN ? [candle(4 * MIN)] : []));
    const loader = createDataLoader({ resolve: () => ({ source: stubSource(fetchCandles), symbol: 'BTCUSDT', timeframe: '1m' }) });

    const first = request('forward', 5 * MIN);
    await loader.getBars(first.params);
    expect(fetchCandles).toHaveBeenLastCalledWith({ before: 5 * MIN, limit: PAGE_SIZE });
    expect(first.callback.mock.calls[0][1]).toEqual({ forward: true, backward: false });

    const second = request('forward', 4 * MIN);
    await loader.getBars(second.params);
    expect(second.callback).toHaveBeenCalledWith([], { forward: false, backward: false });
  });

  it('drops responses that arrive after the symbol changed', async () => {
    let release!: (v: Candle[]) => void;
    const slow = new Promise<Candle[]>((r) => (release = r));
    const fetchCandles = vi.fn().mockReturnValueOnce(slow).mockResolvedValue([candle(MIN)]);
    const loader = createDataLoader({ resolve: () => ({ source: stubSource(fetchCandles), symbol: 'X', timeframe: '1m' }) });

    const stale = request('init');
    const pending = loader.getBars(stale.params);
    const fresh = request('init');
    await loader.getBars(fresh.params);
    release([candle(99 * MIN)]);
    await pending;

    expect(fresh.callback).toHaveBeenCalledTimes(1);
    expect(stale.callback).not.toHaveBeenCalled();
  });

  it('reports errors and still settles the initial request', async () => {
    const onError = vi.fn();
    const onLoading = vi.fn();
    const loader = createDataLoader({
      resolve: () => ({ source: stubSource(async () => Promise.reject(new Error('offline'))), symbol: 'BTCUSDT', timeframe: '1h' }),
      onError,
      onLoading,
    });
    const { params, callback } = request('init');
    await loader.getBars(params);
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('offline'));
    expect(callback).toHaveBeenCalledWith([], false);
    expect(onLoading.mock.calls).toEqual([[true], [false]]);
  });

  it('streams live bars and stops on unsubscribe', () => {
    const unsubscribe = vi.fn();
    let push!: (c: Candle) => void;
    const source = stubSource(async () => []);
    source.subscribe = (_s, _tf, onCandle) => {
      push = onCandle;
      return unsubscribe;
    };
    const onLiveCandle = vi.fn();
    const loader = createDataLoader({ resolve: () => ({ source, symbol: 'BTCUSDT', timeframe: '1m' }), onLiveCandle });
    const callback = vi.fn();
    loader.subscribeBar!({ symbol: { ticker: 'BTCUSDT', pricePrecision: 2, volumePrecision: 2 }, period: { type: 'minute', span: 1 }, callback });
    push(candle(MIN));
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ timestamp: MIN, close: 1.5 }));
    expect(onLiveCandle).toHaveBeenCalledTimes(1);
    loader.unsubscribeBar!({ symbol: { ticker: 'BTCUSDT', pricePrecision: 2, volumePrecision: 2 }, period: { type: 'minute', span: 1 } });
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('asks a held source for nothing, then loads once it is let go', async () => {
    const fetchCandles = vi.fn(async () => [candle(MIN)]);
    const source = stubSource(fetchCandles);
    const subscribe = vi.fn(() => () => undefined);
    source.subscribe = subscribe;
    let held = true;
    const onHeld = vi.fn();
    const loader = createDataLoader({ resolve: () => ({ source, symbol: 'AAPL', timeframe: '1m' }), held: () => held, onHeld });

    const first = request('init');
    await loader.getBars(first.params);
    await loader.getBars(request('forward', MIN).params);
    loader.subscribeBar!({ symbol: { ticker: 'AAPL', pricePrecision: 2, volumePrecision: 2 }, period: { type: 'minute', span: 1 }, callback: vi.fn() });
    expect(fetchCandles).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(first.callback).toHaveBeenCalledWith([], false);
    expect(onHeld).toHaveBeenLastCalledWith(source);

    held = false;
    const second = request('init');
    await loader.getBars(second.params);
    loader.subscribeBar!({ symbol: { ticker: 'AAPL', pricePrecision: 2, volumePrecision: 2 }, period: { type: 'minute', span: 1 }, callback: vi.fn() });
    expect(fetchCandles).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(onHeld).toHaveBeenLastCalledWith(null);
  });
});
