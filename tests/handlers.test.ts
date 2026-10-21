import { describe, expect, it, vi } from 'vitest';
import type { KLineData } from 'klinecharts';
import { createHandlers, dispatch, type ChartLike, type HostEnv, type PaneLike } from '../src/agent/handlers';
import { resolveSymbol } from '../src/agent/symbols';
import { AlertEngine } from '../src/alerts/engine';
import type { ChartStyle } from '../src/chart/chartStyle';
import type { TimeframeId } from '../src/data/timeframes';
import type { SymbolMeta } from '../src/data/types';
import { DEFAULT_INCLUDE } from '../src/share/codec';
import { MemoryStorage } from '../src/store/layout';
import { WatchlistController } from '../src/watchlist/controller';

// The chart engine touches `window` on import; the handlers only need the indicator catalog.
vi.mock('klinecharts', () => ({ registerIndicator: vi.fn() }));

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 1);
const bars: KLineData[] = Array.from({ length: 50 }, (_, i) => ({ timestamp: T0 + i * H, open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume: 5 }));

const SYMBOLS: SymbolMeta[] = [
  { symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT', pricePrecision: 2, volumePrecision: 5 },
  { symbol: 'ETHUSDT', base: 'ETH', quote: 'USDT', pricePrecision: 2, volumePrecision: 4 },
  { symbol: 'ETHBTC', base: 'ETH', quote: 'BTC', pricePrecision: 6, volumePrecision: 4 },
];

interface Overlay {
  id: string;
  name: string;
  points: Array<{ timestamp: number; value: number }>;
  extendData?: { text?: string };
  currentStep: number;
}

/** A tiny stand-in for the chart engine with one RSI indicator and an overlay list. */
function mockPane(index = 1) {
  const overlays: Overlay[] = [];
  const indicators = [{ id: 'RSI_1', name: 'RSI', pane: 'sub' as const, params: [14] }];
  let info: { source: string; symbol: string; timeframe: TimeframeId } = { source: 'binance', symbol: 'BTCUSDT', timeframe: '1h' };
  let loaded: (() => void) | null = null;
  let style: ChartStyle = { type: 'candles', scale: 'normal' };
  const chart = {
    getDataList: () => bars,
    getSymbol: () => ({ ticker: info.symbol, pricePrecision: 2, volumePrecision: 4 }),
    getPeriod: () => ({ type: 'hour', span: 1 }),
    getVisibleRange: () => ({ from: 10, to: 50, realFrom: 10, realTo: 50 }),
    getSize: () => ({ width: 800, height: 500, left: 0, top: 0, right: 0, bottom: 0 }),
    getConvertPictureUrl: () => 'data:image/png;base64,AAAA',
    getIndicators: ({ id }: { id?: string } = {}) =>
      indicators
        .filter((i) => !id || i.id === id)
        .map((i) => ({ ...i, figures: [{ key: 'rsi1' }], result: bars.map((_, n) => ({ rsi1: 40 + n * 0.5 })) })),
    getOverlays: ({ id, groupId }: { id?: string; groupId?: string } = {}) => overlays.filter((o) => (!id || o.id === id) && (!groupId || groupId === 'drawings')),
  } as unknown as ChartLike;
  const pane: PaneLike = {
    index,
    chart: () => chart,
    info: () => info,
    setSymbol: vi.fn((source: string, meta: SymbolMeta) => {
      info = { ...info, source, symbol: meta.symbol };
      setTimeout(() => loaded?.(), 0);
    }),
    setTimeframe: vi.fn((tf: TimeframeId) => {
      info = { ...info, timeframe: tf };
      setTimeout(() => loaded?.(), 0);
    }),
    addIndicator: vi.fn((name: string, params?: number[]) => {
      const id = `${name}_${indicators.length + 1}`;
      indicators.push({ id, name, pane: 'sub', params: params ?? [] });
      return id;
    }),
    removeIndicator: vi.fn((id: string) => {
      const i = indicators.findIndex((x) => x.id === id);
      if (i >= 0) indicators.splice(i, 1);
    }),
    indicators: () => indicators.map((i) => ({ ...i })),
    chartStyle: () => style,
    setChartStyle: vi.fn((change: Partial<ChartStyle>) => (style = { ...style, ...change })),
    loader: () => ({
      nextLoad: () =>
        new Promise<number>((resolve) => {
          loaded = () => resolve(bars.length);
        }),
    }),
  };
  return { pane, overlays, indicators };
}

function setup(overrides: Partial<HostEnv> = {}) {
  const main = mockPane();
  let n = 0;
  const env: HostEnv = {
    pane: (i) => (i === 1 ? main.pane : null),
    sources: () => ['binance', 'coinbase'],
    symbols: async () => SYMBOLS,
    fetchCandles: vi.fn(async (_s, _sym, _tf, { before }) =>
      Array.from({ length: 10 }, (_, i) => ({ time: (before ?? T0) - (10 - i) * H, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 })),
    ),
    draw: vi.fn((name, points, text) => {
      const id = `ov${++n}`;
      main.overlays.push({ id, name, points, currentStep: -1, ...(text ? { extendData: { text } } : {}) });
      return id;
    }),
    removeDrawing: (id) => {
      const i = main.overlays.findIndex((o) => o.id === id);
      if (i < 0) return false;
      main.overlays.splice(i, 1);
      return true;
    },
    clearDrawings: () => main.overlays.splice(0).length,
    scriptRunner: () => undefined,
    background: () => '#000',
    alerts: new AlertEngine(new MemoryStorage()),
    requestNotifications: vi.fn(),
    replay: {
      active: false,
      state: () => ({ active: false, picking: false, playing: false, speed: 1 }),
      start: vi.fn(async () => ({ active: true, picking: false, playing: false, speed: 1 })),
      step: vi.fn((count: number) => bars.slice(0, count)),
      stop: vi.fn(),
    },
    layout: null,
    settle: async () => undefined,
    ...overrides,
  };
  return { env, main, handlers: createHandlers(env) };
}

const call = async (handlers: ReturnType<typeof createHandlers>, method: Parameters<typeof dispatch>[1], params: Record<string, unknown> = {}) => {
  const out = await dispatch(handlers, method, params);
  if (!out.ok) throw new Error(out.error);
  return out.result as Record<string, any>;
};

describe('resolveSymbol', () => {
  it('accepts common spellings', () => {
    expect(resolveSymbol(SYMBOLS, 'BTCUSDT').symbol).toBe('BTCUSDT');
    expect(resolveSymbol(SYMBOLS, 'eth/usdt').symbol).toBe('ETHUSDT');
    expect(resolveSymbol(SYMBOLS, 'ETH-BTC').symbol).toBe('ETHBTC');
  });

  it('suggests close matches', () => {
    expect(() => resolveSymbol(SYMBOLS, 'ETH')).toThrow(/Close matches: ETHUSDT/);
    expect(() => resolveSymbol(SYMBOLS, 'ZZZ')).toThrow('Unknown symbol ZZZ.');
  });
});

describe('bridge handlers', () => {
  it('reports chart state with indicators, drawings and alerts', async () => {
    const { handlers } = setup();
    const state = await call(handlers, 'get_chart_state');
    expect(state).toMatchObject({ pane: 1, exchange: 'binance', symbol: 'BTCUSDT', timeframe: '1h', last_price: 150, bars_loaded: 50 });
    expect(state.indicators[0]).toMatchObject({ id: 'RSI_1', name: 'RSI', lines: ['rsi1'], values: { rsi1: 64.5 } });
    expect(state.drawings).toEqual([]);
    expect(state.visible_range.from).toBe(new Date(T0 + 10 * H).toISOString());
  });

  it('switches symbol, waits for data, and reports unknown ones', async () => {
    const { handlers, main } = setup();
    const state = await call(handlers, 'set_symbol', { symbol: 'eth/usdt' });
    expect(main.pane.setSymbol).toHaveBeenCalledWith('binance', SYMBOLS[1]);
    expect(state.symbol).toBe('ETHUSDT');
    await expect(call(handlers, 'set_symbol', { symbol: 'NOPE' })).rejects.toThrow(/Unknown symbol/);
    await expect(call(handlers, 'set_symbol', { symbol: 'BTCUSDT', exchange: 'kraken' })).rejects.toThrow(/Unknown exchange/);
  });

  it('falls back to provider search for sources that only list popular symbols', async () => {
    const ibm = { symbol: 'IBM', base: 'IBM', quote: 'USD', pricePrecision: 2, volumePrecision: 0, market: 'stock' as const };
    const searchSymbols = vi.fn(async () => [ibm]);
    const { handlers, main } = setup({ sources: () => ['binance', 'twelvedata'], searchSymbols });
    await call(handlers, 'set_symbol', { symbol: 'IBM', exchange: 'twelvedata' });
    expect(searchSymbols).toHaveBeenCalledWith('twelvedata', 'IBM');
    expect(main.pane.setSymbol).toHaveBeenCalledWith('twelvedata', ibm);
  });

  it('opens imported CSV datasets and keeps them to their timeframes', async () => {
    const data = { symbol: 'MY-BTC', base: 'My BTC', quote: '', name: 'My BTC', pricePrecision: 2, volumePrecision: 0 };
    const symbols = vi.fn(async (source: string) => (source === 'csv' ? [data] : SYMBOLS));
    const { handlers, main } = setup({ sources: () => ['binance', 'csv'], symbols });
    await call(handlers, 'set_symbol', { symbol: 'my-btc', exchange: 'csv' });
    expect(main.pane.setSymbol).toHaveBeenCalledWith('csv', data);
    main.pane.timeframes = () => ['1D', '1W'];
    await expect(call(handlers, 'set_timeframe', { timeframe: '1h' })).rejects.toThrow('MY-BTC on csv can be shown in 1D, 1W only');
    await call(handlers, 'set_timeframe', { timeframe: '1W' });
    expect(main.pane.setTimeframe).toHaveBeenCalledWith('1W');
  });

  it('does not wait when nothing changes', async () => {
    const { handlers, main } = setup();
    await call(handlers, 'set_timeframe', { timeframe: '1h' });
    expect(main.pane.setTimeframe).not.toHaveBeenCalled();
    await call(handlers, 'set_timeframe', { timeframe: '4h' });
    expect(main.pane.setTimeframe).toHaveBeenCalledWith('4h');
    await expect(call(handlers, 'set_timeframe', { timeframe: '2h' })).rejects.toThrow(/Unknown timeframe/);
  });

  it('returns candles with optional indicator columns', async () => {
    const { handlers } = setup();
    const res = await call(handlers, 'get_candles', { limit: 3, include_indicators: true });
    expect(res.count).toBe(3);
    expect(res.rows[2]).toEqual([new Date(T0 + 49 * H).toISOString(), 149, 151, 148, 150, 5]);
    expect(res.indicators[0].lines.rsi1).toEqual([63.5, 64, 64.5]);
  });

  it('filters by time range', async () => {
    const { handlers } = setup();
    const res = await call(handlers, 'get_candles', { from: T0 + 5 * H, to: T0 + 7 * H });
    expect(res.rows.map((r: unknown[]) => r[0])).toEqual([5, 6, 7].map((i) => new Date(T0 + i * H).toISOString()));
  });

  it('fetches older history the chart does not have', async () => {
    const { handlers, env } = setup();
    const res = await call(handlers, 'get_candles', { from: T0 - 5 * H, limit: 1000, include_indicators: true });
    expect(env.fetchCandles).toHaveBeenCalledWith('binance', 'BTCUSDT', '1h', { before: T0, limit: 1000 });
    expect(res.count).toBe(55);
    expect(res.indicators[0].lines.rsi1[0]).toBeNull();
    expect(res.indicators[0].lines.rsi1[5]).toBe(40);
  });

  it('adds, lists and removes indicators', async () => {
    const { handlers, main } = setup();
    const added = await call(handlers, 'add_indicator', { name: 'macd' });
    expect(added.name).toBe('MACD');
    expect(main.pane.addIndicator).toHaveBeenCalledWith('MACD', undefined);
    await expect(call(handlers, 'add_indicator', { name: 'MAGIC' })).rejects.toThrow(/Unknown indicator MAGIC/);
    await expect(call(handlers, 'add_indicator', { name: 'RSI', params: ['x'] })).rejects.toThrow(/list of numbers/);
    const list = await call(handlers, 'list_indicators');
    expect(list.on_chart.map((i: { name: string }) => i.name)).toEqual(['RSI', 'MACD']);
    expect(list.available.length).toBeGreaterThan(30);
    expect(await call(handlers, 'remove_indicator', { name: 'rsi' })).toEqual({ removed: [{ id: 'RSI_1', name: 'RSI' }] });
    await expect(call(handlers, 'remove_indicator', { id: 'nope' })).rejects.toThrow(/No indicator/);
  });

  it('draws by price and time, snapping to bars', async () => {
    const { handlers, env } = setup();
    const line = await call(handlers, 'draw', { type: 'horizontal_line', points: [{ price: 120 }] });
    expect(env.draw).toHaveBeenLastCalledWith('horizontalStraightLine', [{ timestamp: T0 + 49 * H, value: 120 }], undefined);
    const trend = await call(handlers, 'draw', { type: 'trend_line', points: [{ time: T0 + 2 * H + 1234, price: 101 }, { time: T0 + 20 * H, price: 130 }] });
    expect(trend.points[0].time).toBe(new Date(T0 + 2 * H).toISOString());
    await call(handlers, 'draw', { type: 'text', points: [{ time: T0, price: 100 }], text: 'Support' });
    expect(env.draw).toHaveBeenLastCalledWith('textNote', [{ timestamp: T0, value: 100 }], 'Support');
    const state = await call(handlers, 'get_chart_state');
    expect(state.drawings.map((d: { type: string }) => d.type)).toEqual(['horizontal_line', 'trend_line', 'text']);
    expect(state.drawings[2].text).toBe('Support');
    await expect(call(handlers, 'draw', { type: 'trend_line', points: [{ price: 1 }, { price: 2 }] })).rejects.toThrow(/needs a time/);
    await expect(call(handlers, 'draw', { type: 'spiral', points: [{ price: 1 }] })).rejects.toThrow(/Unknown drawing type/);
    await expect(call(handlers, 'draw', { type: 'text', points: [{ time: T0, price: 1 }] })).rejects.toThrow(/need text/);
    expect(line.id).toBe('ov1');
  });

  it('removes and clears drawings', async () => {
    const { handlers } = setup();
    const a = await call(handlers, 'draw', { type: 'horizontal_line', points: [{ price: 1 }] });
    await call(handlers, 'draw', { type: 'horizontal_line', points: [{ price: 2 }] });
    expect(await call(handlers, 'remove_drawing', { id: a.id })).toEqual({ removed: a.id });
    await expect(call(handlers, 'remove_drawing', { id: a.id })).rejects.toThrow(/No drawing/);
    expect(await call(handlers, 'clear_drawings')).toEqual({ removed: 1 });
  });

  it('creates price, drawing and indicator alerts with seeds', async () => {
    const { handlers, env } = setup();
    const price = await call(handlers, 'set_alert', { type: 'price', level: 155, condition: 'crosses_up' });
    expect(price).toMatchObject({ type: 'price', level: 155, status: 'active', frequency: 'once', symbol: 'BTCUSDT' });
    expect(env.requestNotifications).toHaveBeenCalled();
    // Seeded with the last close (150), so the first tick above 155 fires.
    expect(env.alerts.onTick('binance', 'BTCUSDT', { time: T0 + 49 * H, price: 156, high: 156, low: 150 })).toHaveLength(1);

    const line = await call(handlers, 'draw', { type: 'trend_line', points: [{ time: T0, price: 100 }, { time: T0 + 49 * H, price: 149 }] });
    const onLine = await call(handlers, 'set_alert', { type: 'drawing', drawing_id: line.id, frequency: 'every_time' });
    expect(onLine).toMatchObject({ type: 'drawing', drawing_id: line.id, frequency: 'every_time' });
    const note = await call(handlers, 'draw', { type: 'rectangle', points: [{ time: T0, price: 1 }, { time: T0 + H, price: 2 }] });
    await expect(call(handlers, 'set_alert', { type: 'drawing', drawing_id: note.id })).rejects.toThrow(/Alerts work on/);

    const rsi = await call(handlers, 'set_alert', { type: 'indicator', indicator_id: 'RSI_1', level: 70 });
    expect(rsi.indicator).toEqual({ name: 'RSI', line: 'rsi1', params: [14] });
    await expect(call(handlers, 'set_alert', { type: 'indicator', indicator_id: 'RSI_1', indicator_line: 'nope', level: 1 })).rejects.toThrow(/has lines rsi1/);

    const all = await call(handlers, 'list_alerts');
    expect(all.alerts).toHaveLength(3);
    expect(await call(handlers, 'remove_alert', { id: rsi.id })).toEqual({ removed: 1 });
    expect(await call(handlers, 'remove_alert', { id: 'all' })).toEqual({ removed: 2 });
  });

  it('reports a missing script engine, and runs one when present', async () => {
    const { handlers } = setup();
    expect(await dispatch(handlers, 'run_script', { code: 'x' })).toEqual({ ok: true, result: expect.stringMatching(/^not available yet/) });
    const runner = vi.fn(async () => ({ plots: 1 }));
    const withEngine = setup({ scriptRunner: () => runner }).handlers;
    expect(await call(withEngine, 'run_script', { code: 'plot(close)', name: 'test' })).toEqual({ plots: 1 });
    expect(runner).toHaveBeenCalledWith('plot(close)', 'test');
    await call(withEngine, 'run_script', { code: 'plot(close)', id: 's1', inputs: { Symbol: 'SOLUSDT', 'Higher timeframe': '240' } });
    expect(runner).toHaveBeenLastCalledWith('plot(close)', { id: 's1', inputs: { Symbol: 'SOLUSDT', 'Higher timeframe': '240' } });
    await call(withEngine, 'run_script', { code: 'strategy("s")', id: 's2', strategy: { initial_capital: 5000, slippage: null } });
    expect(runner).toHaveBeenLastCalledWith('strategy("s")', { id: 's2', strategy: { initial_capital: 5000, slippage: null } });
    await expect(call(withEngine, 'run_script', { code: 'strategy("s")', strategy: [1] })).rejects.toThrow(/strategy must be an object/);
  });

  it('reads backtest results of a strategy script', async () => {
    const { handlers } = setup();
    expect(await dispatch(handlers, 'get_backtest', {})).toEqual({ ok: true, result: expect.stringMatching(/^not available yet/) });
    const reader = vi.fn(async (id?: string) => (id === 'nope' ? null : { id: 's1', summary: { netProfit: 12.5 }, trades: [] }));
    const withReader = setup({ backtestReader: () => reader }).handlers;
    expect(await call(withReader, 'get_backtest', { trades: 5 })).toEqual({ id: 's1', summary: { netProfit: 12.5 }, trades: [] });
    expect(reader).toHaveBeenCalledWith(undefined, 5);
    await call(withReader, 'get_backtest', { id: 's1' });
    expect(reader).toHaveBeenLastCalledWith('s1', 50);
    await expect(call(withReader, 'get_backtest', { id: 'nope' })).rejects.toThrow(/No strategy script with id nope/);
    const none = setup({ backtestReader: () => async () => null }).handlers;
    await expect(call(none, 'get_backtest', {})).rejects.toThrow(/must call strategy\(\)/);
  });

  it('screenshots a pane and notes a hidden tab', async () => {
    const { handlers } = setup({ paint: async () => false });
    const shot = await call(handlers, 'screenshot');
    expect(shot).toMatchObject({ dataUrl: 'data:image/png;base64,AAAA', width: 800, height: 500, label: 'BTCUSDT 1h on binance' });
    expect(shot.note).toMatch(/background/);
  });

  it('drives replay', async () => {
    const { handlers, env } = setup();
    await call(handlers, 'start_replay', { bars_back: 20, speed: 3 });
    expect(env.replay.start).toHaveBeenCalledWith({ startTime: undefined, barsBack: 20, speed: 3, autoplay: undefined });
    const stepped = await call(handlers, 'step_replay', { bars: 2 });
    expect(stepped.revealed.rows).toHaveLength(2);
    await call(handlers, 'stop_replay');
    expect(env.replay.stop).toHaveBeenCalled();
  });

  it('applies layouts and per-pane settings', async () => {
    const second = mockPane(2);
    const layout = {
      count: 1,
      state: () => ({ charts: layout.count as 1 | 2 | 4, sync: { crosshair: true, timeframe: false, symbol: false }, panes: [] }),
      setCount: vi.fn(async (n: 1 | 2 | 4) => {
        layout.count = n;
      }),
      setSync: vi.fn(),
    };
    const main = mockPane(1);
    const { handlers } = setup({ layout, pane: (i) => (i === 1 ? main.pane : i === 2 && layout.count > 1 ? second.pane : null) });
    await expect(call(handlers, 'get_chart_state', { pane: 2 })).rejects.toThrow(/Chart 2 is not showing/);
    const res = await call(handlers, 'set_layout', { charts: 2, sync: { timeframe: true, junk: 1 }, panes: [{}, { symbol: 'ETHUSDT', timeframe: '4h' }] });
    expect(res.charts).toBe(2);
    expect(layout.setSync).toHaveBeenCalledWith({ timeframe: true });
    expect(second.pane.info()).toEqual({ source: 'binance', symbol: 'ETHUSDT', timeframe: '4h' });
    expect((await call(handlers, 'get_chart_state', { pane: 2 })).drawings).toBeUndefined();
    await expect(call(handlers, 'set_layout', { charts: 3 })).rejects.toThrow(/1, 2 or 4/);
  });

  it('sets the chart type and scale per pane and keeps the data real', async () => {
    const second = mockPane(2);
    const { handlers, main } = setup({ pane: (i) => (i === 1 ? main.pane : i === 2 ? second.pane : null) });
    expect(await call(handlers, 'get_chart_state')).toMatchObject({ chart_type: 'candles', price_scale: 'normal' });

    const res = await call(handlers, 'set_chart_style', { type: 'heikin_ashi' });
    expect(res).toMatchObject({ pane: 1, chart_type: 'heikin_ashi', price_scale: 'normal' });
    expect(res.note).toMatch(/real OHLC/);
    expect(main.pane.setChartStyle).toHaveBeenCalledWith({ type: 'heikin_ashi' });
    // get_candles still returns the bars the chart holds, not averaged ones.
    const candles = await call(handlers, 'get_candles', { limit: 2 });
    expect(candles.rows[1]).toEqual([new Date(bars[49].timestamp).toISOString(), 149, 151, 148, 150, 5]);
    expect(candles.note).toMatch(/Heikin Ashi/);

    await call(handlers, 'set_chart_style', { scale: 'log', pane: 2 });
    expect(await call(handlers, 'get_chart_state', { pane: 2 })).toMatchObject({ chart_type: 'candles', price_scale: 'log' });
    expect(await call(handlers, 'get_chart_state')).toMatchObject({ chart_type: 'heikin_ashi', price_scale: 'normal' });
  });

  it('rejects unknown chart types and scales', async () => {
    const { handlers, main } = setup();
    await expect(call(handlers, 'set_chart_style', { type: 'renko' })).rejects.toThrow('Unknown chart type renko. Use one of candles, hollow_candles, bars, line, area, heikin_ashi.');
    await expect(call(handlers, 'set_chart_style', { scale: 'logarithmic' })).rejects.toThrow(/Unknown scale logarithmic/);
    await expect(call(handlers, 'set_chart_style', {})).rejects.toThrow(/chart type, a scale or both/);
    await expect(call(handlers, 'set_chart_style', { type: 'line', pane: 3 })).rejects.toThrow(/Chart 3 is not showing/);
    expect(main.pane.setChartStyle).not.toHaveBeenCalled();
  });

  it('turns unknown methods and thrown errors into messages', async () => {
    const { handlers } = setup();
    expect(await dispatch(handlers, 'nope' as never, {})).toEqual({ ok: false, error: 'Unknown method nope' });
    expect(await dispatch(handlers, 'set_symbol', {})).toEqual({ ok: false, error: 'symbol is required' });
    expect(await dispatch(handlers, 'get_candles', { limit: 'ten' })).toEqual({ ok: false, error: 'limit must be a number' });
  });
});

describe('watchlist handlers', () => {
  /** A real controller with no feeds; refresh() is replaced so tests do not wait on timers. */
  function withWatchlist(items?: Array<{ source: string; symbol: string }>) {
    const storage = new MemoryStorage();
    if (items) storage.setItem('kandle:watchlist', JSON.stringify({ open: false, items }));
    const watchlist = new WatchlistController({
      storage,
      source: (id) => (['binance', 'coinbase'].includes(id) ? ({ id, name: id } as never) : undefined),
      hasKey: () => true,
      feeds: {},
    });
    const refresh = vi.spyOn(watchlist, 'refresh').mockResolvedValue();
    return { ...setup({ watchlist }), watchlist, refresh };
  }

  it('lists rows with price, change and the basis of the change', async () => {
    const { handlers, refresh } = withWatchlist();
    const res = await call(handlers, 'get_watchlist');
    expect(refresh).toHaveBeenCalled();
    expect(res.panel_open).toBe(false);
    expect(res.count).toBe(3);
    expect(res.items.map((i: { symbol: string }) => i.symbol)).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
    expect(res.items[0]).toMatchObject({ exchange: 'binance', price: null, change_percent: null, basis: 'prev_close' });
    expect(Object.keys(res.basis)).toEqual(['prev_close']);
  });

  it('adds a symbol on the main chart\'s exchange by default and resolves its name', async () => {
    const { handlers, watchlist } = withWatchlist([]);
    const res = await call(handlers, 'add_to_watchlist', { symbol: 'eth/usdt' });
    expect(res).toMatchObject({ added: true, exchange: 'binance', symbol: 'ETHUSDT', count: 1 });
    expect(watchlist.items()).toEqual([{ source: 'binance', symbol: 'ETHUSDT' }]);
    const again = await call(handlers, 'add_to_watchlist', { symbol: 'ETHUSDT', exchange: 'binance' });
    expect(again).toMatchObject({ added: false, note: 'ETHUSDT on binance was already in the watchlist', count: 1 });
  });

  it('validates add requests', async () => {
    const { handlers } = withWatchlist();
    expect(await dispatch(handlers, 'add_to_watchlist', {})).toEqual({ ok: false, error: 'symbol is required' });
    expect(await dispatch(handlers, 'add_to_watchlist', { symbol: 5 })).toEqual({ ok: false, error: 'symbol must be a string' });
    const bad = await dispatch(handlers, 'add_to_watchlist', { symbol: 'BTCUSDT', exchange: 'ftx' });
    expect(bad.ok).toBe(false);
    expect((bad as { error: string }).error).toMatch(/Unknown exchange ftx/);
    expect((await dispatch(handlers, 'add_to_watchlist', { symbol: 'NOPE' })).ok).toBe(false);
  });

  it('refuses to add past the limit', async () => {
    const { handlers } = withWatchlist(Array.from({ length: 50 }, (_, i) => ({ source: 'binance', symbol: `C${i}USDT` })));
    const res = await dispatch(handlers, 'add_to_watchlist', { symbol: 'BTCUSDT' });
    expect(res).toEqual({ ok: false, error: 'The watchlist holds up to 50 symbols. Remove one first.' });
  });

  it('removes by symbol, asks for the exchange when it is ambiguous, and clears with "all"', async () => {
    const { handlers, watchlist } = withWatchlist([
      { source: 'binance', symbol: 'BTCUSDT' },
      { source: 'coinbase', symbol: 'BTC-USD' },
      { source: 'binance', symbol: 'ETHUSDT' },
      { source: 'coinbase', symbol: 'ETHUSDT' },
    ]);
    expect(await call(handlers, 'remove_from_watchlist', { symbol: 'btc-usd' })).toMatchObject({ removed: [{ exchange: 'coinbase', symbol: 'BTC-USD' }], count: 3 });
    const ambiguous = await dispatch(handlers, 'remove_from_watchlist', { symbol: 'ETHUSDT' });
    expect(ambiguous).toEqual({ ok: false, error: 'ETHUSDT is listed on binance and coinbase. Give exchange to pick one.' });
    expect(await call(handlers, 'remove_from_watchlist', { symbol: 'ETHUSDT', exchange: 'coinbase' })).toMatchObject({ count: 2 });
    const missing = await dispatch(handlers, 'remove_from_watchlist', { symbol: 'SOLUSDT' });
    expect(missing).toEqual({ ok: false, error: 'SOLUSDT is not in the watchlist. It has BTCUSDT (binance), ETHUSDT (binance).' });
    expect((await call(handlers, 'remove_from_watchlist', { symbol: 'all' })).removed).toHaveLength(2);
    expect(watchlist.items()).toEqual([]);
  });

  it('says so when this build has no watchlist', async () => {
    const { handlers } = setup();
    expect(await dispatch(handlers, 'get_watchlist', {})).toEqual({ ok: false, error: 'The watchlist is not available' });
  });
});

describe('get_share_link', () => {
  const PAGE = 'https://kernel-hunter.github.io/kandle/';
  const env = (share?: HostEnv['share']) => ({ pane: () => null, sources: () => [], share }) as unknown as HostEnv;

  it('returns the link with what it carries', async () => {
    const share = vi.fn(async (include) => ({ url: `${PAGE}#s=zABC`, include, notes: [] }));
    const handlers = createHandlers(env(share));
    const res = await dispatch(handlers, 'get_share_link', { include: { scripts: true, drawings: false } });
    expect(share).toHaveBeenCalledWith({ ...DEFAULT_INCLUDE, scripts: true, drawings: false });
    expect(res).toEqual({ ok: true, result: { url: `${PAGE}#s=zABC`, characters: PAGE.length + 7, included: ['exchange', 'symbol', 'timeframe', 'chart', 'indicators', 'scripts'] } });
  });

  it('explains bad options and missing support', async () => {
    const share = vi.fn();
    expect(await dispatch(createHandlers(env(share)), 'get_share_link', { include: { everything: true } })).toMatchObject({ ok: false, error: expect.stringMatching(/Unknown include option/) });
    expect(share).not.toHaveBeenCalled();
    expect(await dispatch(createHandlers(env()), 'get_share_link', {})).toMatchObject({ ok: false, error: expect.stringMatching(/not available/) });
  });

  it('returns the embed URL and iframe with embed: true', async () => {
    const share = vi.fn();
    const embed = vi.fn(async (include) => ({ url: `${PAGE}?embed=1#s=zABC`, openUrl: `${PAGE}#s=zABC`, html: '<iframe></iframe>', include: { ...include, scripts: false }, notes: ['Scripts are never included in embeds, so they were left out.'] }));
    const handlers = createHandlers({ ...env(share), embed } as unknown as HostEnv);
    const res = await dispatch(handlers, 'get_share_link', { embed: true, include: { scripts: true } });
    expect(share).not.toHaveBeenCalled();
    expect(embed).toHaveBeenCalledWith({ ...DEFAULT_INCLUDE, scripts: true });
    expect(res).toEqual({
      ok: true,
      result: { url: `${PAGE}#s=zABC`, embed_url: `${PAGE}?embed=1#s=zABC`, iframe: '<iframe></iframe>', included: ['exchange', 'symbol', 'timeframe', 'chart', 'indicators', 'drawings'], notes: ['Scripts are never included in embeds, so they were left out.'] },
    });
    expect(await dispatch(handlers, 'get_share_link', { embed: 'yes' })).toMatchObject({ ok: false, error: 'embed must be true or false' });
    expect(await dispatch(createHandlers(env(share)), 'get_share_link', { embed: true })).toMatchObject({ ok: false, error: expect.stringMatching(/Embeds are not available/) });
  });
});
