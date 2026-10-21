/**
 * Runtime state shared by the compiled closures of one script instance.
 *
 * Execution is bar by bar. Every stateful thing (variables, built-in indicator state,
 * output buffers) is stored in arrays indexed by bar number, so running the same bar
 * again (a live update of the last candle) overwrites that bar's values instead of
 * stacking on top of them.
 */
import type { Broker } from './strategy';

export interface Candle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface SymbolContext {
  ticker: string;
  /** Chart period in the script's notation: "1", "5", "60", "240", "D", "W". */
  period: string;
  /** Period length in seconds. */
  periodSeconds: number;
  mintick: number;
  /** Data source id of the chart, used to resolve request.security symbols. */
  source?: string;
}

export const DEFAULT_SYMBOL: SymbolContext = { ticker: 'SYMBOL', period: '60', periodSeconds: 3600, mintick: 0.01 };

/** Slot kinds in a frame. */
export const SLOT_PLAIN = 0;
export const SLOT_VAR = 1;
export const SLOT_VARIP = 2;

export interface FrameLayout {
  kinds: number[];
  /** Slots read with the history operator keep one value per bar. */
  history: boolean[];
}

/** Values of one function body (or the main script) for one call site. */
export class Frame {
  readonly vals: unknown[];
  readonly prev: unknown[];
  readonly hist: Array<unknown[] | null>;
  readonly varInitBar: number[];
  /** Per-call-site state of built-ins, nested function calls and history buffers. */
  readonly state: unknown[] = [];
  readonly root: Frame;
  bar = -1;
  runId = -1;

  constructor(
    readonly layout: FrameLayout,
    root: Frame | null,
  ) {
    const n = layout.kinds.length;
    this.vals = new Array(n).fill(NaN);
    this.prev = new Array(n).fill(undefined);
    this.hist = layout.history.map((h) => (h ? [] : null));
    this.varInitBar = new Array(n).fill(-1);
    this.root = root ?? this;
  }

  /** Called whenever execution enters this frame. Rolls values over on a new bar or run. */
  enter(rt: Runtime): void {
    if (this.runId === rt.runId) return;
    const newBar = this.bar !== rt.bar;
    const { kinds } = this.layout;
    const { vals, prev, hist } = this;
    const bar = rt.bar;
    for (let s = 0; s < kinds.length; s++) {
      const kind = kinds[s];
      if (kind === SLOT_VAR) {
        if (newBar) prev[s] = vals[s];
        else vals[s] = prev[s];
      } else if (kind === SLOT_VARIP) {
        if (newBar) prev[s] = vals[s];
      } else {
        vals[s] = NaN;
      }
      const h = hist[s];
      if (h) h[bar] = vals[s];
    }
    this.bar = bar;
    this.runId = rt.runId;
  }
}

/** Loop iterations one bar may run. */
export const LOOP_LIMIT = 100_000;
/** Operations (bars plus loop iterations) one run of a script may use across all its bars. */
export const RUN_BUDGET = 10_000_000;
/** One run may also take at most this long, for work that is slow per operation, such as big arrays. */
export const RUN_TIME_LIMIT_MS = 1000;

/**
 * What one run of a script has spent. The script's runtime and its request.security
 * runtimes share one, so a script cannot get around it by looping inside a request.
 */
export class RunBudget {
  limit = RUN_BUDGET;
  timeLimitMs = RUN_TIME_LIMIT_MS;
  used = 0;
  started = 0;
  private timedOut = false;

  start(): void {
    this.used = 0;
    this.started = performance.now();
    this.timedOut = false;
  }

  /**
   * Counts one operation and returns true once the run is over budget. The clock is read on
   * every bar (`bar`) and every 128 operations, which keeps the count cheap.
   */
  spend(bar = false): boolean {
    if (++this.used > this.limit) return true;
    if ((bar || (this.used & 127) === 0) && performance.now() - this.started > this.timeLimitMs) this.timedOut = true;
    return this.timedOut;
  }

  /** The message for a run that went over budget. */
  message(): string {
    const seconds = Math.max(0.1, (performance.now() - this.started) / 1000).toFixed(1);
    if (this.timedOut) return `Script stopped: it ran for more than ${this.timeLimitMs / 1000} second${this.timeLimitMs === 1000 ? '' : 's'}. Simplify loops and large arrays.`;
    return `Script stopped: it used more than ${this.limit.toLocaleString('en-US')} operations (about ${seconds} seconds). Simplify loops.`;
  }
}

export class Runtime {
  bar = 0;
  runId = 0;
  /** Number of bars currently loaded. */
  count = 0;
  /** 0 normal, 1 break, 2 continue. Set by loop statements, checked by blocks. */
  ctl = 0;
  readonly time: number[] = [];
  readonly open: number[] = [];
  readonly high: number[] = [];
  readonly low: number[] = [];
  readonly close: number[] = [];
  readonly volume: number[] = [];
  symbol: SymbolContext = DEFAULT_SYMBOL;
  /** Input values by input index, already validated. */
  inputValues: unknown[] = [];
  /** True while the last bar is still forming (live data). */
  realtime = false;
  /** Order and position state of a strategy script; null for indicators. */
  strategy: Broker | null = null;
  /** Guards against runaway loops: iterations allowed per bar. */
  loopLimit = LOOP_LIMIT;
  loopCount = 0;
  /** Guards against scripts that keep the browser busy: operations allowed per run. */
  budget = new RunBudget();

  setBar(i: number, c: Candle): void {
    this.time[i] = c.timestamp;
    this.open[i] = c.open;
    this.high[i] = c.high;
    this.low[i] = c.low;
    this.close[i] = c.close;
    this.volume[i] = c.volume ?? NaN;
  }

  truncate(n: number): void {
    for (const a of [this.time, this.open, this.high, this.low, this.close, this.volume]) a.length = n;
  }
}
