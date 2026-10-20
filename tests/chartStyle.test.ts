import { describe, expect, it } from 'vitest';
import type { KLineData } from 'klinecharts';
import {
  CHART_TYPES,
  DEFAULT_CHART_STYLE,
  HeikinAshiSeries,
  PRICE_SCALES,
  heikinAshi,
  nextChartType,
  parseChartStyleChange,
} from '../src/chart/chartStyle';
import { loadConfig, sanitizeConfig, saveConfig, defaultConfig } from '../src/layout/config';
import { LayoutStore, MemoryStorage, sanitizeLayout } from '../src/store/layout';
import { CHART_TYPES as MCP_CHART_TYPES, PRICE_SCALES as MCP_PRICE_SCALES } from '../packages/mcp/src/tools';

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 1);
const bar = (i: number, open: number, high: number, low: number, close: number): KLineData => ({ timestamp: T0 + i * H, open, high, low, close, volume: 1 });

const BARS: KLineData[] = [bar(0, 10, 12, 9, 11), bar(1, 11, 13, 10, 12), bar(2, 12, 12.5, 8, 9), bar(3, 9, 10, 7, 9.5)];

describe('heikinAshi', () => {
  it('follows the definition, including the first bar', () => {
    const ha = heikinAshi(BARS);
    // First bar: open = (10 + 11) / 2, close = (10 + 12 + 9 + 11) / 4.
    expect(ha[0]).toEqual({ open: 10.5, high: 12, low: 9, close: 10.5 });
    // Then open = (prev open + prev close) / 2; high and low also cover the HA open and close.
    expect(ha[1]).toEqual({ open: 10.5, high: 13, low: 10, close: 11.5 });
    expect(ha[2]).toEqual({ open: 11, high: 12.5, low: 8, close: 10.375 });
    expect(ha[3]).toEqual({ open: 10.6875, high: 10.6875, low: 7, close: 8.875 });
  });

  it('is empty for no bars', () => {
    expect(heikinAshi([])).toEqual([]);
  });
});

describe('HeikinAshiSeries', () => {
  const series = (n: number, seed = 0): KLineData[] =>
    Array.from({ length: n }, (_, i) => {
      const open = 100 + seed + Math.sin(i) * 5;
      const close = open + Math.cos(i * 1.7) * 3;
      return bar(i, open, Math.max(open, close) + 1, Math.min(open, close) - 1, close);
    });

  it('matches a full computation as the last bar updates and new bars arrive', () => {
    const s = new HeikinAshiSeries();
    const data = series(50);
    expect(s.update(data)).toEqual(heikinAshi(data));
    const before = s.update(data).slice(0, 49);
    // A live tick changes the forming bar in place.
    data[49] = { ...data[49], close: data[49].close + 4, high: data[49].high + 4 };
    const updated = s.update(data);
    expect(updated).toEqual(heikinAshi(data));
    expect(updated.slice(0, 49)).toEqual(before);
    // A new bar opens.
    data.push(bar(50, 101, 103, 99, 102));
    expect(s.update(data)).toEqual(heikinAshi(data));
  });

  it('recomputes everything when older history is loaded in front', () => {
    const s = new HeikinAshiSeries();
    const all = series(80);
    const recent = all.slice(30);
    const first = s.update(recent);
    const merged = s.update(all);
    expect(merged).toEqual(heikinAshi(all));
    // The bar that used to be first now has a real previous bar, so its open moves.
    expect(merged[30].open).not.toBe(first[0].open);
    // The effect halves every bar, so recent values barely change.
    expect(Math.abs(merged[79].open - first[49].open)).toBeLessThan(1e-9);
  });

  it('recomputes everything for another symbol with the same bar times', () => {
    const s = new HeikinAshiSeries();
    s.update(series(40));
    const other = series(40, 1000);
    expect(s.update(other)).toEqual(heikinAshi(other));
  });

  it('copes with a shorter list and an empty one', () => {
    const s = new HeikinAshiSeries();
    s.update(series(40));
    const short = series(10);
    expect(s.update(short)).toEqual(heikinAshi(short));
    expect(s.update([])).toEqual([]);
    expect(s.update(BARS)).toEqual(heikinAshi(BARS));
  });

  it('does not depend on the engine keeping its bar objects unchanged', () => {
    const s = new HeikinAshiSeries();
    const data = series(20);
    s.update(data);
    // The engine only changes the last bar, but an in-place edit of the one before it is still caught.
    data[18].close += 10;
    expect(s.update(data)).toEqual(heikinAshi(data));
  });
});

describe('chart style values', () => {
  it('cycles through every type', () => {
    let type = DEFAULT_CHART_STYLE.type;
    const seen: string[] = [];
    for (let i = 0; i < CHART_TYPES.length; i++) {
      seen.push(type);
      type = nextChartType(type);
    }
    expect(seen).toEqual([...CHART_TYPES]);
    expect(type).toBe('candles');
  });

  it('parses requested changes and explains bad ones', () => {
    expect(parseChartStyleChange({ type: 'bars' })).toEqual({ type: 'bars' });
    expect(parseChartStyleChange({ scale: 'percent', type: null })).toEqual({ scale: 'percent' });
    expect(parseChartStyleChange({ type: 'area', scale: 'log' })).toEqual({ type: 'area', scale: 'log' });
    expect(() => parseChartStyleChange({ type: 'Candles' })).toThrow('Unknown chart type Candles. Use one of candles, hollow_candles, bars, line, area, heikin_ashi.');
    expect(() => parseChartStyleChange({ scale: 2 })).toThrow('Unknown scale 2. Use one of normal, log, percent.');
    expect(() => parseChartStyleChange({})).toThrow('Give a chart type, a scale or both');
  });

  it('match the values the MCP server accepts', () => {
    expect(MCP_CHART_TYPES).toEqual(CHART_TYPES);
    expect(MCP_PRICE_SCALES).toEqual(PRICE_SCALES);
  });
});

describe('chart style persistence', () => {
  it('is saved with the main chart layout and left out when never set', () => {
    const storage = new MemoryStorage();
    const store = new LayoutStore(storage, 'test');
    const layout = store.loadLayout();
    expect(layout.chartType).toBeUndefined();
    expect(layout.scale).toBeUndefined();
    store.saveLayout({ ...layout, chartType: 'heikin_ashi', scale: 'log' });
    expect(new LayoutStore(storage, 'test').loadLayout()).toMatchObject({ chartType: 'heikin_ashi', scale: 'log' });
    const bad = sanitizeLayout({ chartType: 'renko', scale: 'linear' });
    expect(bad.chartType).toBeUndefined();
    expect(bad.scale).toBeUndefined();
  });

  it('is saved per pane in multi-chart layouts', () => {
    const storage = new MemoryStorage();
    const config = { ...defaultConfig(), count: 4 as const };
    config.panes[0] = { ...config.panes[0], chartType: 'bars', scale: 'percent' };
    config.panes[2] = { ...config.panes[2], chartType: 'area' };
    saveConfig(storage, config);
    const loaded = loadConfig(storage);
    expect(loaded).toEqual(config);
    expect(loaded.panes[1].chartType).toBeUndefined();
    const repaired = sanitizeConfig({ panes: [{ symbol: 'XRPUSDT', chartType: 'point_figure', scale: 'log' }] });
    expect(repaired.panes[0]).toEqual({ source: 'binance', symbol: 'XRPUSDT', timeframe: '1h', indicators: [], scale: 'log' });
  });
});
