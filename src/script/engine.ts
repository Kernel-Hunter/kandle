import { Compiler, SOURCE_SERIES, type CompiledScript, type InputDef, type InputValue, type ScriptMeta } from './compiler';
import { BudgetError, ScriptError } from './errors';
import type { Outputs } from './outputs';
import { parse } from './parser';
import { Frame, type Candle, type RunBudget, type Runtime, type SymbolContext } from './runtime';
import { chartTimeframe, periodOf, requestKey, requestTimeframe, resampleBars, type RequestFeeds, type ResolvedRequest, type SecuritySite } from './security';
import { TIMEFRAMES, getTimeframe } from '../data/timeframes';
import type { StrategyConfig, StrategyReport } from './strategy';
import { applyStrategyPatch, type StrategyOverrides, type StrategyPatch } from './strategySettings';
import { Color } from './values';

export type { Candle, SymbolContext } from './runtime';
export type { InputDef, InputValue, ScriptMeta } from './compiler';
export type { StrategyReport } from './strategy';
export type { RequestFeeds, ResolvedRequest } from './security';

export interface RunResult {
  error: ScriptError | null;
  /** Bars executed in this call. */
  barsRun: number;
  incremental: boolean;
  ms: number;
}

/** Brings a stored or user-entered value back into the range an input allows. */
export function validateInput(def: InputDef, value: unknown): InputValue {
  const fallback = def.defval;
  switch (def.type) {
    case 'int':
    case 'float': {
      let n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
      if (!Number.isFinite(n)) return fallback;
      if (def.type === 'int') n = Math.round(n);
      if (def.options && def.options.length > 0) return def.options.includes(n) ? n : fallback;
      if (def.minval !== undefined) n = Math.max(def.minval, n);
      if (def.maxval !== undefined) n = Math.min(def.maxval, n);
      return n;
    }
    case 'bool':
      return typeof value === 'boolean' ? value : fallback;
    case 'string':
      if (typeof value !== 'string') return fallback;
      if (def.options && def.options.length > 0 && !def.options.includes(value)) return fallback;
      return value;
    case 'source':
      return typeof value === 'string' && value in SOURCE_SERIES ? value : fallback;
    case 'color':
      return typeof value === 'string' && Color.fromHex(value) ? value : fallback;
    case 'timeframe': {
      if (typeof value !== 'string') return fallback;
      const text = value.trim();
      if (text && !requestTimeframe(text)) return fallback;
      if (def.options && def.options.length > 0) {
        // "1D" picks the option written "D".
        const match = def.options.find((o) => typeof o === 'string' && sameTimeframe(o, text));
        return match === undefined ? fallback : match;
      }
      return text;
    }
    case 'symbol': {
      if (typeof value !== 'string') return fallback;
      const text = value.trim();
      return text.length <= MAX_SYMBOL_LENGTH && SYMBOL_TEXT.test(text) ? text : fallback;
    }
  }
}

const MAX_SYMBOL_LENGTH = 64;
/** Letters, digits and the punctuation tickers use ("BINANCE:ETHUSDT", "EUR/USD", "BRK.B", "BTC-USD"); empty follows the chart. */
const SYMBOL_TEXT = /^[A-Za-z0-9._:/^=!&-]*$/;

const sameTimeframe = (a: string, b: string): boolean => (a.trim() === '' || b === '' ? a.trim() === b : requestTimeframe(a) === requestTimeframe(b));

/** A value an input can be set to, with the text to show for it. */
export interface InputChoice {
  value: InputValue;
  label: string;
}

/**
 * The fixed set of values an input offers, for a dropdown, or null when any value of its
 * type can be typed. Timeframe inputs offer Kandle's timeframes (or their own options) and
 * "Chart", which follows the chart's timeframe.
 */
export function inputChoices(def: InputDef): InputChoice[] | null {
  if (def.type === 'timeframe') {
    const values: string[] = def.options && def.options.length > 0 ? def.options.map(String) : ['', ...TIMEFRAMES.map((tf) => periodOf(tf.id))];
    return values.map((v) => {
      const tf = requestTimeframe(v);
      return { value: v, label: v.trim() === '' ? 'Chart' : tf ? getTimeframe(tf)!.label : v };
    });
  }
  if (def.options && def.options.length > 0) return def.options.map((o) => ({ value: o, label: String(o) }));
  if (def.type === 'source') return Object.keys(SOURCE_SERIES).map((k) => ({ value: k, label: k }));
  return null;
}

/** The choice that holds `value`; timeframes match by bar size, so "1D" selects "D". */
export function selectedChoice(def: InputDef, choices: InputChoice[], value: InputValue): InputChoice | undefined {
  if (def.type === 'timeframe' && typeof value === 'string') return choices.find((c) => sameTimeframe(String(c.value), value.trim()));
  return choices.find((c) => c.value === value);
}

/** A compiled script plus its runtime state. Each chart indicator owns one. */
export class ScriptEngine {
  private root: Frame | null = null;
  private needsFull = true;
  private values: InputValue[];
  private report: StrategyReport | null = null;
  /** Backtest settings that replace the strategy() call's. */
  private overrides: StrategyOverrides = {};
  private feeds: RequestFeeds | null = null;
  /** Counts runs, so request.security on the chart's own bars always reruns its tail. */
  private runCount = 0;
  lastError: ScriptError | null = null;
  /**
   * Set when a run used up its operation budget. Later runs (every live update) return this
   * error at once instead of spending the budget again, until inputs, settings or the symbol change.
   */
  private stopped: BudgetError | null = null;

  constructor(
    private readonly compiled: CompiledScript,
    readonly source: string,
  ) {
    this.values = compiled.inputs.map((i) => i.defval);
    compiled.rt.inputValues = this.values;
  }

  get meta(): ScriptMeta {
    return this.compiled.meta;
  }

  get inputs(): InputDef[] {
    return this.compiled.inputs;
  }

  get outputs(): Outputs {
    return this.compiled.outputs;
  }

  /** Bar data of the last run (open, high, low, close arrays by bar index). */
  get bars(): Pick<Runtime, 'open' | 'high' | 'low' | 'close' | 'time'> {
    return this.compiled.rt;
  }

  /** What the last run spent of its operation and time budget. */
  get budget(): RunBudget {
    return this.compiled.rt.budget;
  }

  get barCount(): number {
    return this.compiled.rt.count;
  }

  /** True when the script calls request.security. */
  get hasRequests(): boolean {
    return this.compiled.securities.length > 0;
  }

  /** Where request.security reads other symbols and timeframes. Without feeds, only higher timeframes of the chart's own bars work. */
  setFeeds(feeds: RequestFeeds | null): void {
    this.feeds = feeds;
    this.needsFull = true;
  }

  /** Makes the next run start from the first bar, for example after requested data arrived. */
  invalidate(): void {
    this.needsFull = true;
  }

  /** The series the script requests for the current symbol, without the chart's own series. */
  requests(): ResolvedRequest[] {
    const out = new Map<string, ResolvedRequest>();
    for (const site of this.compiled.securities) {
      let req: ResolvedRequest | null;
      try {
        req = this.resolve(site);
      } catch {
        // A bad input value; the run reports it.
        continue;
      }
      if (req && !this.isChartSeries(req)) out.set(requestKey(req), req);
    }
    return [...out.values()];
  }

  /** The series a call site reads with the current symbol and input values. Throws for a bad input value. */
  private resolve(site: SecuritySite): ResolvedRequest | null {
    const rt = this.compiled.rt;
    const ctx = rt.symbol;
    const request = site.current(rt);
    const timeframe = request.timeframe ?? chartTimeframe(ctx);
    if (!timeframe) return null;
    const prefix = request.source;
    const source = prefix && this.feeds?.hasSource(prefix) ? prefix : (ctx.source ?? '');
    return { source, symbol: request.symbol ?? ctx.ticker, timeframe };
  }

  private isChartSeries(req: ResolvedRequest): boolean {
    const ctx = this.compiled.rt.symbol;
    return req.source === (ctx.source ?? '') && req.symbol === ctx.ticker && req.timeframe === chartTimeframe(ctx);
  }

  get isStrategy(): boolean {
    return this.compiled.rt.strategy !== null;
  }

  /** Backtest results of the last run, or null for indicators. */
  get strategy(): StrategyReport | null {
    const rt = this.compiled.rt;
    if (!rt.strategy) return null;
    this.report ??= rt.strategy.report(rt.time, rt.close, rt.symbol.periodSeconds);
    return this.report;
  }

  /** Backtest settings from the strategy() call, or null for indicators. */
  get strategyDefaults(): StrategyConfig | null {
    const config = this.compiled.meta.strategy;
    return config ? { ...config } : null;
  }

  /** The settings the backtest runs with: the strategy() call's, with the overrides applied. */
  get strategySettings(): StrategyConfig | null {
    const broker = this.compiled.rt.strategy;
    return broker ? { ...broker.config } : null;
  }

  /** Settings that differ from the strategy() call, ready to store. */
  strategyOverrides(): StrategyOverrides {
    return { ...this.overrides };
  }

  /**
   * Changes backtest settings. Keys missing from `patch` keep their value; null puts a
   * setting back to the strategy() call's value. Does nothing for indicators.
   */
  setStrategySettings(patch: StrategyPatch): void {
    const defaults = this.compiled.meta.strategy;
    const broker = this.compiled.rt.strategy;
    if (!defaults || !broker) return;
    this.overrides = applyStrategyPatch(defaults, this.overrides, patch);
    broker.config = { ...defaults, ...this.overrides };
    this.needsFull = true;
    this.stopped = null;
  }

  /** Values keyed by input key, ready to store. */
  inputValues(): Record<string, InputValue> {
    const out: Record<string, InputValue> = {};
    for (const def of this.compiled.inputs) out[def.key] = this.values[def.index];
    return out;
  }

  /** Applies stored values; unknown keys are ignored and bad values fall back to defaults. */
  setInputValues(values: Record<string, unknown>): void {
    for (const def of this.compiled.inputs) {
      if (Object.prototype.hasOwnProperty.call(values, def.key)) this.values[def.index] = validateInput(def, values[def.key]);
    }
    this.needsFull = true;
    this.stopped = null;
  }

  setSymbol(ctx: SymbolContext): void {
    const rt = this.compiled.rt;
    if (rt.symbol.ticker === ctx.ticker && rt.symbol.period === ctx.period && rt.symbol.mintick === ctx.mintick && rt.symbol.source === ctx.source) return;
    rt.symbol = ctx;
    this.needsFull = true;
    this.stopped = null;
  }

  /**
   * Runs the script on `candles`. When only the last bar changed or a few bars were
   * appended, re-runs just those bars; otherwise starts from the first bar.
   */
  run(candles: readonly Candle[]): RunResult {
    const started = performance.now();
    const rt = this.compiled.rt;
    if (this.stopped) {
      this.lastError = this.stopped;
      return { error: this.stopped, barsRun: 0, incremental: false, ms: 0 };
    }
    rt.budget.start();
    const prev = rt.count;
    const n = candles.length;
    let start = 0;
    const canIncrement =
      !this.needsFull &&
      !this.compiled.mutatesState &&
      this.root !== null &&
      prev > 0 &&
      n >= prev &&
      n - prev <= 16 &&
      rt.time[0] === candles[0].timestamp &&
      rt.time[prev - 1] === candles[prev - 1].timestamp;

    if (canIncrement) {
      start = prev - 1;
      rt.realtime = true;
    } else {
      this.reset();
      rt.realtime = false;
    }
    for (let i = start; i < n; i++) rt.setBar(i, candles[i]);
    rt.count = n;

    const root = this.root!;
    const body = this.compiled.body;
    const broker = rt.strategy;
    this.lastError = null;
    this.report = null;
    if (this.compiled.securities.length > 0 && n > 0) {
      try {
        this.updateRequests(candles, start, !canIncrement);
      } catch (e) {
        const err = e instanceof ScriptError ? e : new ScriptError(e instanceof Error ? e.message : String(e), null);
        this.lastError = err;
        this.needsFull = true;
        if (err instanceof BudgetError) this.stopped = err;
        return { error: err, barsRun: 0, incremental: canIncrement, ms: performance.now() - started };
      }
    }
    let b = start;
    try {
      for (; b < n; b++) {
        rt.bar = b;
        rt.runId++;
        rt.loopCount = 0;
        rt.ctl = 0;
        if (rt.budget.spend(true)) throw new BudgetError(rt.budget.message(), null);
        // Orders placed on earlier bars fill against this bar before the script sees it.
        broker?.beginBar(b, rt.time[b], rt.open[b], rt.high[b], rt.low[b], rt.close[b]);
        root.enter(rt);
        body(root);
        broker?.endBar(b, rt.close[b]);
      }
      this.needsFull = false;
    } catch (e) {
      const err = e instanceof ScriptError ? e : new ScriptError(e instanceof Error ? e.message : String(e), null);
      err.bar = b;
      this.lastError = err;
      this.needsFull = true;
      if (err instanceof BudgetError) this.stopped = err;
    }
    return { error: this.lastError, barsRun: n - start, incremental: canIncrement, ms: performance.now() - started };
  }

  /** Brings every request.security value up to date for chart bars from `start` on. */
  private updateRequests(candles: readonly Candle[], start: number, full: boolean): void {
    const rt = this.compiled.rt;
    const ctx = rt.symbol;
    this.runCount++;
    for (const site of this.compiled.securities) {
      if (full) site.reset();
      site.rt.inputValues = this.values;
      const req = this.resolve(site);
      if (!req) {
        site.update(rt, start, null, '', -1, ctx, 0);
        continue;
      }
      const tf = getTimeframe(req.timeframe)!;
      const subCtx: SymbolContext = { ...ctx, source: req.source, ticker: req.symbol, period: periodOf(req.timeframe), periodSeconds: tf.ms / 1000 };
      const key = requestKey(req);
      let bars: readonly Candle[] | null = null;
      let version = this.runCount;
      if (this.isChartSeries(req)) {
        bars = candles;
      } else if (this.feeds) {
        this.feeds.need(req, candles[0].timestamp);
        const series = this.feeds.series(req);
        if (series?.error) throw new ScriptError(`Could not load ${req.symbol} ${tf.label}: ${series.error}`, site.span);
        if (series) {
          bars = series.bars;
          version = series.version;
        }
      } else if (req.source === (ctx.source ?? '') && req.symbol === ctx.ticker && tf.ms > ctx.periodSeconds * 1000) {
        // No data feed (tests, plain engine use): build higher-timeframe bars from the chart.
        bars = resampleBars(candles, req.timeframe);
      }
      site.update(rt, start, bars, key, version, subCtx, tf.ms);
    }
  }

  private reset(): void {
    const rt = this.compiled.rt;
    rt.truncate(0);
    rt.count = 0;
    const o = this.compiled.outputs;
    for (const p of o.plots) {
      p.values.length = 0;
      p.colors.length = 0;
    }
    for (const s of o.shapes) {
      s.values.length = 0;
      s.colors.length = 0;
      s.textColors.length = 0;
    }
    for (const f of o.fills) f.colors.length = 0;
    for (const c of [...o.backgrounds, ...o.barColors]) c.colors.length = 0;
    rt.strategy?.reset(rt.symbol.mintick);
    this.root = this.compiled.newRootFrame();
  }
}

export type CompileResult = { ok: true; engine: ScriptEngine } | { ok: false; error: ScriptError };

/** Parses and compiles a script. Errors carry line, column and character offsets. */
export function compileScript(source: string): CompileResult {
  try {
    const program = parse(source);
    const compiled = new Compiler().compile(program);
    return { ok: true, engine: new ScriptEngine(compiled, source) };
  } catch (e) {
    if (e instanceof ScriptError) return { ok: false, error: e };
    return { ok: false, error: new ScriptError(e instanceof Error ? e.message : String(e), null) };
  }
}
