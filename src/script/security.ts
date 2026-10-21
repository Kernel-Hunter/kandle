/**
 * request.security: the value of an expression on another symbol or timeframe.
 *
 * The compiler builds the expression against its own Runtime, so it runs in its own bar
 * loop over the requested bars with its own per-call-site state. Its values are then
 * mapped onto the chart's bars by time. Without lookahead a chart bar only sees requested
 * bars that had closed by the time the chart bar closed.
 */
import { getTimeframe, resampleCandles, timeframeForMs, type TimeframeId } from '../data/timeframes';
import { BudgetError, ScriptError, type Span } from './errors';
import { Frame, Runtime, type Candle, type FrameLayout, type SymbolContext } from './runtime';
import { Tuple } from './values';

/** Distinct symbol and timeframe pairs one script may request. */
export const MAX_REQUESTS = 5;

/** What a request.security call asks for, as written in the script. */
export interface SecurityRequest {
  /** Symbol to load, or null for the chart's symbol. */
  symbol: string | null;
  /** Data source id from an "EXCHANGE:SYMBOL" prefix, lower case, or null. */
  source: string | null;
  /** Bar size, or null for the chart's timeframe. */
  timeframe: TimeframeId | null;
}

/**
 * A symbol or timeframe argument that comes from inputs. Inputs only change when the user
 * edits them, which reruns the script, so the value is fixed for a run and read before it.
 */
export interface InputArg {
  /** The argument's text for the current input values, read from the chart's runtime. */
  value(rt: Runtime): unknown;
  span: Span;
}

/** Symbol and timeframe arguments of a call site that depend on inputs. */
export interface InputArgs {
  symbol?: InputArg;
  timeframe?: InputArg;
}

export const NEEDS_CONSTANT = 'request.security needs constant symbol and timeframe';

/** "BINANCE:ETHUSDT" splits into source and symbol; "" is the chart's symbol. */
export function parseRequestSymbol(text: string): Pick<SecurityRequest, 'symbol' | 'source'> {
  const t = text.trim();
  if (!t) return { symbol: null, source: null };
  const colon = t.lastIndexOf(':');
  if (colon > 0) return { source: t.slice(0, colon).toLowerCase(), symbol: t.slice(colon + 1) };
  return { source: null, symbol: t };
}

export const timeframeMessage = (text: string): string => `Timeframe "${text}" is not available; use 1, 5, 15, 60, 240, D or W`;

/** A request with the chart's symbol, source and timeframe filled in. */
export interface ResolvedRequest {
  source: string;
  symbol: string;
  timeframe: TimeframeId;
}

export const requestKey = (r: ResolvedRequest): string => `${r.source}|${r.symbol}|${r.timeframe}`;

/** Bars of a requested series. */
export interface RequestSeries {
  /** Oldest first. */
  bars: readonly Candle[];
  /** Changes whenever `bars` changes. */
  version: number;
  /** Set when the series could not be loaded. */
  error?: string;
}

/**
 * Where requested series come from. Scripts run synchronously, so the app loads series
 * ahead of time and the engine only reads what is already there.
 */
export interface RequestFeeds {
  /** True when `id` names a data source, so "BINANCE:ETHUSDT" can pick it. */
  hasSource(id: string): boolean;
  /** Loaded bars for a request, or null while they load. */
  series(req: ResolvedRequest): RequestSeries | null;
  /** Asks for history back to `from` (ms). Loading happens in the background. */
  need(req: ResolvedRequest, from: number): void;
}

/** Timeframe strings scripts use, mapped to Kandle's bar sizes. Upper case M is a month. */
const TIMEFRAME_NAMES: Record<string, TimeframeId> = {
  '1': '1m',
  '1m': '1m',
  '5': '5m',
  '5m': '5m',
  '15': '15m',
  '15m': '15m',
  '60': '1h',
  '1h': '1h',
  '1H': '1h',
  '240': '4h',
  '4h': '4h',
  '4H': '4h',
  D: '1D',
  '1D': '1D',
  d: '1D',
  '1d': '1D',
  W: '1W',
  '1W': '1W',
  w: '1W',
  '1w': '1W',
};

/** Kandle timeframe for a script timeframe string ("60", "240", "D", "1W", "4h"...), or null. */
export function requestTimeframe(text: string): TimeframeId | null {
  return Object.prototype.hasOwnProperty.call(TIMEFRAME_NAMES, text.trim()) ? TIMEFRAME_NAMES[text.trim()] : null;
}

/** The script notation of a Kandle timeframe: "1", "60", "D", "W"... */
export function periodOf(tf: TimeframeId): string {
  switch (tf) {
    case '1D':
      return 'D';
    case '1W':
      return 'W';
    default:
      return String(getTimeframe(tf)!.ms / 60_000);
  }
}

/** The chart's timeframe from its symbol context. */
export function chartTimeframe(ctx: SymbolContext): TimeframeId | null {
  return timeframeForMs(ctx.periodSeconds * 1000) ?? null;
}

/** Index of the last element of `times` that is <= `t`, or -1. Times are ascending. */
function lastAtOrBefore(times: readonly number[], count: number, t: number): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

export interface AlignOptions {
  lookahead: boolean;
  gaps: boolean;
}

/**
 * Which requested bar each chart bar reads, or -1 for none.
 *
 * - Without lookahead: the last requested bar that closed at or before the chart bar
 *   closed. On the last chart bar only, when the newest requested bar is still forming
 *   and contains that chart bar, its developing value is used.
 * - With lookahead (higher timeframes only): the requested bar that contains the chart
 *   bar's open, even before it has closed. On history this looks ahead.
 * - With gaps: -1 except on the chart bar where a new requested bar is first used.
 */
export function alignBars(
  chartTime: readonly number[],
  chartCount: number,
  chartMs: number,
  reqTime: readonly number[],
  reqCount: number,
  reqMs: number,
  options: AlignOptions,
  from = 0,
): Int32Array {
  const out = new Int32Array(Math.max(0, chartCount - from));
  const lookahead = options.lookahead && reqMs > chartMs;
  const indexAt = (b: number, developing: boolean): number => {
    const open = chartTime[b];
    if (lookahead) return lastAtOrBefore(reqTime, reqCount, open);
    const close = open + chartMs;
    // Bar j closed by `close` when reqTime[j] + reqMs <= close.
    let j = lastAtOrBefore(reqTime, reqCount, close - reqMs);
    if (developing) {
      const k = j + 1;
      if (k === reqCount - 1 && reqTime[k] <= open && reqTime[k] + reqMs > close) j = k;
    }
    return j;
  };
  let prev = from > 0 ? indexAt(from - 1, false) : -1;
  for (let b = from; b < chartCount; b++) {
    const j = indexAt(b, !options.gaps && b === chartCount - 1);
    out[b - from] = options.gaps && j === prev ? -1 : j;
    prev = j;
  }
  return out;
}

/** One request.security call site: the compiled expression and its own runtime. */
export class SecuritySite {
  /** Value for each chart bar, filled before the chart bar runs. */
  readonly aligned: unknown[] = [];
  private root: Frame | null = null;
  /** Expression value on each requested bar. */
  private readonly values: unknown[] = [];
  private seenKey = '';
  private seenVersion = -1;

  constructor(
    readonly request: SecurityRequest,
    /** Arguments read from inputs; they replace the matching part of `request` on each run. */
    readonly inputArgs: InputArgs | null,
    readonly options: AlignOptions,
    readonly rt: Runtime,
    private readonly layout: FrameLayout,
    private readonly body: (f: Frame) => unknown,
    readonly span: Span,
    /** Number of values when the expression is a literal tuple, otherwise 0. */
    private readonly tupleSize: number,
    /** The expression uses arrays or varip, so it always runs from the first bar. */
    private readonly mutates: boolean,
  ) {}

  /**
   * What the call asks for with the current input values. `chart` is the chart's runtime;
   * a timeframe input that holds the chart's own period means the chart's timeframe.
   */
  current(chart: Runtime): SecurityRequest {
    const args = this.inputArgs;
    if (!args) return this.request;
    const out = { ...this.request };
    if (args.symbol) {
      const v = args.symbol.value(chart);
      if (typeof v !== 'string') throw new ScriptError(NEEDS_CONSTANT, args.symbol.span);
      Object.assign(out, parseRequestSymbol(v));
    }
    if (args.timeframe) {
      const v = args.timeframe.value(chart);
      if (typeof v !== 'string') throw new ScriptError(NEEDS_CONSTANT, args.timeframe.span);
      const text = v.trim();
      if (!text || text === chart.symbol.period) {
        out.timeframe = null;
      } else {
        const tf = requestTimeframe(text);
        if (!tf) throw new ScriptError(timeframeMessage(text), args.timeframe.span);
        out.timeframe = tf;
      }
    }
    return out;
  }

  /** The na of this call: na, or a tuple of na when the expression returns several values. */
  na(): unknown {
    let size = this.tupleSize;
    if (size === 0) {
      const sample = this.values[this.values.length - 1];
      if (sample instanceof Tuple) size = sample.items.length;
    }
    return size > 0 ? new Tuple(new Array(size).fill(NaN)) : NaN;
  }

  /** Forgets earlier results, so the next run starts from the first requested bar. */
  reset(): void {
    this.root = null;
    this.seenKey = '';
    this.seenVersion = -1;
  }

  /**
   * Runs the expression over `bars` (only the changed tail when possible), then fills
   * `aligned` for chart bars `from` to the end. `bars` null means the series is loading.
   */
  update(chart: Runtime, from: number, bars: readonly Candle[] | null, key: string, version: number, ctx: SymbolContext, reqMs: number): void {
    const chartMs = chart.symbol.periodSeconds * 1000;
    const n = chart.count;
    const na = () => this.na();
    if (!bars || bars.length === 0) {
      this.reset();
      this.values.length = 0;
      this.aligned.length = n;
      for (let b = from; b < n; b++) this.aligned[b] = na();
      return;
    }
    if (key !== this.seenKey || version !== this.seenVersion || version < 0) this.evaluate(bars, ctx, key !== this.seenKey);
    this.seenKey = key;
    this.seenVersion = version;
    const map = alignBars(chart.time, n, chartMs, this.rt.time, this.rt.count, reqMs, this.options, from);
    this.aligned.length = n;
    for (let b = from; b < n; b++) {
      const j = map[b - from];
      const v = j >= 0 ? this.values[j] : undefined;
      this.aligned[b] = v === undefined ? na() : v;
    }
  }

  private evaluate(bars: readonly Candle[], ctx: SymbolContext, changedSeries: boolean): void {
    const rt = this.rt;
    const prev = rt.count;
    const m = bars.length;
    const canIncrement =
      !changedSeries &&
      !this.mutates &&
      this.root !== null &&
      prev > 0 &&
      m >= prev &&
      m - prev <= 16 &&
      rt.time[0] === bars[0].timestamp &&
      rt.time[prev - 1] === bars[prev - 1].timestamp;
    let start = 0;
    if (canIncrement) {
      start = prev - 1;
    } else {
      rt.truncate(0);
      this.values.length = 0;
      this.root = new Frame(this.layout, null);
    }
    rt.symbol = ctx;
    for (let i = start; i < m; i++) rt.setBar(i, bars[i]);
    rt.count = m;
    this.values.length = m;
    const root = this.root!;
    for (let b = start; b < m; b++) {
      rt.bar = b;
      rt.runId++;
      rt.loopCount = 0;
      rt.ctl = 0;
      root.enter(rt);
      try {
        if (rt.budget.spend(true)) throw new BudgetError(rt.budget.message(), this.span);
        this.values[b] = this.body(root);
      } catch (e) {
        this.reset();
        if (e instanceof ScriptError) throw e;
        throw new ScriptError(e instanceof Error ? e.message : String(e), this.span);
      }
    }
  }
}

/** Chart bars combined into a higher timeframe, for running a script without a data feed. */
export function resampleBars(bars: readonly Candle[], tf: TimeframeId): Candle[] {
  const data = bars.map((b) => ({ time: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 }));
  return resampleCandles(data, tf).map((c) => ({ timestamp: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
}
