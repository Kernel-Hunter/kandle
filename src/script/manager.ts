/**
 * Owns the scripts on a chart: compiles them, adds them as indicators, keeps their input
 * values, and reports changes so the layout can be saved.
 */
import type { Chart } from 'klinecharts';
import { compileScript, type InputDef, type InputValue, type RunResult, type ScriptEngine, type SymbolContext } from './engine';
import type { ScriptError } from './errors';
import { registerScriptIndicator, scriptIndicator, SCRIPT_INDICATOR } from './render';
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
  error: string | null;
  /** Milliseconds of the last full run. */
  lastRunMs: number | null;
}

export interface ScriptHost {
  chart(): Chart;
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

  constructor(private readonly host: ScriptHost) {
    registerScriptIndicator();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
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

  /** Compiles and test-runs a script on the loaded candles without touching the chart. */
  private prepare(source: string, inputs?: Record<string, unknown>): { engine: ScriptEngine; ms: number | null } | { error: RunScriptResult } {
    if (typeof source !== 'string' || !source.trim()) return { error: { ok: false, error: '1:1 The script is empty' } };
    if (source.length > MAX_SCRIPT_LENGTH) return { error: { ok: false, error: `1:1 Scripts are limited to ${MAX_SCRIPT_LENGTH} characters` } };
    const compiled = compileScript(source);
    if (!compiled.ok) return { error: failure(compiled.error) };
    const engine = compiled.engine;
    if (inputs) engine.setInputValues(inputs);
    engine.setSymbol(this.host.symbol());
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
    const item: Item = { id, engine, indicatorId, lastFullMs: null, reportedError: null };
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
    }
    return item;
  }

  private afterRun(item: Item, r: RunResult): void {
    if (!r.incremental) item.lastFullMs = r.ms;
    const message = r.error ? r.error.format() : null;
    if (message !== item.reportedError) {
      item.reportedError = message;
      if (message) this.host.toast(`${item.engine.meta.shortTitle}: ${message}`, 'error');
      this.changed(false);
    }
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
    const chart = this.host.chart();
    chart.removeIndicator({ id: old.indicatorId });
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
    this.host.chart().removeIndicator({ id: item.indicatorId });
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
     * On success the result also carries the title and the last value of each plot.
     */
    runScript: (source: string, options: { id?: string; inputs?: Record<string, unknown> } | string = {}): RunScriptResult & { title?: string; overlay?: boolean; plots?: Array<{ title: string; last: number | null }> } => {
      const opts = typeof options === 'object' && options !== null ? options : {};
      let res: RunScriptResult;
      if (opts.id && manager.get(opts.id)) {
        res = manager.update(opts.id, source);
        if (res.ok && opts.inputs) manager.setInputs(opts.id, opts.inputs);
      } else {
        res = manager.add(source, opts.inputs);
      }
      if (!res.ok || !res.id) return res;
      const info = manager.get(res.id);
      return { ...res, title: info?.title, overlay: info?.overlay, plots: manager.lastValues(res.id) };
    },
    listScripts: (): ScriptInfo[] => manager.list(),
    removeScript: (id: string): boolean => manager.remove(id),
    setScriptInputs: (id: string, values: Record<string, unknown>): RunScriptResult => manager.setInputs(id, values),
  };
}
