import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, LayoutStore, MemoryStorage, sanitizeLayout, type KeyValueStorage, type Layout } from '../src/store/layout';
import { cachedSymbols, loadSymbols } from '../src/data/sources';
import type { DataSource, SymbolMeta } from '../src/data/types';

const sample: Layout = {
  version: 1,
  source: 'coinbase',
  symbol: 'ETH-USD',
  timeframe: '4h',
  theme: 'light',
  indicators: [
    { name: 'BOLL', params: [20, 2], pane: 'main' },
    { name: 'RSI', params: [21], pane: 'sub' },
    { name: 'RSI', params: [7], pane: 'sub' },
  ],
};

describe('LayoutStore', () => {
  it('returns the default layout on first run', () => {
    const store = new LayoutStore(new MemoryStorage(), 'test');
    expect(store.loadLayout()).toEqual(DEFAULT_LAYOUT);
  });

  it('round-trips symbol, timeframe, theme and indicators (duplicates included)', () => {
    const storage = new MemoryStorage();
    new LayoutStore(storage, 'test').saveLayout(sample);
    // A fresh store over the same storage simulates a page reload.
    expect(new LayoutStore(storage, 'test').loadLayout()).toEqual(sample);
  });

  it('never hands out the shared default object', () => {
    const store = new LayoutStore(new MemoryStorage(), 'test');
    const layout = store.loadLayout();
    layout.indicators.push({ name: 'MA', params: [5], pane: 'main' });
    expect(store.loadLayout().indicators).toHaveLength(DEFAULT_LAYOUT.indicators.length);
  });

  it('recovers from corrupt JSON', () => {
    const storage = new MemoryStorage();
    storage.setItem('test:layout', '{not json');
    expect(new LayoutStore(storage, 'test').loadLayout()).toEqual(DEFAULT_LAYOUT);
  });

  it('keeps drawings separate per source and symbol', () => {
    const store = new LayoutStore(new MemoryStorage(), 'test');
    store.saveDrawings('binance', 'BTCUSDT', [{ name: 'segment', points: [{ timestamp: 1, value: 10 }, { timestamp: 2, value: 20 }] }]);
    store.saveDrawings('binance', 'ETHUSDT', [{ name: 'textNote', points: [{ timestamp: 3, value: 30 }], text: 'hello' }]);
    expect(store.loadDrawings('binance', 'BTCUSDT')).toEqual([
      { name: 'segment', points: [{ timestamp: 1, value: 10 }, { timestamp: 2, value: 20 }] },
    ]);
    expect(store.loadDrawings('binance', 'ETHUSDT')[0].text).toBe('hello');
    expect(store.loadDrawings('coinbase', 'BTCUSDT')).toEqual([]);
  });

  it('removes the key when the last drawing is deleted', () => {
    const storage = new MemoryStorage();
    const store = new LayoutStore(storage, 'test');
    store.saveDrawings('binance', 'BTCUSDT', [{ name: 'rayLine', points: [{ timestamp: 1, value: 1 }] }]);
    store.saveDrawings('binance', 'BTCUSDT', []);
    expect(storage.getItem(store.drawingsKey('binance', 'BTCUSDT'))).toBeNull();
  });

  it('drops malformed drawing records but keeps valid ones', () => {
    const storage = new MemoryStorage();
    const store = new LayoutStore(storage, 'test');
    storage.setItem(
      store.drawingsKey('binance', 'BTCUSDT'),
      JSON.stringify([
        { name: 'segment', points: [{ timestamp: 1, value: 2 }, { timestamp: 'x', value: 3 }] },
        { name: 'segment', points: [] },
        { points: [{ timestamp: 1, value: 1 }] },
        'garbage',
      ]),
    );
    expect(store.loadDrawings('binance', 'BTCUSDT')).toEqual([{ name: 'segment', points: [{ timestamp: 1, value: 2 }] }]);
  });

  it('reports failure instead of throwing when storage is full or blocked', () => {
    const broken: KeyValueStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    const store = new LayoutStore(broken, 'test');
    expect(store.loadLayout()).toEqual(DEFAULT_LAYOUT);
    expect(store.saveLayout(sample)).toBe(false);
    expect(store.loadDrawings('binance', 'BTCUSDT')).toEqual([]);
  });
});

describe('sanitizeLayout', () => {
  it('fills missing or invalid fields from defaults', () => {
    const out = sanitizeLayout({ symbol: 'SOLUSDT', timeframe: '3m', theme: 'blue', indicators: [{ name: 'MA', params: [5, 'x', null, 10] }, { params: [1] }] });
    expect(out.symbol).toBe('SOLUSDT');
    expect(out.timeframe).toBe(DEFAULT_LAYOUT.timeframe);
    expect(out.theme).toBe(DEFAULT_LAYOUT.theme);
    expect(out.indicators).toEqual([{ name: 'MA', params: [5, 10], pane: 'sub' }]);
  });

  it('accepts non-objects', () => {
    expect(sanitizeLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(sanitizeLayout(42)).toEqual(DEFAULT_LAYOUT);
  });
});

describe('symbol list cache', () => {
  const symbols: SymbolMeta[] = [{ symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT', pricePrecision: 2, volumePrecision: 5 }];
  const makeSource = (id: string) => {
    let calls = 0;
    const source = {
      id,
      name: id,
      timeframes: [],
      listSymbols: async () => {
        calls += 1;
        return symbols;
      },
    } as unknown as DataSource;
    return { source, calls: () => calls };
  };

  it('stores the list and serves it from storage while fresh', async () => {
    const storage = new MemoryStorage();
    const { source, calls } = makeSource('cache-a');
    await loadSymbols(source, storage, 1_000);
    expect(calls()).toBe(1);
    expect(cachedSymbols(source, storage, 1_000 + 60_000)).toEqual(symbols);
    expect(cachedSymbols(source, storage, 1_000 + 2 * 24 * 3_600_000)).toBeNull();
  });
});
