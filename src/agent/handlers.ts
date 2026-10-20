import type { Chart, KLineData } from 'klinecharts';
import type { BridgeMethod } from '../../packages/mcp/src/protocol';
import { describeAlert, LINE_OVERLAYS, lineValueAt, type Alert, type AlertCondition, type AlertEngine, type LineGeometry, type NewAlert } from '../alerts/engine';
import { INDICATORS, getIndicatorDef } from '../chart/indicators';
import { isTimeframeId, type TimeframeId } from '../data/timeframes';
import type { Candle, SymbolMeta } from '../data/types';
import type { ChartCount, SyncOptions } from '../layout/config';
import type { LayoutState } from '../layout/manager';
import type { ReplayStartOptions, ReplayState } from '../replay/controller';
import { indexAtTime } from '../replay/session';
import type { DrawingPoint } from '../store/layout';
import type { ActiveIndicator } from '../ui/indicatorPanel';
import { resolveSymbol } from './symbols';

/** The chart methods the handlers use. Tests pass a plain object. */
export type ChartLike = Pick<Chart, 'getDataList' | 'getIndicators' | 'getOverlays' | 'getSymbol' | 'getPeriod' | 'getConvertPictureUrl' | 'getVisibleRange'> &
  Partial<Pick<Chart, 'getSize'>>;

export interface PaneLike {
  readonly index: number;
  chart(): ChartLike;
  info(): { source: string; symbol: string; timeframe: TimeframeId };
  setSymbol(source: string, meta: SymbolMeta): void;
  setTimeframe(tf: TimeframeId): void;
  addIndicator(name: string, params?: number[]): string | null;
  removeIndicator(id: string): void;
  indicators(): ActiveIndicator[];
  loader(): { nextLoad(timeoutMs?: number): Promise<number> };
  /** Timeframes the current symbol can be shown in; imported CSV data only goes up from its own. */
  timeframes?(): readonly TimeframeId[];
}

export interface ReplayLike {
  readonly active: boolean;
  state(): ReplayState;
  start(options: ReplayStartOptions): Promise<ReplayState>;
  step(count: number): KLineData[];
  stop(): void;
}

export interface LayoutLike {
  state(): LayoutState;
  setCount(count: ChartCount): Promise<void>;
  setSync(partial: Partial<SyncOptions>): void;
}

/** Everything the bridge handlers need from the running app. */
export interface HostEnv {
  pane(index: number): PaneLike | null;
  sources(): string[];
  symbols(source: string): Promise<SymbolMeta[]>;
  /** Provider-side search, for sources whose symbol list is only a short popular set. */
  searchSymbols?(source: string, query: string): Promise<SymbolMeta[]>;
  fetchCandles(source: string, symbol: string, timeframe: TimeframeId, options: { before?: number; limit?: number }): Promise<Candle[]>;
  /** Draws on the main chart through the app so the drawing is saved and editable. */
  draw(overlay: string, points: DrawingPoint[], text?: string): string | null;
  removeDrawing(id: string): boolean;
  clearDrawings(): number;
  /** The script runner if this build has one (window.kandle.runScript). */
  scriptRunner(): ((code: string, options?: string | { id?: string; inputs?: Record<string, unknown>; strategy?: Record<string, unknown> }) => unknown) | undefined;
  /** Backtest results of a strategy script (window.kandle.getBacktest), if this build has strategies. */
  backtestReader?(): ((id?: string, trades?: number) => unknown) | undefined;
  /** Page background colour for screenshots. */
  background(): string;
  alerts: AlertEngine;
  requestNotifications(): void;
  replay: ReplayLike;
  layout: LayoutLike | null;
  /** Wait between adding an indicator and reading its values (the engine computes them asynchronously). */
  settle?(): Promise<void>;
  /** Waits for the chart to repaint. Resolves false if the page is hidden and did not paint. */
  paint?(): Promise<boolean>;
}

export type Handler = (params: Record<string, unknown>) => Promise<unknown>;

/** Agent-facing drawing names and the chart engine overlays they create. */
export const DRAWING_OVERLAYS: Record<string, string> = {
  trend_line: 'segment',
  horizontal_line: 'horizontalStraightLine',
  horizontal_ray: 'horizontalRayLine',
  vertical_line: 'verticalStraightLine',
  ray: 'rayLine',
  extended_line: 'straightLine',
  rectangle: 'rectangle',
  fib: 'fibRetracement',
  text: 'textNote',
  price_range: 'priceRange',
};

const OVERLAY_TYPES: Record<string, string> = Object.fromEntries(Object.entries(DRAWING_OVERLAYS).map(([k, v]) => [v, k]));
const ONE_POINT = new Set(['horizontal_line', 'horizontal_ray', 'vertical_line', 'text']);
const DRAWINGS_GROUP = 'drawings';
const MAX_BARS = 5000;

export const iso = (t: number): string => new Date(t).toISOString();

/** Keeps numbers readable without losing meaningful precision. */
export function round(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Number(v.toPrecision(10));
}

// ---------------------------------------------------------------- param helpers

function num(params: Record<string, unknown>, key: string): number | undefined {
  const v = params[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${key} must be a number`);
  return v;
}

function str(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new Error(`${key} must be a string`);
  return v;
}

function bool(params: Record<string, unknown>, key: string): boolean | undefined {
  const v = params[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new Error(`${key} must be true or false`);
  return v;
}

function required<T>(value: T | undefined, key: string): T {
  if (value === undefined) throw new Error(`${key} is required`);
  return value;
}

// ---------------------------------------------------------------- chart readers

export function candleRow(b: KLineData): [string, number, number, number, number, number] {
  return [iso(b.timestamp), b.open, b.high, b.low, b.close, b.volume ?? 0];
}

interface IndicatorReport {
  id: string;
  name: string;
  params: number[];
  pane: 'price' | 'separate';
  lines: string[];
  values: Record<string, number | null>;
}

function indicatorLines(chart: ChartLike, id: string): { lines: string[]; result: Array<Record<string, unknown>> } {
  const ind = chart.getIndicators({ id })[0];
  if (!ind) return { lines: [], result: [] };
  return { lines: ind.figures.map((f) => f.key), result: (ind.result ?? []) as Array<Record<string, unknown>> };
}

export function reportIndicators(pane: PaneLike): IndicatorReport[] {
  const chart = pane.chart();
  return pane.indicators().map((ind) => {
    const { lines, result } = indicatorLines(chart, ind.id);
    const last = result[result.length - 1] ?? {};
    const values: Record<string, number | null> = {};
    for (const key of lines) values[key] = round(last[key]);
    return { id: ind.id, name: ind.name, params: [...ind.params], pane: ind.pane === 'main' ? 'price' : 'separate', lines, values };
  });
}

export interface DrawingReport {
  id: string;
  type: string;
  points: Array<{ time: string; price: number }>;
  text?: string;
}

export function reportDrawings(chart: ChartLike): DrawingReport[] {
  return chart
    .getOverlays({ groupId: DRAWINGS_GROUP })
    .filter((o) => o.currentStep === -1)
    .map((o) => {
      const report: DrawingReport = {
        id: o.id,
        type: OVERLAY_TYPES[o.name] ?? o.name,
        points: o.points
          .filter((p) => typeof p.timestamp === 'number' && typeof p.value === 'number')
          .map((p) => ({ time: iso(p.timestamp as number), price: round(p.value) as number })),
      };
      const text = (o.extendData as { text?: string } | undefined)?.text;
      if (text) report.text = text;
      return report;
    });
}

function reportAlert(alert: Alert) {
  return {
    id: alert.id,
    description: describeAlert(alert),
    type: alert.kind,
    exchange: alert.source,
    symbol: alert.symbol,
    condition: alert.condition,
    frequency: alert.frequency === 'every' ? 'every_time' : 'once',
    level: alert.level,
    drawing_id: alert.drawing?.id,
    indicator: alert.indicator ? { name: alert.indicator.name, line: alert.indicator.line, params: alert.indicator.params } : undefined,
    message: alert.message,
    status: alert.active ? 'active' : alert.triggeredAt ? 'triggered' : 'paused',
    created_at: iso(alert.createdAt),
    last_triggered_at: alert.triggeredAt ? iso(alert.triggeredAt) : undefined,
    times_triggered: alert.triggerCount,
  };
}

/** Snaps a time to the open time of the bar containing it, when it falls inside the data. */
function snapTime(bars: readonly KLineData[], time: number): number {
  if (bars.length === 0) return time;
  const last = bars[bars.length - 1];
  if (time < bars[0].timestamp || time > last.timestamp) return time;
  const i = indexAtTime(bars, time);
  return i >= 0 ? bars[i].timestamp : time;
}

const settleDefault = () => new Promise<void>((r) => setTimeout(r, 60));

// ---------------------------------------------------------------- handlers

export function createHandlers(env: HostEnv): Record<BridgeMethod, Handler> {
  const settle = env.settle ?? settleDefault;

  const paneOf = (params: Record<string, unknown>): PaneLike => {
    const index = num(params, 'pane') ?? 1;
    const pane = env.pane(index);
    if (!pane) throw new Error(`Chart ${index} is not showing. Use set_layout to show ${index > 2 ? 4 : 2} charts first.`);
    return pane;
  };
  const mainPane = (): PaneLike => {
    const pane = env.pane(1);
    if (!pane) throw new Error('The main chart is not ready');
    return pane;
  };

  const resolveIn = async (source: string, symbol: string): Promise<SymbolMeta> => {
    if (!env.sources().includes(source)) throw new Error(`Unknown exchange ${source}. Use one of ${env.sources().join(', ')}.`);
    try {
      return resolveSymbol(await env.symbols(source), symbol);
    } catch (error) {
      const found = env.searchSymbols ? await env.searchSymbols(source, symbol) : [];
      if (!found.length) throw error;
      return resolveSymbol(found, symbol);
    }
  };

  /** Imported CSV data can be shown in its own timeframe and longer ones only. */
  const checkTimeframe = (pane: PaneLike, tf: TimeframeId): void => {
    const allowed = pane.timeframes?.();
    if (allowed && !allowed.includes(tf)) {
      throw new Error(`${pane.info().symbol} on ${pane.info().source} can be shown in ${allowed.join(', ')} only`);
    }
  };

  /** Applies a change and waits for the chart to finish loading the new data. */
  const applyAndWait = async (pane: PaneLike, apply: () => boolean): Promise<void> => {
    const loaded = pane.loader().nextLoad(20_000);
    if (!apply()) {
      loaded.catch(() => undefined);
      return;
    }
    await loaded;
  };

  const chartState = (pane: PaneLike) => {
    const chart = pane.chart();
    const info = pane.info();
    const bars = chart.getDataList();
    const last = bars[bars.length - 1];
    const range = chart.getVisibleRange();
    const from = bars[Math.max(0, Math.min(bars.length - 1, range.from))];
    const to = bars[Math.max(0, Math.min(bars.length - 1, range.to - 1))];
    const state: Record<string, unknown> = {
      pane: pane.index,
      exchange: info.source,
      symbol: info.symbol,
      timeframe: info.timeframe,
      price_precision: chart.getSymbol()?.pricePrecision,
      last_price: last ? last.close : null,
      last_bar: last ? { time: iso(last.timestamp), open: last.open, high: last.high, low: last.low, close: last.close, volume: last.volume ?? 0 } : null,
      bars_loaded: bars.length,
      first_bar_time: bars[0] ? iso(bars[0].timestamp) : null,
      visible_range: from && to ? { from: iso(from.timestamp), to: iso(to.timestamp) } : null,
      indicators: reportIndicators(pane),
    };
    if (pane.index === 1) {
      state.drawings = reportDrawings(chart);
      state.alerts = env.alerts
        .list()
        .filter((a) => a.source === info.source && a.symbol === info.symbol)
        .map(reportAlert);
      state.replay = env.replay.state();
    }
    if (env.layout) state.layout = env.layout.state();
    return state;
  };

  const handlers: Record<BridgeMethod, Handler> = {
    get_chart_state: async (params) => chartState(paneOf(params)),

    set_symbol: async (params) => {
      const pane = paneOf(params);
      const symbol = required(str(params, 'symbol'), 'symbol');
      const source = str(params, 'exchange') ?? pane.info().source;
      const meta = await resolveIn(source, symbol);
      await applyAndWait(pane, () => {
        const before = pane.info();
        if (before.source === source && before.symbol === meta.symbol) return false;
        pane.setSymbol(source, meta);
        return true;
      });
      if (env.replay.active && pane.index === 1) env.replay.stop();
      return chartState(pane);
    },

    set_timeframe: async (params) => {
      const pane = paneOf(params);
      const tf = required(str(params, 'timeframe'), 'timeframe');
      if (!isTimeframeId(tf)) throw new Error(`Unknown timeframe ${tf}`);
      checkTimeframe(pane, tf);
      await applyAndWait(pane, () => {
        if (pane.info().timeframe === tf) return false;
        pane.setTimeframe(tf);
        return true;
      });
      return chartState(pane);
    },

    get_candles: async (params) => {
      const pane = paneOf(params);
      const info = pane.info();
      const chart = pane.chart();
      const limit = Math.min(MAX_BARS, Math.max(1, Math.floor(num(params, 'limit') ?? 200)));
      const from = num(params, 'from');
      const to = num(params, 'to');
      const withIndicators = bool(params, 'include_indicators') ?? false;
      const onChart = chart.getDataList();
      const inRange = (t: number) => (from === undefined || t >= from) && (to === undefined || t <= to);
      // Fetch older history from the exchange when the chart does not reach far enough back.
      let older: KLineData[] = [];
      const enough = () => {
        const earliest = older[0]?.timestamp ?? onChart[0]?.timestamp;
        if (earliest === undefined) return true;
        if (from !== undefined) return earliest <= from;
        const count = older.filter((b) => inRange(b.timestamp)).length + onChart.filter((b) => inRange(b.timestamp)).length;
        return count >= limit;
      };
      for (let page = 0; page < 10 && !enough() && older.length < MAX_BARS; page++) {
        const before = older[0]?.timestamp ?? onChart[0]?.timestamp;
        const batch = await env.fetchCandles(info.source, info.symbol, info.timeframe, { before, limit: 1000 });
        if (batch.length === 0) break;
        older = batch.map((c): KLineData => ({ timestamp: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })).concat(older);
      }
      const all = older.concat(onChart);
      const picked: Array<{ bar: KLineData; chartIndex: number }> = [];
      all.forEach((bar, i) => {
        if (inRange(bar.timestamp)) picked.push({ bar, chartIndex: i - older.length });
      });
      const rows = picked.slice(-limit);
      const result: Record<string, unknown> = {
        exchange: info.source,
        symbol: info.symbol,
        timeframe: info.timeframe,
        count: rows.length,
        columns: ['time', 'open', 'high', 'low', 'close', 'volume'],
        rows: rows.map((r) => candleRow(r.bar)),
      };
      if (env.replay.active && pane.index === 1) result.note = 'Bar replay is on; bars after the replay cursor are hidden.';
      if (withIndicators) {
        result.indicators = pane.indicators().map((ind) => {
          const { lines, result: values } = indicatorLines(chart, ind.id);
          const series: Record<string, Array<number | null>> = {};
          for (const key of lines) series[key] = rows.map((r) => (r.chartIndex >= 0 ? round(values[r.chartIndex]?.[key]) : null));
          return { id: ind.id, name: ind.name, params: ind.params, lines: series };
        });
      }
      return result;
    },

    add_indicator: async (params) => {
      const pane = paneOf(params);
      const raw = required(str(params, 'name'), 'name');
      const def = getIndicatorDef(raw) ?? getIndicatorDef(raw.toUpperCase());
      if (!def) throw new Error(`Unknown indicator ${raw}. Available: ${INDICATORS.map((d) => d.name).join(', ')}.`);
      const list = params.params;
      if (list !== undefined && (!Array.isArray(list) || list.some((v) => typeof v !== 'number' || !Number.isFinite(v)))) {
        throw new Error('params must be a list of numbers');
      }
      const id = pane.addIndicator(def.name, list as number[] | undefined);
      if (!id) throw new Error(`Could not add ${def.name}`);
      await settle();
      return reportIndicators(pane).find((i) => i.id === id) ?? { id, name: def.name };
    },

    remove_indicator: async (params) => {
      const pane = paneOf(params);
      const id = str(params, 'id');
      const name = str(params, 'name');
      const targets = pane.indicators().filter((i) => (id ? i.id === id : i.name.toUpperCase() === name?.toUpperCase()));
      if (targets.length === 0) throw new Error(id ? `No indicator with id ${id}` : `No ${name} indicator on chart ${pane.index}`);
      for (const t of targets) pane.removeIndicator(t.id);
      return { removed: targets.map((t) => ({ id: t.id, name: t.name })) };
    },

    list_indicators: async (params) => {
      const pane = paneOf(params);
      return {
        on_chart: reportIndicators(pane),
        available: INDICATORS.map((d) => ({
          name: d.name,
          label: d.label,
          pane: d.pane === 'main' ? 'price' : 'separate',
          params: d.variadic ? `one ${d.paramLabels[0] ?? 'length'} per line` : d.paramLabels,
          defaults: d.defaults,
        })),
      };
    },

    draw: async (params) => {
      const pane = mainPane();
      const type = required(str(params, 'type'), 'type');
      const overlay = DRAWING_OVERLAYS[type];
      if (!overlay) throw new Error(`Unknown drawing type ${type}. Use one of ${Object.keys(DRAWING_OVERLAYS).join(', ')}.`);
      const rawPoints = params.points;
      if (!Array.isArray(rawPoints) || rawPoints.length === 0) throw new Error('points must be a non-empty list');
      const bars = pane.chart().getDataList();
      const lastTime = bars[bars.length - 1]?.timestamp;
      const need = ONE_POINT.has(type) ? 1 : 2;
      if (rawPoints.length < need) throw new Error(`${type} needs ${need} points`);
      const points: DrawingPoint[] = rawPoints.slice(0, need).map((p: unknown, i: number) => {
        const r = (p ?? {}) as Record<string, unknown>;
        const price = num(r, 'price');
        if (price === undefined) throw new Error(`Point ${i + 1} needs a price`);
        let time = num(r, 'time');
        if (time === undefined) {
          if (type !== 'horizontal_line' && type !== 'horizontal_ray') throw new Error(`Point ${i + 1} needs a time`);
          if (lastTime === undefined) throw new Error('The chart has no data yet');
          time = lastTime;
        }
        return { timestamp: snapTime(bars, time), value: price };
      });
      const text = str(params, 'text');
      if (type === 'text' && !text) throw new Error('Text notes need text');
      const id = env.draw(overlay, points, type === 'text' ? text : undefined);
      if (!id) throw new Error(`Could not draw ${type}`);
      return { id, type, points: points.map((p) => ({ time: iso(p.timestamp), price: p.value })), ...(text ? { text } : {}) };
    },

    remove_drawing: async (params) => {
      const id = required(str(params, 'id'), 'id');
      if (!env.removeDrawing(id)) throw new Error(`No drawing with id ${id}. get_chart_state lists the drawings.`);
      return { removed: id };
    },

    clear_drawings: async () => ({ removed: env.clearDrawings() }),

    run_script: async (params) => {
      const code = required(str(params, 'code'), 'code');
      const runner = env.scriptRunner();
      if (!runner) return 'not available yet: this build of Kandle has no script engine.';
      const id = str(params, 'id');
      const record = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
      const inputs = record(params.inputs);
      if (params.strategy !== undefined && params.strategy !== null && !record(params.strategy)) throw new Error('strategy must be an object such as {"initial_capital": 10000}');
      const strategy = record(params.strategy);
      // The name only labels the call; id, inputs and strategy settings go to the runner as options.
      const result = await runner(
        code,
        id || inputs || strategy ? { ...(id ? { id } : {}), ...(inputs ? { inputs } : {}), ...(strategy ? { strategy } : {}) } : str(params, 'name'),
      );
      try {
        return JSON.parse(JSON.stringify(result ?? { ok: true }));
      } catch {
        return String(result);
      }
    },

    get_backtest: async (params) => {
      const reader = env.backtestReader?.();
      if (!reader) return 'not available yet: this build of Kandle has no strategy backtester.';
      const id = str(params, 'id');
      const result = await reader(id, num(params, 'trades') ?? 50);
      if (!result) {
        throw new Error(
          id
            ? `No strategy script with id ${id}. run_script returns the id; strategies are scripts that call strategy().`
            : 'No strategy script on the chart. Run one with run_script; it must call strategy() instead of indicator().',
        );
      }
      return JSON.parse(JSON.stringify(result));
    },

    screenshot: async (params) => {
      const pane = paneOf(params);
      const chart = pane.chart();
      // The engine paints on animation frames, so let pending changes reach the canvas first.
      const fresh = env.paint ? await env.paint() : true;
      const dataUrl = chart.getConvertPictureUrl(true, 'png', env.background());
      const size = chart.getSize?.();
      const info = pane.info();
      return {
        dataUrl,
        width: size ? Math.round(size.width) : undefined,
        height: size ? Math.round(size.height) : undefined,
        label: `${info.symbol} ${info.timeframe} on ${info.source}`,
        ...(fresh ? {} : { note: 'The Kandle tab is in the background, so the image may not show the latest changes.' }),
      };
    },

    set_alert: async (params) => {
      const pane = mainPane();
      const chart = pane.chart();
      const info = pane.info();
      const type = required(str(params, 'type'), 'type');
      const condition = (str(params, 'condition') ?? 'crosses') as AlertCondition;
      if (!['crosses', 'crosses_up', 'crosses_down', 'touches'].includes(condition)) throw new Error(`Unknown condition ${condition}`);
      const frequency = str(params, 'frequency') === 'every_time' ? 'every' : 'once';
      const message = str(params, 'message');
      const bars = chart.getDataList();
      const last = bars[bars.length - 1];
      const base = { source: info.source, symbol: info.symbol, condition, frequency, ...(message ? { message } : {}) } as const;
      let input: NewAlert;
      let seed: { value: number; level: number } | undefined;
      if (type === 'price') {
        const level = required(num(params, 'level'), 'level');
        input = { ...base, kind: 'price', level };
        if (last) seed = { value: last.close, level };
      } else if (type === 'drawing') {
        const id = required(str(params, 'drawing_id'), 'drawing_id');
        const overlay = chart.getOverlays({ id })[0];
        if (!overlay) throw new Error(`No drawing with id ${id}. get_chart_state lists the drawings.`);
        if (!LINE_OVERLAYS.has(overlay.name)) throw new Error('Alerts work on horizontal lines, horizontal rays, trend lines, rays and extended lines.');
        const geometry: LineGeometry = {
          id,
          name: overlay.name,
          points: overlay.points
            .filter((p) => typeof p.timestamp === 'number' && typeof p.value === 'number')
            .map((p) => ({ timestamp: p.timestamp as number, value: p.value as number })),
        };
        input = { ...base, kind: 'drawing', drawing: geometry };
        const level = last ? lineValueAt(geometry, last.timestamp) : null;
        if (last && level !== null) seed = { value: last.close, level };
      } else if (type === 'indicator') {
        const id = required(str(params, 'indicator_id'), 'indicator_id');
        const level = required(num(params, 'level'), 'level');
        const ind = pane.indicators().find((i) => i.id === id);
        if (!ind) throw new Error(`No indicator with id ${id} on the main chart. list_indicators shows the ids.`);
        const { lines, result } = indicatorLines(chart, id);
        const line = str(params, 'indicator_line') ?? lines[0];
        if (!line || !lines.includes(line)) throw new Error(`${ind.name} has lines ${lines.join(', ')}`);
        input = { ...base, kind: 'indicator', level, indicator: { id, name: ind.name, line, params: ind.params } };
        const current = round(result[result.length - 1]?.[line]);
        if (current !== null) seed = { value: current, level };
      } else {
        throw new Error('type must be price, drawing or indicator');
      }
      const alert = env.alerts.add(input, seed);
      env.requestNotifications();
      return reportAlert(alert);
    },

    list_alerts: async () => ({ alerts: env.alerts.list().map(reportAlert) }),

    remove_alert: async (params) => {
      const id = required(str(params, 'id'), 'id');
      if (id === 'all') return { removed: env.alerts.clear() };
      if (!env.alerts.remove(id)) throw new Error(`No alert with id ${id}`);
      return { removed: 1 };
    },

    start_replay: async (params) =>
      env.replay.start({
        startTime: num(params, 'start_time'),
        barsBack: num(params, 'bars_back'),
        speed: num(params, 'speed'),
        autoplay: bool(params, 'autoplay'),
      }),

    step_replay: async (params) => {
      const count = Math.max(1, Math.min(1000, Math.floor(num(params, 'bars') ?? 1)));
      const revealed = env.replay.step(count);
      return { revealed: { columns: ['time', 'open', 'high', 'low', 'close', 'volume'], rows: revealed.map(candleRow) }, state: env.replay.state() };
    },

    stop_replay: async () => {
      env.replay.stop();
      return env.replay.state();
    },

    set_layout: async (params) => {
      const layout = env.layout;
      if (!layout) throw new Error('Layouts are not available');
      const charts = required(num(params, 'charts'), 'charts');
      if (charts !== 1 && charts !== 2 && charts !== 4) throw new Error('charts must be 1, 2 or 4');
      await layout.setCount(charts);
      const sync = params.sync as Partial<SyncOptions> | undefined;
      if (sync && typeof sync === 'object') {
        const clean: Partial<SyncOptions> = {};
        for (const key of ['crosshair', 'timeframe', 'symbol'] as const) if (typeof sync[key] === 'boolean') clean[key] = sync[key];
        layout.setSync(clean);
      }
      const panes = Array.isArray(params.panes) ? (params.panes as Array<Record<string, unknown>>) : [];
      for (const [i, spec] of panes.entries()) {
        const pane = env.pane(i + 1);
        if (!pane) continue;
        const symbol = str(spec, 'symbol');
        if (symbol) {
          const source = str(spec, 'exchange') ?? pane.info().source;
          const meta = await resolveIn(source, symbol);
          await applyAndWait(pane, () => {
            const cur = pane.info();
            if (cur.source === source && cur.symbol === meta.symbol) return false;
            pane.setSymbol(source, meta);
            return true;
          });
        }
        const tf = str(spec, 'timeframe');
        if (tf) {
          if (!isTimeframeId(tf)) throw new Error(`Unknown timeframe ${tf}`);
          checkTimeframe(pane, tf);
          await applyAndWait(pane, () => {
            if (pane.info().timeframe === tf) return false;
            pane.setTimeframe(tf);
            return true;
          });
        }
      }
      return layout.state();
    },
  };
  return handlers;
}

/** Runs one request and turns any failure into an error message for the agent. */
export async function dispatch(handlers: Record<BridgeMethod, Handler>, method: BridgeMethod, params: Record<string, unknown>): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  const handler = handlers[method];
  if (!handler) return { ok: false, error: `Unknown method ${method}` };
  try {
    return { ok: true, result: await handler(params ?? {}) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
