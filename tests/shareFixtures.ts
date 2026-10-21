import { DRAWING_TOOLS } from '../src/chart/overlays';
import { defaultConfig } from '../src/layout/config';
import type { ChartSnapshot } from '../src/share/codec';
import type { DrawingRecord } from '../src/store/layout';

/** Shared data for the share link tests. Test files that import this mock klinecharts first. */

export const T0 = Date.UTC(2026, 9, 1);
export const H = 3_600_000;
export const PAGE = 'https://kernel-hunter.github.io/kandle/';

/** One drawing of every type, with as many points as the tool takes. */
export const ALL_DRAWINGS: DrawingRecord[] = DRAWING_TOOLS.map((tool, i) => {
  const count = tool.overlay === 'parallelStraightLine' ? 3 : ['horizontalStraightLine', 'horizontalRayLine', 'verticalStraightLine', 'textNote', 'priceLine'].includes(tool.overlay) ? 1 : 2;
  const record: DrawingRecord = {
    name: tool.overlay,
    points: Array.from({ length: count }, (_, p) => ({ timestamp: T0 + (i * 10 + p) * H, value: 2500.123456789 + i * 17.25 + p * 3.5 })),
  };
  if (tool.overlay === 'textNote') record.text = 'Breakout "retest" here, 50% <b>not html</b>';
  return record;
});

/** A chart with every section filled in: two indicators, every drawing type, two scripts and a 4 chart layout. */
export function snapshot(over: Partial<ChartSnapshot> = {}): ChartSnapshot {
  const layout = defaultConfig();
  return {
    source: 'binance',
    symbol: 'ETHUSDT',
    timeframe: '4h',
    style: { type: 'heikin_ashi', scale: 'log' },
    range: { time: T0 + 40 * H, barSpace: 8.5 },
    indicators: [
      { name: 'EMA', params: [20, 50, 200] },
      { name: 'RSI', params: [14] },
    ],
    drawings: ALL_DRAWINGS,
    scripts: [
      { id: 's1', source: '//@version=5\nindicator("Mine", overlay=true)\nlen = input.int(20, "Length")\nplot(ta.sma(close, len))', inputs: { Length: 34 } },
      { id: 's2', source: 'strategy("S")\nif close > open\n    strategy.entry("L", strategy.long)', inputs: { Show: true, Symbol: 'BINANCE:SOLUSDT' }, strategy: { initialCapital: 5000, commissionValue: 0.1, defaultQtyType: 'percent_of_equity' } },
    ],
    layout: { ...layout, count: 4, sync: { crosshair: true, timeframe: true, symbol: false }, panes: [
      { source: 'coinbase', symbol: 'BTC-USD', timeframe: '1D', indicators: [{ name: 'MACD', params: [12, 26, 9] }], chartType: 'bars', scale: 'percent' },
      { source: 'kraken', symbol: 'XBT/USD', timeframe: '15m', indicators: [] },
      { source: 'twelvedata', symbol: 'EUR/USD', timeframe: '1h', indicators: [{ name: 'BOLL', params: [20, 2] }] },
    ] },
    ...over,
  };
}


export const ALL = { chart: true, indicators: true, drawings: true, scripts: true, layout: true };
