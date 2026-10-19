/**
 * Owns the scripts on a chart: compiles them, adds them as indicators, keeps their input
 * values, and reports changes so the layout can be saved.
 */
import type { Chart } from 'klinecharts';
import { compileScript, type InputDef, type InputValue, type RequestFeeds, type ResolvedRequest, type RunResult, type ScriptEngine, type StrategyReport, type SymbolContext } from './engine';
import type { ScriptError } from './errors';
import { registerScriptIndicator, scriptIndicator, tradesIndicator, SCRIPT_INDICATOR } from './render';
import { backtestSummary, type BacktestJson } from './backtestJson';
import { MAX_SCRIPTS, MAX_SCRIPT_LENGTH, type ScriptRecord } from './persist';

export { sanitizeScripts, MAX_SCRIPTS, MAX_SCRIPT_LENGTH, type ScriptRecord } from './persist';

export interface ScriptErrorInfo {
  message: string;
  line: number;
  col: number;
  from: number;
  to: number;
  bar?: number;
}

export interface RunScriptResult {
  ok: boolean;
  id?: string;
  /** "line:col message" for display and the automation API. */
  error?: string;
  detail?: ScriptErrorInfo;
}

export interface ScriptInfo {
  id: string;
  title: string;
  shortTitle: string;
  overlay: boolean;
  source: string;
  inputs: InputDef[];
  values: Record<string, InputValue>;
  plots: string[];
  /** Declared with strategy(), so it has backtest results. */
  strategy: boolean;
  error: string | null;
  /** Milliseconds of the last full run. */
  lastRunMs: number | null;
}

/** request.security data as the app provides it: readable now, loadable ahead of a run. */
export interface ScriptFeeds extends RequestFeeds {
  /** Resolves when the series covers `from` (ms) or failed to load. Never rejects. */
  load(req: ResolvedRequest, from: number): Promise<void>;
  /** Called after a series got new history, so scripts that use it run again. */
  onChange(fn: (key: string) => void): () => void;
}

/** How long runScript waits for requested series before returning what it has. */
const READY_TIMEOUT_MS = 20_000;

export interface ScriptHost {
  chart(): Chart;
  /** Other symbols and timeframes for request.security. */
  feeds?: ScriptFeeds;
  candlePaneId: string;
  symbol(): SymbolContext;
  /** Called with the current records whenever scripts change. */
  persist(records: ScriptRecord[]): void;
  toast(message: string, kind?: 'info' | 'error'): void;
}

interface Item {
  id: string;
  engine: ScriptEngine;
  indicatorId: string;
  /** Trade markers on the price chart for a strategy shown in its own pane. */
  tradesId: string | null;
  lastFullMs: number | null;
  reportedError: string | null;
}

export function errorInfo(e: ScriptError): ScriptErrorInfo {
  const info: ScriptErrorInfo = { message: e.message, line: e.line, col: e.col, from: e.from, to: e.to };
  if (e.bar !== undefined) info.bar = e.bar;
  return info;
}

function failure(e: ScriptError): RunScriptResult {
  return { ok: false, error: e.format(), detail: errorInfo(e) };
}

let counter = 0;
const newId = () => `s${Date.now().toString(36)}${(counter++).toString(36)}`;

export class ScriptManager {
  private items: Item[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly runListeners = new Set<(id: string) => void>();

  private refreshCount = 0;

  constructor(private readonly host: ScriptHost) {
    registerScriptIndicator();
    host.feeds?.onChange(() => {
      for (const item of this.items) if (item.engine.hasRequests) this.recalc(item);
    });
  }

  /** Makes the chart run a script again from its first bar. */
  private recalc(item: Item): void {
    item.engine.invalidate();
    // A changed calcParams list is what makes the chart call calc() again.
    const params = [...Object.values(item.engine.inputValues()).map(String), `r${this.refreshCount++}`];
    this.host.chart().overrideIndicator({ id: item.indicatorId, name: SCRIPT_INDICATOR, calcParams: params });
  }

  /**
   * Waits until the series a script requests have loaded, then runs it on the chart's bars
   * so its results are current. Resolves at once for scripts without request.security.
   */
  async whenReady(id: string): Promise<void> {
    const item = this.items.find((i) => i.id === id);
    const feeds = this.host.feeds;
    if (!item || !feeds || !item.engine.hasRequests) return;
    const data = this.host.chart().getDataList();
    const from = data[0]?.timestamp ?? Date.now();
    const loads = Promise.all(item.engine.requests().map((r) => feeds.load(r, from)));
    await Promise.race([loads, new Promise((r) => setTimeout(r, READY_TIMEOUT_MS))]);
    if (!this.items.includes(item)) return;
    item.engine.setSymbol(this.host.symbol());
    item.engine.invalidate();
    if (data.length > 0) item.engine.run(data);
    this.recalc(item);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Called after every run of a strategy script (new data, input changes), with its id. */
  onStrategyRun(fn: (id: string) => void): () => void {
    this.runListeners.add(fn);
    return () => this.runListeners.delete(fn);
  }

  private changed(persist = true): void {
    if (persist) this.host.persist(this.records());
    for (const fn of this.listeners) fn();
  }

  records(): ScriptRecord[] {
    return this.items.map((i) => ({ id: i.id, source: i.engine.source, inputs: i.engine.inputValues() }));
  }

  list(): ScriptInfo[] {
    return this.items.map((i) => this.info(i));
  }

  get(id: string): ScriptInfo | null {
    const item = this.items.find((i) => i.id === id);
    return item ? this.info(item) : null;
  }

  private info(i: Item): ScriptInfo {
    const e = i.engine;
    return {
      id: i.id,
      title: e.meta.title,
      shortTitle: e.meta.shortTitle,
      overlay: e.meta.overlay,
      source: e.source,
      inputs: e.inputs.map((d) => ({ ...d })),
      values: e.inputValues(),
      plots: e.outputs.plots.map((p) => p.title),
      strategy: e.isStrategy,
      error: e.lastError ? e.lastError.format() : null,
      lastRunMs: i.lastFullMs,
    };
  }

  /** Last non-na value of each plot, for automation results. */
  lastValues(id: string): Array<{ title: string; last: number | null }> {
    const item = this.items.find((i) => i.id === id);
    if (!item) return [];
    return item.engine.outputs.plots.map((p) => {
      let last: number | null = null;
      for (let i = p.values.length - 1; i >= 0; i--) {
        const v = p.values[i];
        if (v !== undefined && v === v) {
          last = v;
          break;
        }
      }
      return { title: p.title, last };
    });
  }

  /** Backtest results of a strategy script; null for indicators and unknown ids. */
  report(id: string): StrategyReport | null {
    return this.items.find((i) => i.id === id)?.engine.strategy ?? null;
  }

  /** Compiles and test-runs a script on the loaded candles without touching the chart. */
  private prepare(source: string, inputs?: Record<string, unknown>): { engine: ScriptEngine; ms: number | null } | { error: RunScriptResult } {
    if (typeof source !== 'string' || !source.trim()) return { error: { ok: false, error: '1:1 The script is empty' } };
    if (source.length > MAX_SCRIPT_LENGTH) return { error: { ok: false, error: `1:1 Scripts are limited to ${MAX_SCRIPT_LENGTH} characters` } };
    const compiled = compileScript(source);
    if (!compiled.ok) return { error: failure(compiled.error) };
    const engine = compiled.engine;
    if (inputs) engine.setInputValues(inputs);
    engine.setSymbol(this.host.symbol());
    engine.setFeeds(this.host.feeds ?? null);
    const data = this.host.chart().getDataList();
    let ms: number | null = null;
    if (data.length > 0) {
      const res = engine.run(data);
      if (res.error) return { error: failure(res.error) };
      ms = res.ms;
    }
    return { engine, ms };
  }

  private attach(id: string, engine: ScriptEngine, indicatorId: string): Item {
    const item: Item = { id, engine, indicatorId, tradesId: null, lastFullMs: null, reportedError: null };
    const chart = this.host.chart();
    const create = scriptIndicator({
      id: indicatorId,
      engine,
      symbol: () => this.host.symbol(),
      onRun: (r) => this.afterRun(item, r),
    });
    if (engine.meta.overlay) {
      chart.createIndicator({ ...create, paneId: this.host.candlePaneId }, true);
    } else {
      chart.createIndicator(create, false);
      const created = chart.getIndicators({ id: indicatorId })[0];
      if (created) chart.setPaneOptions({ id: created.paneId, height: 120 });
      if (engine.isStrategy) {
        item.tradesId = `${indicatorId}_trades`;
        chart.createIndicator({ ...tradesIndicator(item.tradesId, engine), paneId: this.host.candlePaneId }, true);
      }
    }
    return item;
  }

  private detach(item: Item): void {
    const chart = this.host.chart();
    chart.removeIndicator({ id: item.indicatorId });
    if (item.tradesId) chart.removeIndicator({ id: item.tradesId });
  }

  private afterRun(item: Item, r: RunResult): void {
    if (!r.incremental) item.lastFullMs = r.ms;
    const message = r.error ? r.error.format() : null;
    if (message !== item.reportedError) {
      item.reportedError = message;
      if (message) this.host.toast(`${item.engine.meta.shortTitle}: ${message}`, 'error');
      this.changed(false);
    }
    if (item.engine.isStrategy) for (const fn of this.runListeners) fn(item.id);
  }

  /** Adds a script to the chart. Returns its id, or the first error. */
  add(source: string, inputs?: Record<string, unknown>, id?: string): RunScriptResult {
    if (this.items.length >= MAX_SCRIPTS) return { ok: false, error: `1:1 At most ${MAX_SCRIPTS} scripts can be on a chart` };
    const prepared = this.prepare(source, inputs);
    if ('error' in prepared) return prepared.error;
    const scriptId = id && !this.items.some((i) => i.id === id) ? id : newId();
    const item = this.attach(scriptId, prepared.engine, `${SCRIPT_INDICATOR}_${scriptId}`);
    item.lastFullMs ??= prepared.ms;
    this.items.push(item);
    this.changed();
    return { ok: true, id: scriptId };
  }

  /** Replaces a script's source, keeping input values whose keys still exist. */
  update(id: string, source: string): RunScriptResult {
    const index = this.items.findIndex((i) => i.id === id);
    if (index < 0) return { ok: false, error: `1:1 No script with id ${id}` };
    const old = this.items[index];
    const prepared = this.prepare(source, old.engine.inputValues());
    if ('error' in prepared) return prepared.error;
    this.detach(old);
    // A fresh indicator id makes the chart drop any cached result of the old script.
    const item = this.attach(id, prepared.engine, `${SCRIPT_INDICATOR}_${id}_${(counter++).toString(36)}`);
    item.lastFullMs ??= prepared.ms;
    this.items[index] = item;
    this.changed();
    return { ok: true, id };
  }

  setInputs(id: string, values: Record<string, unknown>): RunScriptResult {
    const item = this.items.find((i) => i.id === id);
    if (!item) return { ok: false, error: `1:1 No script with id ${id}` };
    item.engine.setInputValues(values);
    // Changing calcParams makes the chart run calc() again.
    this.host.chart().overrideIndicator({ id: item.indicatorId, name: SCRIPT_INDICATOR, calcParams: Object.values(item.engine.inputValues()).map(String) });
    this.changed();
    return { ok: true, id };
  }

  remove(id: string): boolean {
    const item = this.items.find((i) => i.id === id);
    if (!item) return false;
    this.detach(item);
    this.items = this.items.filter((i) => i !== item);
    this.changed();
    return true;
  }

  /** Puts saved scripts back on the chart. Scripts that no longer compile are reported and kept out. */
  restore(records: ScriptRecord[]): void {
    for (const r of records) {
      const compiled = compileScript(r.source);
      if (!compiled.ok) {
        this.host.toast(`A saved script could not be loaded: ${compiled.error.format()}`, 'error');
        continue;
      }
      compiled.engine.setInputValues(r.inputs);
      compiled.engine.setSymbol(this.host.symbol());
      compiled.engine.setFeeds(this.host.feeds ?? null);
      const id = this.items.some((i) => i.id === r.id) ? newId() : r.id;
      this.items.push(this.attach(id, compiled.engine, `${SCRIPT_INDICATOR}_${id}`));
    }
    this.changed(false);
  }
}

/** The script methods added to the automation handle (window.kandle). */
export function scriptApi(manager: ScriptManager) {
  return {
    /**
     * Compiles a script and adds it to the chart, or updates the script with `options.id`.
     * A string second argument (a display name from the agent bridge) is accepted and ignored.
     * On success the result also carries the title and the last value of each plot. A script
     * that uses request.security is returned once the series it requests have loaded.
     */
    runScript: async (source: string, options: { id?: string; inputs?: Record<string, unknown> } | string = {}): Promise<RunScriptResult & { title?: string; overlay?: boolean; plots?: Array<{ title: string; last: number | null }> }> => {
      const opts = typeof options === 'object' && options !== null ? options : {};
      let res: RunScriptResult;
      if (opts.id && manager.get(opts.id)) {
        res = manager.update(opts.id, source);
        if (res.ok && opts.inputs) manager.setInputs(opts.id, opts.inputs);
      } else {
        res = manager.add(source, opts.inputs);
      }
      if (!res.ok || !res.id) return res;
      await manager.whenReady(res.id);
      const info = manager.get(res.id);
      if (info?.error) return { ok: false, id: res.id, error: info.error };
      const report = manager.report(res.id);
      return {
        ...res,
        title: info?.title,
        overlay: info?.overlay,
        plots: manager.lastValues(res.id),
        ...(report ? { backtest: backtestSummary(report, 20) } : {}),
      };
    },
    /**
     * Backtest results of a strategy script: the one with `id`, or the most recently added
     * strategy. `trades` is how many of the latest closed trades to include (default 50).
     */
    getBacktest: (id?: string, trades = 50): (BacktestJson & { id: string; title: string }) | null => {
      const info = id ? manager.get(id) : [...manager.list()].reverse().find((s) => s.strategy);
      const report = info ? manager.report(info.id) : null;
      if (!info || !report) return null;
      return { id: info.id, title: info.title, ...backtestSummary(report, trades) };
    },
    listScripts: (): ScriptInfo[] => manager.list(),
    removeScript: (id: string): boolean => manager.remove(id),
    setScriptInputs: (id: string, values: Record<string, unknown>): RunScriptResult => manager.setInputs(id, values),
  };
}
