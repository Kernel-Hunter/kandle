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
  loopLimit = 500_000;
  loopCount = 0;

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
