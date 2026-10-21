import { z } from 'zod';
import type { BridgeMethod } from './protocol.js';

/**
 * Tool definitions shared by the MCP server and its tests. Every tool except
 * get_bridge_status forwards to the bridge method of the same name after its
 * arguments pass the zod schema and `prepareArgs`.
 */

export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1D', '1W'] as const;
const TIMEFRAME_INPUTS = ['1m', '5m', '15m', '1h', '1H', '4h', '4H', '1d', '1D', '1w', '1W'] as const;

export const DRAWING_TYPES = [
  'trend_line',
  'horizontal_line',
  'horizontal_ray',
  'vertical_line',
  'ray',
  'extended_line',
  'rectangle',
  'fib',
  'text',
  'price_range',
] as const;

/** Data source ids, matching SOURCES in src/data/sources.ts. */
export const EXCHANGES = ['binance', 'coinbase', 'bybit', 'okx', 'kraken', 'twelvedata', 'alpaca', 'polygon', 'csv'] as const;

export const ALERT_CONDITIONS = ['crosses', 'crosses_up', 'crosses_down', 'touches'] as const;

/** Chart types and price scales, matching src/chart/chartStyle.ts. */
export const CHART_TYPES = ['candles', 'hollow_candles', 'bars', 'line', 'area', 'heikin_ashi'] as const;
export const PRICE_SCALES = ['normal', 'log', 'percent'] as const;

/** Order size and commission types of strategy(), matching src/script/strategySettings.ts. */
export const QTY_TYPES = ['fixed', 'cash', 'percent_of_equity'] as const;
export const COMMISSION_TYPES = ['percent', 'cash_per_contract', 'cash_per_order'] as const;

const time = z
  .union([z.number(), z.string().min(4).max(40)])
  .describe('Unix time in milliseconds or seconds, or an ISO 8601 date such as 2026-10-01T12:00:00Z');

const pane = z.number().int().min(1).max(4).optional().describe('Chart pane, 1 to 4 in reading order. Defaults to 1, the main chart.');

/** Backtest settings for run_script, named like the strategy() arguments. null goes back to the script's value. */
const strategySettings = z
  .object({
    initial_capital: z.number().finite().gt(0, 'initial_capital must be more than 0').nullable().optional().describe('Starting equity'),
    default_qty_type: z.enum(QTY_TYPES).nullable().optional().describe('How default_qty_value is read: contracts, cash or percent of equity'),
    default_qty_value: z.number().finite().gt(0, 'default_qty_value must be more than 0').nullable().optional().describe('Order size for orders placed without qty'),
    commission_type: z.enum(COMMISSION_TYPES).nullable().optional().describe('percent of the fill value, cash per contract or cash per order'),
    commission_value: z.number().finite().min(0, 'commission_value must be 0 or more').nullable().optional().describe('Charged on every entry and exit'),
    slippage: z.number().int('slippage must be a whole number of ticks').min(0, 'slippage must be 0 or more').nullable().optional().describe('Ticks added to market and stop fills'),
    pyramiding: z.number().int('pyramiding must be a whole number').min(0, 'pyramiding must be 0 or more').nullable().optional().describe('Entries allowed in one direction; 0 and 1 both allow one'),
    process_orders_on_close: z.boolean().nullable().optional().describe('Fill market orders at the close of the bar that placed them'),
  })
  .strict();

const point = z.object({
  time: time.optional().describe('Bar time. Optional for horizontal lines; defaults to the latest bar.'),
  price: z.number().finite().describe('Price level'),
});

export const schemas = {
  get_bridge_status: z.object({}),
  get_chart_state: z.object({ pane }),
  set_symbol: z.object({
    symbol: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[A-Za-z0-9._:/-]+$/, 'Symbols use letters, digits and . _ : / -')
      .describe('Market symbol such as BTCUSDT, ETH/USDT or BTC-USD'),
    exchange: z.enum(EXCHANGES).optional().describe('Data source. Defaults to the chart\'s current exchange. twelvedata, alpaca and polygon need a key saved in Kandle. csv is data the user imported from a CSV file; its symbols are the dataset names shown in symbol search.'),
    pane,
  }),
  set_timeframe: z.object({
    timeframe: z.enum(TIMEFRAME_INPUTS).describe('Bar size: 1m, 5m, 15m, 1h, 4h, 1D or 1W'),
    pane,
  }),
  get_candles: z.object({
    limit: z.number().int().min(1).max(5000).optional().describe('Most recent bars to return (default 200, max 5000)'),
    from: time.optional().describe('Only bars at or after this time'),
    to: time.optional().describe('Only bars at or before this time'),
    include_indicators: z.boolean().optional().describe('Add the values of indicators on the chart for each bar'),
    pane,
  }),
  add_indicator: z.object({
    name: z.string().min(1).max(40).describe('Indicator name from list_indicators, e.g. RSI, MACD, EMA, BOLL, ICHIMOKU, VP'),
    params: z.array(z.number().finite()).max(10).optional().describe('Calculation parameters, e.g. [14] for RSI or [20, 50, 200] for EMA'),
    pane,
  }),
  remove_indicator: z.object({
    id: z.string().min(1).max(80).optional().describe('Indicator id from list_indicators'),
    name: z.string().min(1).max(40).optional().describe('Remove every indicator with this name instead'),
    pane,
  }),
  list_indicators: z.object({ pane }),
  draw: z.object({
    type: z.enum(DRAWING_TYPES).describe('What to draw'),
    points: z
      .array(point)
      .min(1)
      .max(3)
      .describe('Anchor points. Horizontal line, horizontal ray, vertical line and text take 1 point; the others take 2.'),
    text: z.string().max(280).optional().describe('Label for text notes'),
  }),
  remove_drawing: z.object({ id: z.string().min(1).max(80).describe('Drawing id from get_chart_state or draw') }),
  clear_drawings: z.object({}),
  run_script: z.object({
    code: z.string().min(1).max(100_000).describe('Script source code'),
    name: z.string().max(80).optional(),
    id: z.string().min(1).max(80).optional().describe('Id of a script from an earlier run_script, to replace it instead of adding another'),
    inputs: z
      .record(z.string().min(1).max(80), z.union([z.string().max(200), z.number().finite(), z.boolean()]))
      .optional()
      .describe('Input values by input title, e.g. {"Symbol": "SOLUSDT", "Higher timeframe": "240"}. Inputs left out keep their defaults.'),
    strategy: strategySettings
      .optional()
      .describe('Backtest settings that replace the ones in the strategy() call, e.g. {"initial_capital": 5000, "commission_value": 0.1}. Settings left out keep their value; null goes back to the script\'s value. Only for scripts declared with strategy().'),
  }),
  get_backtest: z.object({
    id: z.string().min(1).max(80).optional().describe('Script id from run_script. Defaults to the most recently added strategy.'),
    trades: z.number().int().min(0).max(500).optional().describe('How many of the latest closed trades to include (default 50, max 500)'),
  }),
  screenshot: z.object({ pane }),
  set_alert: z.object({
    type: z.enum(['price', 'drawing', 'indicator']).describe('price: a price level. drawing: a horizontal or trend line on the chart. indicator: a line of an indicator.'),
    condition: z.enum(ALERT_CONDITIONS).optional().describe('Default crosses. touches fires when a bar\'s high-low range reaches the level.'),
    level: z.number().finite().optional().describe('Price level for price alerts, or value level for indicator alerts'),
    drawing_id: z.string().min(1).max(80).optional().describe('Drawing id for drawing alerts'),
    indicator_id: z.string().min(1).max(80).optional().describe('Indicator id for indicator alerts'),
    indicator_line: z.string().min(1).max(40).optional().describe('Which line of the indicator, e.g. rsi1, macd, dif. Defaults to the first.'),
    frequency: z.enum(['once', 'every_time']).optional().describe('once (default) disables the alert after it fires; every_time fires at most once per bar'),
    message: z.string().max(200).optional(),
  }),
  list_alerts: z.object({}),
  remove_alert: z.object({ id: z.string().min(1).max(80).describe('Alert id, or "all"') }),
  get_watchlist: z.object({}),
  add_to_watchlist: z.object({
    symbol: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[A-Za-z0-9._:/-]+$/, 'Symbols use letters, digits and . _ : / -')
      .describe('Market symbol such as SOLUSDT, ETH-USD or AAPL'),
    exchange: z.enum(EXCHANGES).optional().describe('Data source of the row. Defaults to the main chart\'s exchange.'),
  }),
  remove_from_watchlist: z.object({
    symbol: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[A-Za-z0-9._:/-]+$/, 'Symbols use letters, digits and . _ : / -')
      .describe('Symbol to remove, or "all" to empty the watchlist'),
    exchange: z.enum(EXCHANGES).optional().describe('Only needed when the symbol is listed on more than one exchange'),
  }),
  start_replay: z.object({
    start_time: time.optional().describe('Replay starts with this bar as the last visible one'),
    bars_back: z.number().int().min(1).max(5000).optional().describe('Or start this many bars before the latest bar (default 100)'),
    speed: z.number().int().min(1).max(10).optional().describe('Bars per second when playing, 1 to 10'),
    autoplay: z.boolean().optional().describe('Start playing right away instead of waiting for step_replay'),
  }),
  step_replay: z.object({ bars: z.number().int().min(1).max(1000).optional().describe('Bars to reveal (default 1)') }),
  stop_replay: z.object({}),
  set_layout: z.object({
    charts: z.union([z.literal(1), z.literal(2), z.literal(4)]).describe('Number of charts: 1, 2 side by side, or 4 in a grid'),
    sync: z
      .object({ crosshair: z.boolean().optional(), timeframe: z.boolean().optional(), symbol: z.boolean().optional() })
      .optional()
      .describe('Keep these in step across charts'),
    panes: z
      .array(
        z.object({
          symbol: z.string().min(1).max(40).regex(/^[A-Za-z0-9._:/-]+$/).optional(),
          exchange: z.enum(EXCHANGES).optional(),
          timeframe: z.enum(TIMEFRAME_INPUTS).optional(),
        }),
      )
      .max(4)
      .optional()
      .describe('Optional symbol and timeframe per pane, in reading order'),
  }),
  set_chart_style: z.object({
    type: z
      .enum(CHART_TYPES)
      .optional()
      .describe('How bars are drawn. heikin_ashi only changes the picture: get_candles, indicators, scripts and alerts keep using the real OHLC.'),
    scale: z.enum(PRICE_SCALES).optional().describe('Price axis: normal, log (logarithmic) or percent (change from the first bar on screen)'),
    pane,
  }),
} as const;

export type ToolName = keyof typeof schemas;

export interface ToolDef {
  name: ToolName;
  title: string;
  description: string;
  method?: BridgeMethod;
  readOnly?: boolean;
  destructive?: boolean;
  timeoutMs?: number;
}

export const TOOLS: readonly ToolDef[] = [
  {
    name: 'get_bridge_status',
    title: 'Bridge status',
    description: 'Shows whether the Kandle app is connected and, if not, the pairing code the user must enter in Kandle (Agent button, then Agent bridge).',
    readOnly: true,
  },
  {
    name: 'get_chart_state',
    title: 'Chart state',
    description: 'Symbol, exchange, timeframe, last price, visible range, indicators with their latest values, drawings with ids, alerts, replay and layout state.',
    method: 'get_chart_state',
    readOnly: true,
  },
  { name: 'set_symbol', title: 'Set symbol', description: 'Switches the chart to another market, e.g. ETHUSDT on Binance or BTC-USD on Coinbase, or to a dataset the user imported from a CSV file (exchange csv).', method: 'set_symbol', timeoutMs: 30_000 },
  { name: 'set_timeframe', title: 'Set timeframe', description: 'Changes the bar size of the chart.', method: 'set_timeframe' },
  {
    name: 'get_candles',
    title: 'Get candles',
    description: 'OHLCV bars from the chart, newest last. Times are ISO 8601 UTC. Use include_indicators to get indicator values aligned with the bars.',
    method: 'get_candles',
    readOnly: true,
    timeoutMs: 30_000,
  },
  { name: 'add_indicator', title: 'Add indicator', description: 'Adds an indicator such as RSI, MACD, EMA, BOLL, ICHIMOKU or VP (volume profile). Returns its id.', method: 'add_indicator' },
  { name: 'remove_indicator', title: 'Remove indicator', description: 'Removes an indicator by id, or every indicator with a name.', method: 'remove_indicator', destructive: true },
  {
    name: 'list_indicators',
    title: 'List indicators',
    description: 'Indicators on the chart (with ids, parameters and latest values) and every indicator that can be added.',
    method: 'list_indicators',
    readOnly: true,
  },
  {
    name: 'draw',
    title: 'Draw',
    description:
      'Draws on the main chart by price and time: trend_line, horizontal_line, horizontal_ray, vertical_line, ray, extended_line, rectangle, fib (retracement from the first point to the second), text (a note at a point) or price_range. Returns the drawing id.',
    method: 'draw',
  },
  { name: 'remove_drawing', title: 'Remove drawing', description: 'Removes one drawing by id.', method: 'remove_drawing', destructive: true },
  { name: 'clear_drawings', title: 'Clear drawings', description: 'Removes every drawing on the current symbol of the main chart.', method: 'clear_drawings', destructive: true },
  {
    name: 'run_script',
    title: 'Run script',
    description:
      'Runs a Kandle script on the main chart and returns its id and latest plot values, or the error with line and column. request.security can read other symbols on the same source and other timeframes, including ones picked with input.symbol and input.timeframe. `inputs` sets input values by title and `id` replaces an earlier script; the result lists the input values. A script declared with strategy() is backtested on the loaded bars; the result then also has `backtest`: settings, summary (net profit, profit factor, win rate, max drawdown, Sharpe, buy and hold) and the last 20 trades. `strategy` changes backtest settings such as initial capital, order size, commission and slippage without editing the code; with `id` it reruns an earlier strategy with new settings. Orders fill at the next bar\'s open; limit and stop orders when the bar reaches their price.',
    method: 'run_script',
    timeoutMs: 60_000,
  },
  {
    name: 'get_backtest',
    title: 'Get backtest',
    description:
      'Backtest results of a strategy script on the main chart: settings in use (and changedSettings, those that differ from the strategy() call; settings.risk lists the strategy.risk.* rules the script sets), riskStop (the risk rule that stopped trading and why, or null), summary figures, the latest closed trades with entry and exit time, price, signal and profit, and open trades. Results follow live data.',
    method: 'get_backtest',
    readOnly: true,
  },
  { name: 'screenshot', title: 'Screenshot', description: 'PNG image of a chart pane, including indicators and drawings.', method: 'screenshot', readOnly: true, timeoutMs: 30_000 },
  {
    name: 'set_alert',
    title: 'Set alert',
    description:
      'Creates an alert on the main chart\'s symbol: price crossing or touching a level, price crossing a drawn horizontal or trend line, or an indicator line crossing a level. The app shows a notification, a toast and plays a sound when it fires.',
    method: 'set_alert',
  },
  { name: 'list_alerts', title: 'List alerts', description: 'Every alert with its status.', method: 'list_alerts', readOnly: true },
  { name: 'remove_alert', title: 'Remove alert', description: 'Deletes an alert by id, or all alerts with "all".', method: 'remove_alert', destructive: true },
  {
    name: 'get_watchlist',
    title: 'Get watchlist',
    description:
      'Symbols in the watchlist panel with their exchange, last price, change and change percent. Crypto exchanges give the change over the last 24 hours; Twelve Data, Alpaca and Polygon the change since the previous daily close; CSV data the last close against the bar before. Each row says which (basis) and when it was updated.',
    method: 'get_watchlist',
    readOnly: true,
  },
  { name: 'add_to_watchlist', title: 'Add to watchlist', description: 'Adds a symbol to the watchlist, on the main chart\'s exchange unless exchange is given. Returns the updated watchlist.', method: 'add_to_watchlist', timeoutMs: 30_000 },
  { name: 'remove_from_watchlist', title: 'Remove from watchlist', description: 'Removes a symbol from the watchlist, or every symbol with "all".', method: 'remove_from_watchlist', destructive: true },
  {
    name: 'start_replay',
    title: 'Start bar replay',
    description: 'Hides bars after a start point so the chart can be replayed bar by bar. Indicators only see visible bars.',
    method: 'start_replay',
    timeoutMs: 30_000,
  },
  { name: 'step_replay', title: 'Step replay', description: 'Reveals the next bars in replay and returns them.', method: 'step_replay' },
  { name: 'stop_replay', title: 'Stop replay', description: 'Leaves replay and returns the chart to live data.', method: 'stop_replay' },
  {
    name: 'set_layout',
    title: 'Set layout',
    description: 'Shows 1, 2 (side by side) or 4 (grid) charts. Each pane has its own symbol, timeframe and indicators; crosshair, timeframe and symbol can be synced.',
    method: 'set_layout',
    timeoutMs: 30_000,
  },
  {
    name: 'set_chart_style',
    title: 'Set chart style',
    description:
      'Changes how a chart draws its bars (candles, hollow_candles, bars, line, area or heikin_ashi) and its price scale (normal, log or percent). Data from the other tools stays the real OHLC.',
    method: 'set_chart_style',
  },
];

/** Accepts milliseconds, seconds or a date string and returns milliseconds. */
export function parseTime(value: number | string): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid time ${value}`);
    // Anything below 10^11 is far too small for milliseconds after 1973, so treat it as seconds.
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return parseTime(Number(trimmed));
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) throw new Error(`Could not read "${value}" as a time. Use an ISO date such as 2026-10-01T12:00:00Z.`);
  return ms;
}

export function normalizeTimeframe(value: string): (typeof TIMEFRAMES)[number] {
  const map: Record<string, (typeof TIMEFRAMES)[number]> = {
    '1m': '1m',
    '5m': '5m',
    '15m': '15m',
    '1h': '1h',
    '1H': '1h',
    '4h': '4h',
    '4H': '4h',
    '1d': '1D',
    '1D': '1D',
    '1w': '1W',
    '1W': '1W',
  };
  const tf = map[value];
  if (!tf) throw new Error(`Unknown timeframe ${value}. Use one of ${TIMEFRAMES.join(', ')}.`);
  return tf;
}

const ONE_POINT: ReadonlySet<string> = new Set(['horizontal_line', 'horizontal_ray', 'vertical_line', 'text']);

/**
 * Converts validated arguments into bridge parameters: times become milliseconds,
 * timeframes are normalised, and cross-field rules are checked with clear messages.
 */
export function prepareArgs(name: ToolName, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  for (const key of ['from', 'to', 'start_time'] as const) {
    if (out[key] !== undefined) out[key] = parseTime(out[key] as number | string);
  }
  if (typeof out.timeframe === 'string') out.timeframe = normalizeTimeframe(out.timeframe);

  switch (name) {
    case 'get_candles':
      if (typeof out.from === 'number' && typeof out.to === 'number' && out.from > out.to) throw new Error('from must be before to');
      break;
    case 'remove_indicator':
      if (!out.id && !out.name) throw new Error('Give either id or name');
      break;
    case 'draw': {
      const type = out.type as string;
      const points = (out.points as Array<{ time?: number | string; price: number }>).map((p) => ({
        price: p.price,
        ...(p.time !== undefined ? { time: parseTime(p.time) } : {}),
      }));
      const need = ONE_POINT.has(type) ? 1 : 2;
      if (points.length < need) throw new Error(`${type} needs ${need} point${need > 1 ? 's' : ''}`);
      if (need === 2 && points.slice(0, 2).some((p) => p.time === undefined)) throw new Error(`${type} needs a time on both points`);
      if ((type === 'vertical_line' || type === 'text') && points[0].time === undefined) throw new Error(`${type} needs a time`);
      if (type === 'text' && !out.text) throw new Error('text drawings need text');
      out.points = points.slice(0, need);
      break;
    }
    case 'set_alert': {
      const type = out.type as string;
      if (type === 'price' && out.level === undefined) throw new Error('Price alerts need a level');
      if (type === 'drawing' && !out.drawing_id) throw new Error('Drawing alerts need drawing_id (see get_chart_state)');
      if (type === 'indicator' && (!out.indicator_id || out.level === undefined)) throw new Error('Indicator alerts need indicator_id and level');
      break;
    }
    case 'start_replay':
      if (out.start_time !== undefined && out.bars_back !== undefined) throw new Error('Give start_time or bars_back, not both');
      break;
    case 'set_chart_style':
      if (out.type === undefined && out.scale === undefined) throw new Error('Give a type, a scale or both');
      break;
    case 'set_layout':
      if (Array.isArray(out.panes)) {
        out.panes = (out.panes as Array<Record<string, unknown>>).map((p) => ({
          ...p,
          ...(typeof p.timeframe === 'string' ? { timeframe: normalizeTimeframe(p.timeframe) } : {}),
        }));
      }
      break;
    default:
      break;
  }
  return out;
}
