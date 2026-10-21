import { describe, expect, it, vi } from 'vitest';
import { defaultConfig, loadConfig, saveConfig } from '../src/layout/config';
import { DEFAULT_INCLUDE, SOFT_LINK_LIMIT, pickShared } from '../src/share/codec';
import { applyRange, makeShareLink, readRange } from '../src/share';
import { TemporaryStorage, isChartKey, openSharedView } from '../src/share/view';
import { LayoutStore, MemoryStorage, type DrawingRecord, type Layout } from '../src/store/layout';
import { ALL, ALL_DRAWINGS, H, PAGE, T0, snapshot } from './shareFixtures';

// The chart engine touches `window` on import; these modules only need the catalogs.
vi.mock('klinecharts', () => ({ registerIndicator: vi.fn(), registerOverlay: vi.fn() }));

describe('share links', () => {
  it('stay short for a typical chart', async () => {
    const link = await makeShareLink(snapshot(), DEFAULT_INCLUDE, PAGE);
    expect(link.url.startsWith(`${PAGE}#s=z`)).toBe(true);
    expect(link.url.length).toBeLessThan(1500);
    expect(link.notes).toEqual([]);
  });

  it('warn when scripts make a link long', async () => {
    // Random constants, so the code does not compress away.
    let seed = 7;
    const rand = () => ((seed = (seed * 48271) % 2147483647) / 2147483647).toFixed(9);
    const big = Array.from({ length: 600 }, (_, i) => `v${i} = ta.sma(close, ${i + 2}) * ${rand()} + ${rand()}`).join('\n');
    const link = await makeShareLink(snapshot({ scripts: [{ id: 'a', source: `indicator("Big")\n${big}\nplot(v1)`, inputs: {} }] }), { ...DEFAULT_INCLUDE, scripts: true }, PAGE);
    expect(link.url.length).toBeGreaterThan(SOFT_LINK_LIMIT);
    expect(link.notes.join(' ')).toMatch(/Leave scripts out/);
  });

});

describe('share links: visible range', () => {
  const bars = Array.from({ length: 500 }, (_, i) => ({ timestamp: T0 + i * H, open: 1, high: 1, low: 1, close: 1 }));
  const fakeChart = (realTo: number) => ({
    getDataList: () => bars,
    getVisibleRange: () => ({ from: 0, to: Math.min(realTo, bars.length), realFrom: 0, realTo }),
    getBarSpace: () => ({ bar: 9, halfBar: 4.5, gapBar: 7 }),
  });

  it('reads the right edge bar, or none when the latest bar is showing', () => {
    expect(readRange(fakeChart(501) as never)).toEqual({ time: null, barSpace: 9 });
    expect(readRange(fakeChart(400) as never)).toEqual({ time: bars[398].timestamp, barSpace: 9 });
    expect(readRange({ ...fakeChart(0), getDataList: () => [] } as never)).toBeNull();
  });

  it('scrolls to the shared bar, loading older bars first when needed', async () => {
    let data = bars.slice(300);
    const calls: string[] = [];
    const chart = {
      getDataList: () => data,
      setBarSpace: (n: number) => calls.push(`space ${n}`),
      scrollToRealTime: () => calls.push('live'),
      scrollToDataIndex: (i: number) => {
        calls.push(`index ${i}`);
        // The engine asks the loader for older bars when the first one shows.
        setTimeout(() => (data = bars.slice(Math.max(0, bars.length - data.length - 100))), 10);
      },
      scrollToTimestamp: (t: number) => calls.push(`time ${t}`),
    };
    await applyRange(chart as never, { time: bars[150].timestamp, barSpace: 9 }, 500);
    expect(calls).toEqual(['space 9', 'index 0', 'index 0', 'time ' + bars[150].timestamp]);
    await applyRange(chart as never, { time: null, barSpace: 4 });
    expect(calls.slice(-2)).toEqual(['space 4', 'live']);
  });
});

describe('temporary view', () => {
  const own: Layout = {
    version: 1,
    source: 'coinbase',
    symbol: 'BTC-USD',
    timeframe: '1h',
    theme: 'light',
    indicators: [{ name: 'BOLL', params: [20, 2], pane: 'main' }],
    scripts: [{ id: 'mine', source: 'indicator("Mine")\nplot(close)', inputs: {} }],
    chartType: 'line',
    scale: 'percent',
  };
  const myDrawing: DrawingRecord = { name: 'horizontalStraightLine', points: [{ timestamp: T0, value: 2000 }] };

  /** Browser storage with a saved chart, and a snapshot of it to compare against. */
  function savedStorage() {
    const storage = new MemoryStorage();
    const store = new LayoutStore(storage);
    store.saveLayout(own);
    store.saveDrawings('binance', 'ETHUSDT', [myDrawing]);
    store.saveDrawings('coinbase', 'BTC-USD', [myDrawing]);
    saveConfig(storage, { ...defaultConfig(), count: 2 });
    const dump = () => JSON.stringify([...(storage as unknown as { map: Map<string, string> }).map.entries()].sort());
    return { storage, dump };
  }

  it('captures chart keys only and passes the rest through', () => {
    const base = new MemoryStorage();
    base.setItem('kandle:layout', 'saved');
    const temp = new TemporaryStorage(base);
    expect(isChartKey('kandle:drawings:binance:BTCUSDT')).toBe(true);
    expect(isChartKey('kandle:watchlist')).toBe(false);
    expect(temp.getItem('kandle:layout')).toBe('saved');
    temp.setItem('kandle:layout', 'temp');
    temp.removeItem('kandle:drawings:binance:BTCUSDT');
    temp.setItem('kandle:symbols:binance', 'list');
    expect(temp.getItem('kandle:layout')).toBe('temp');
    expect(base.getItem('kandle:layout')).toBe('saved');
    expect(base.getItem('kandle:symbols:binance')).toBe('list');
    expect(temp.keys().sort()).toEqual(['kandle:drawings:binance:BTCUSDT', 'kandle:layout']);
    temp.discard();
    temp.setItem('kandle:layout', 'after back');
    expect(base.getItem('kandle:layout')).toBe('saved');
  });

  it('shows the shared chart over the saved one without changing it', async () => {
    const { storage, dump } = savedStorage();
    const before = dump();
    const { chart } = pickShared(snapshot(), ALL);
    const view = openSharedView(storage, chart);
    const store = new LayoutStore(view.storage);
    const layout = store.loadLayout();
    expect(layout).toMatchObject({ source: 'binance', symbol: 'ETHUSDT', timeframe: '4h', chartType: 'heikin_ashi', scale: 'log', theme: 'light', scripts: [] });
    expect(layout.indicators).toEqual([{ name: 'EMA', params: [20, 50, 200], pane: 'main' }, { name: 'RSI', params: [14], pane: 'sub' }]);
    expect(store.loadDrawings('binance', 'ETHUSDT')).toEqual(ALL_DRAWINGS);
    expect(loadConfig(view.storage)).toMatchObject({ count: 4, sync: { crosshair: true, timeframe: true, symbol: false } });
    expect(view.pendingScripts()).toHaveLength(2);
    // Edits while the shared chart is open stay in memory.
    store.saveLayout({ ...layout, indicators: [] });
    store.saveDrawings('binance', 'ETHUSDT', []);
    store.saveDrawings('okx', 'SOL-USDT', [myDrawing]);
    expect(dump()).toBe(before);
    view.discard();
    expect(dump()).toBe(before);
  });

  it('takes what the link leaves out from the saved chart', () => {
    const { storage } = savedStorage();
    const none = { chart: false, indicators: false, drawings: false, scripts: false, layout: false };
    const view = openSharedView(storage, pickShared(snapshot(), none).chart);
    const store = new LayoutStore(view.storage);
    expect(store.loadLayout()).toMatchObject({ symbol: 'ETHUSDT', chartType: 'line', scale: 'percent', indicators: own.indicators, scripts: own.scripts });
    expect(store.loadDrawings('binance', 'ETHUSDT')).toEqual([myDrawing]);
    expect(loadConfig(view.storage).count).toBe(2);
    expect(view.pendingScripts()).toEqual([]);
  });

  it('keeps the shared chart and the user\'s own drawings and scripts', () => {
    const { storage } = savedStorage();
    const view = openSharedView(storage, pickShared(snapshot(), ALL).chart);
    // The user ran one shared script (the manager saves it), then chose Keep.
    const store = new LayoutStore(view.storage);
    const shared = { id: 'x1', source: snapshot().scripts[0].source, inputs: { Length: 34 } };
    store.saveLayout({ ...store.loadLayout(), scripts: [shared] });
    view.markScriptsHandled();
    const result = view.keep();
    expect(result).toEqual({ saved: true, reload: true, skippedScripts: 0 });
    const saved = new LayoutStore(storage);
    expect(saved.loadLayout()).toMatchObject({ source: 'binance', symbol: 'ETHUSDT', timeframe: '4h', chartType: 'heikin_ashi', theme: 'light' });
    expect(saved.loadLayout().scripts).toEqual([own.scripts![0], shared]);
    expect(saved.loadDrawings('binance', 'ETHUSDT')).toEqual([myDrawing, ...ALL_DRAWINGS]);
    expect(saved.loadDrawings('coinbase', 'BTC-USD')).toEqual([myDrawing]);
    expect(loadConfig(storage).count).toBe(4);
    // Kept: later changes are saved as usual.
    expect(view.storage.temporary).toBe(false);
    new LayoutStore(view.storage).saveDrawings('binance', 'ETHUSDT', []);
    expect(saved.loadDrawings('binance', 'ETHUSDT')).toEqual([]);
  });

  it('does not save shared scripts that never ran', () => {
    const { storage } = savedStorage();
    const view = openSharedView(storage, pickShared(snapshot(), { ...DEFAULT_INCLUDE, scripts: true }).chart);
    expect(view.keep().skippedScripts).toBe(2);
    expect(new LayoutStore(storage).loadLayout().scripts).toEqual(own.scripts);
  });

  it('needs no reload when nothing of the user\'s was hidden', () => {
    const storage = new MemoryStorage();
    const view = openSharedView(storage, pickShared(snapshot(), DEFAULT_INCLUDE).chart);
    expect(view.keep()).toEqual({ saved: true, reload: false, skippedScripts: 0 });
    expect(new LayoutStore(storage).loadDrawings('binance', 'ETHUSDT')).toEqual(ALL_DRAWINGS);
  });
});
