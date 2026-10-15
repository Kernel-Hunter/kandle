/**
 * Turns the syntax tree into a tree of small JavaScript closures. Each closure takes the
 * frame it runs in and returns a value. Names are resolved to slots at compile time, so
 * running a bar does no lookups by name.
 */
import type { Arg, Expr, Program, Stmt, TypeRef } from './ast';
import { BuiltinError, CONSTANTS, FUNCTIONS, KNOWN_UNSUPPORTED_NAMESPACES, VARIABLES, num, type BuiltinFunction } from './builtins/registry';
import './builtins/core';
import './builtins/ta';
import './builtins/strategy';
import { ScriptError, type Span } from './errors';
import { PLOT_PALETTE, SHAPE_SIZES, emptyOutputs, type BarColorOutput, type FillOutput, type HlineOutput, type Outputs, type PlotOutput, type ShapeOutput } from './outputs';
import { Frame, Runtime, SLOT_PLAIN, SLOT_VAR, SLOT_VARIP, type FrameLayout } from './runtime';
import { Broker, DEFAULT_STRATEGY, type CommissionType, type QtyType, type StrategyConfig } from './strategy';
import { Color, PlotHandle, ScriptArray, Tuple, isNa, truthy, valuesEqual, typeName } from './values';

export type InputType = 'int' | 'float' | 'bool' | 'string' | 'source' | 'color';
export type InputValue = number | boolean | string;

export interface InputDef {
  index: number;
  /** Stable key used to store the user's value: the title, or "input N". */
  key: string;
  title: string;
  type: InputType;
  defval: InputValue;
  minval?: number;
  maxval?: number;
  step?: number;
  options?: InputValue[];
  tooltip?: string;
  group?: string;
}

export interface ScriptMeta {
  title: string;
  shortTitle: string;
  overlay: boolean;
  precision: number | null;
  format: string | null;
  version: number | null;
  /** Broker settings when the script is declared with strategy(). */
  strategy: StrategyConfig | null;
}

/** Built-in series that can be read with history and chosen by input.source. */
export const SOURCE_SERIES: Record<string, (rt: Runtime, i: number) => number> = {
  open: (rt, i) => rt.open[i],
  high: (rt, i) => rt.high[i],
  low: (rt, i) => rt.low[i],
  close: (rt, i) => rt.close[i],
  volume: (rt, i) => rt.volume[i],
  hl2: (rt, i) => (rt.high[i] + rt.low[i]) / 2,
  hlc3: (rt, i) => (rt.high[i] + rt.low[i] + rt.close[i]) / 3,
  ohlc4: (rt, i) => (rt.open[i] + rt.high[i] + rt.low[i] + rt.close[i]) / 4,
  hlcc4: (rt, i) => (rt.high[i] + rt.low[i] + 2 * rt.close[i]) / 4,
};
const HISTORY_SERIES: Record<string, (rt: Runtime, i: number) => number> = {
  ...SOURCE_SERIES,
  time: (rt, i) => rt.time[i],
  bar_index: (_rt, i) => i,
};

type Fn = (f: Frame) => unknown;

interface FnCtx {
  kinds: number[];
  history: boolean[];
  stateCount: number;
  global: boolean;
}

interface VarInfo {
  slot: number;
  ctx: FnCtx;
  type: TypeRef | null;
  name: string;
}

class Scope {
  readonly vars = new Map<string, VarInfo>();
  constructor(readonly parent: Scope | null) {}
  lookup(name: string): VarInfo | undefined {
    for (let s: Scope | null = this; s; s = s.parent) {
      const v = s.vars.get(name);
      if (v) return v;
    }
    return undefined;
  }
}

interface UserFunction {
  name: string;
  params: Array<{ name: string; slot: number; defaultValue: Fn | null }>;
  layout: FrameLayout;
  body: Fn;
  isMethod: boolean;
}

const NOT_CONST = Symbol('not-const');
class SourceRef {
  constructor(readonly name: string) {}
}

const INPUT_PARAMS: Record<string, string[]> = {
  int: ['defval', 'title', 'minval', 'maxval', 'step', 'tooltip', 'inline', 'group', 'confirm', 'options', 'display', 'active'],
  float: ['defval', 'title', 'minval', 'maxval', 'step', 'tooltip', 'inline', 'group', 'confirm', 'options', 'display', 'active'],
  bool: ['defval', 'title', 'tooltip', 'inline', 'group', 'confirm', 'display', 'active'],
  string: ['defval', 'title', 'options', 'tooltip', 'inline', 'group', 'confirm', 'display', 'active'],
  source: ['defval', 'title', 'tooltip', 'inline', 'group', 'display', 'active'],
  color: ['defval', 'title', 'tooltip', 'inline', 'group', 'confirm', 'display', 'active'],
  price: ['defval', 'title', 'tooltip', 'inline', 'group', 'confirm', 'display', 'active'],
  text_area: ['defval', 'title', 'tooltip', 'group', 'confirm', 'display', 'active'],
  timeframe: ['defval', 'title', 'options', 'tooltip', 'inline', 'group', 'confirm', 'display', 'active'],
  generic: ['defval', 'title', 'tooltip', 'inline', 'group'],
};

const OUTPUT_PARAMS: Record<string, string[]> = {
  plot: ['series', 'title', 'color', 'linewidth', 'style', 'trackprice', 'histbase', 'offset', 'join', 'editable', 'show_last', 'display', 'format', 'precision', 'force_overlay', 'linestyle'],
  plotshape: ['series', 'title', 'style', 'location', 'color', 'offset', 'text', 'textcolor', 'editable', 'size', 'show_last', 'display', 'format', 'precision', 'force_overlay'],
  plotchar: ['series', 'title', 'char', 'location', 'color', 'offset', 'text', 'textcolor', 'editable', 'size', 'show_last', 'display', 'format', 'precision', 'force_overlay'],
  hline: ['price', 'title', 'color', 'linestyle', 'linewidth', 'editable', 'display'],
  fill: ['plot1', 'plot2', 'color', 'title', 'editable', 'show_last', 'fillgaps', 'display'],
  bgcolor: ['color', 'offset', 'editable', 'show_last', 'title', 'display', 'force_overlay'],
  barcolor: ['color', 'offset', 'editable', 'show_last', 'title', 'display'],
};

const INDICATOR_PARAMS = [
  'title',
  'shorttitle',
  'overlay',
  'format',
  'precision',
  'scale',
  'max_bars_back',
  'timeframe',
  'timeframe_gaps',
  'explicit_plot_zorder',
  'max_lines_count',
  'max_labels_count',
  'max_boxes_count',
  'calc_bars_count',
  'max_polylines_count',
  'dynamic_requests',
  'behind_chart',
];

/** strategy() takes the indicator() parameters plus the broker settings, in this order. */
const STRATEGY_PARAMS = [
  'title',
  'shorttitle',
  'overlay',
  'format',
  'precision',
  'scale',
  'pyramiding',
  'calc_on_order_fills',
  'calc_on_every_tick',
  'max_bars_back',
  'backtest_fill_limits_assumption',
  'default_qty_type',
  'default_qty_value',
  'initial_capital',
  'currency',
  'slippage',
  'commission_type',
  'commission_value',
  'process_orders_on_close',
  'close_entries_rule',
  'margin_long',
  'margin_short',
  'explicit_plot_zorder',
  'max_lines_count',
  'max_labels_count',
  'max_boxes_count',
  'calc_bars_count',
  'risk_free_rate',
  'use_bar_magnifier',
  'fill_orders_on_standard_ohlc',
  'max_polylines_count',
  'dynamic_requests',
  'behind_chart',
];

const QTY_TYPES: readonly QtyType[] = ['fixed', 'cash', 'percent_of_equity'];
const COMMISSION_TYPES: readonly CommissionType[] = ['percent', 'cash_per_contract', 'cash_per_order'];

const UNSUPPORTED_CALLS = new Set(['plotcandle', 'plotbar', 'plotarrow', 'study', 'library', 'max_bars_back', 'alert', 'runtime.error']);

const cssOf = (v: unknown): string | null => (v instanceof Color ? v.css() : null);

function wrapError(e: unknown, span: Span): ScriptError {
  if (e instanceof ScriptError) return e;
  if (e instanceof BuiltinError) return new ScriptError(e.message, span);
  const message = e instanceof Error ? e.message : String(e);
  return new ScriptError(`Internal error: ${message}`, span);
}

const histAt = (h: unknown[] | null, i: number): unknown => {
  if (!h || i < 0) return NaN;
  const v = h[i];
  return v === undefined ? NaN : v;
};

function binaryOp(op: string): (a: unknown, b: unknown) => unknown {
  switch (op) {
    case '+':
      return (a, b) => {
        if (typeof a === 'number' && typeof b === 'number') return a + b;
        if (typeof a === 'string' || typeof b === 'string') {
          if (isNa(a) || isNa(b)) return null;
          return String(a) + String(b);
        }
        return num(a) + num(b);
      };
    case '-':
      return (a, b) => num(a) - num(b);
    case '*':
      return (a, b) => num(a) * num(b);
    case '/':
      return (a, b) => {
        const d = num(b);
        return d === 0 ? NaN : num(a) / d;
      };
    case '%':
      return (a, b) => {
        const d = num(b);
        return d === 0 ? NaN : num(a) % d;
      };
    case '<':
      return (a, b) => (typeof a === 'string' && typeof b === 'string' ? a < b : num(a) < num(b));
    case '<=':
      return (a, b) => (typeof a === 'string' && typeof b === 'string' ? a <= b : num(a) <= num(b));
    case '>':
      return (a, b) => (typeof a === 'string' && typeof b === 'string' ? a > b : num(a) > num(b));
    case '>=':
      return (a, b) => (typeof a === 'string' && typeof b === 'string' ? a >= b : num(a) >= num(b));
    case '==':
      return (a, b) => valuesEqual(a, b);
    case '!=':
      return (a, b) => !valuesEqual(a, b);
  }
  throw new Error(`Unknown operator ${op}`);
}

function coerce(type: TypeRef | null): ((v: unknown) => unknown) | null {
  if (!type || type.isArray) return null;
  switch (type.name) {
    case 'int':
      return (v) => (typeof v === 'number' ? (v !== v ? NaN : Math.trunc(v)) : typeof v === 'boolean' ? (v ? 1 : 0) : v);
    case 'float':
      return (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v);
    case 'bool':
      return (v) => truthy(v);
    case 'color':
      return (v) => (v instanceof Color ? v : null);
    case 'string':
      return (v) => (typeof v === 'string' ? v : isNa(v) ? null : v);
  }
  return null;
}

/** A compiled script, ready to run on candles. One instance per chart indicator. */
export interface CompiledScript {
  meta: ScriptMeta;
  inputs: InputDef[];
  outputs: Outputs;
  rt: Runtime;
  /** Uses arrays or varip, so live updates of the last bar must recompute from the start. */
  mutatesState: boolean;
  newRootFrame(): Frame;
  body: Fn;
}

export class Compiler {
  readonly rt = new Runtime();
  readonly outputs: Outputs = emptyOutputs();
  readonly inputs: InputDef[] = [];
  private meta: ScriptMeta = { title: 'Script', shortTitle: 'Script', overlay: false, precision: null, format: null, version: null, strategy: null };
  private sawDeclaration = false;
  /** First use of a strategy.* function or variable, checked once the whole script is compiled. */
  private strategyUse: { name: string; span: Span } | null = null;
  private readonly functions = new Map<string, UserFunction>();
  private mutatesState = false;
  private fc: FnCtx = { kinds: [], history: [], stateCount: 0, global: true };
  private readonly globalCtx = this.fc;
  private readonly globalScope = new Scope(null);
  private scope = this.globalScope;
  private loopDepth = 0;
  private compilingFunction: string | null = null;
  private paletteIndex = 0;

  compile(program: Program): CompiledScript {
    this.meta.version = program.version;
    const body = this.block(program.body, false);
    if (this.strategyUse && !this.meta.strategy) {
      throw new ScriptError(`'${this.strategyUse.name}' can only be used in a script declared with strategy()`, this.strategyUse.span);
    }
    const layout: FrameLayout = { kinds: this.globalCtx.kinds, history: this.globalCtx.history };
    return {
      meta: this.meta,
      inputs: this.inputs,
      outputs: this.outputs,
      rt: this.rt,
      mutatesState: this.mutatesState,
      newRootFrame: () => new Frame(layout, null),
      body,
    };
  }

  // ------------------------------------------------------------------ scopes and slots

  private declare(name: string, kind: number, type: TypeRef | null, span: Span): VarInfo {
    if (name === '_') return { slot: this.newSlot(kind), ctx: this.fc, type, name };
    if (this.scope.vars.has(name)) throw new ScriptError(`'${name}' is already declared in this scope; use := to change it`, span);
    const info: VarInfo = { slot: this.newSlot(kind), ctx: this.fc, type, name };
    this.scope.vars.set(name, info);
    return info;
  }

  private newSlot(kind: number): number {
    this.fc.kinds.push(kind);
    this.fc.history.push(false);
    return this.fc.kinds.length - 1;
  }

  private lookup(name: string): VarInfo | undefined {
    return this.scope.lookup(name);
  }

  private withScope<T>(fn: () => T): T {
    const saved = this.scope;
    this.scope = new Scope(saved);
    try {
      return fn();
    } finally {
      this.scope = saved;
    }
  }

  private isGlobalScope(): boolean {
    return this.fc.global && this.scope === this.globalScope;
  }

  /** Reads a variable from the frame that owns it. */
  private reader(info: VarInfo): Fn {
    const slot = info.slot;
    if (info.ctx === this.fc) return (f) => f.vals[slot];
    return (f) => f.root.vals[slot];
  }

  private writer(info: VarInfo, span: Span): (f: Frame, v: unknown) => void {
    if (info.ctx !== this.fc) throw new ScriptError(`Cannot change the global variable '${info.name}' inside a function`, span);
    const slot = info.slot;
    const rt = this.rt;
    const c = coerce(info.type);
    if (c) {
      return (f, v) => {
        const x = c(v);
        f.vals[slot] = x;
        const h = f.hist[slot];
        if (h) h[rt.bar] = x;
      };
    }
    return (f, v) => {
      f.vals[slot] = v;
      const h = f.hist[slot];
      if (h) h[rt.bar] = v;
    };
  }

  // ------------------------------------------------------------------ statements

  private block(stmts: Stmt[], scoped = true): Fn {
    const compileAll = () => stmts.map((s) => this.statement(s));
    const fns = scoped ? this.withScope(compileAll) : compileAll();
    const rt = this.rt;
    if (fns.length === 1) return fns[0];
    return (f) => {
      let v: unknown = NaN;
      for (let i = 0; i < fns.length; i++) {
        v = fns[i](f);
        if (rt.ctl !== 0) return v;
      }
      return v;
    };
  }

  private statement(s: Stmt): Fn {
    switch (s.kind) {
      case 'expr':
        return this.expr(s.expr);
      case 'decl':
        return this.declaration(s);
      case 'tupledecl':
        return this.tupleDeclaration(s);
      case 'assign':
        return this.assignment(s);
      case 'func':
        this.defineFunction(s);
        return () => NaN;
      case 'break':
      case 'continue': {
        if (this.loopDepth === 0) throw new ScriptError(`'${s.kind}' can only be used inside a loop`, s.span);
        const rt = this.rt;
        const code = s.kind === 'break' ? 1 : 2;
        return () => {
          rt.ctl = code;
          return NaN;
        };
      }
    }
  }

  private declaration(s: Extract<Stmt, { kind: 'decl' }>): Fn {
    const value = this.expr(s.value);
    const kind = s.mode === 'var' ? SLOT_VAR : s.mode === 'varip' ? SLOT_VARIP : SLOT_PLAIN;
    if (kind === SLOT_VARIP) this.mutatesState = true;
    const info = this.declare(s.name, kind, s.type, s.nameSpan);
    const write = this.writer(info, s.nameSpan);
    const slot = info.slot;
    const rt = this.rt;
    if (kind === SLOT_PLAIN) {
      return (f) => {
        const v = value(f);
        if (v instanceof Tuple) throw new ScriptError(`This returns ${v.items.length} values; use [a, b] = ... to receive them`, s.span);
        write(f, v);
        return f.vals[slot];
      };
    }
    return (f) => {
      const init = f.varInitBar[slot];
      if (init === -1 || init === rt.bar) {
        write(f, value(f));
        f.varInitBar[slot] = rt.bar;
      }
      return f.vals[slot];
    };
  }

  private tupleDeclaration(s: Extract<Stmt, { kind: 'tupledecl' }>): Fn {
    const value = this.expr(s.value);
    const writers = s.names.map((n) => {
      const info = this.declare(n.name, SLOT_PLAIN, null, n.span);
      return n.name === '_' ? null : this.writer(info, n.span);
    });
    return (f) => {
      const v = value(f);
      if (!(v instanceof Tuple)) throw new ScriptError(`Expected ${writers.length} values on the right side but got one ${typeName(v)}`, s.span);
      if (v.items.length < writers.length) throw new ScriptError(`Expected ${writers.length} values but got ${v.items.length}`, s.span);
      for (let i = 0; i < writers.length; i++) writers[i]?.(f, v.items[i]);
      return NaN;
    };
  }

  private assignment(s: Extract<Stmt, { kind: 'assign' }>): Fn {
    const info = this.lookup(s.name);
    if (!info) throw new ScriptError(`'${s.name}' is not declared yet; use = to declare it`, s.nameSpan);
    const write = this.writer(info, s.nameSpan);
    const read = this.reader(info);
    const value = this.expr(s.value);
    if (s.op === ':=') {
      return (f) => {
        const v = value(f);
        write(f, v);
        return v;
      };
    }
    const op = binaryOp(s.op[0]);
    return (f) => {
      const v = op(read(f), value(f));
      write(f, v);
      return v;
    };
  }

  private defineFunction(s: Extract<Stmt, { kind: 'func' }>): void {
    if (this.functions.has(s.name)) throw new ScriptError(`Function '${s.name}' is already declared`, s.span);
    const savedFc = this.fc;
    const savedScope = this.scope;
    const savedLoop = this.loopDepth;
    this.fc = { kinds: [], history: [], stateCount: 0, global: false };
    this.scope = new Scope(this.globalScope);
    this.loopDepth = 0;
    this.compilingFunction = s.name;
    try {
      const params = s.params.map((p) => {
        const info = this.declare(p.name, SLOT_PLAIN, p.type, p.span);
        let defaultValue: Fn | null = null;
        if (p.defaultValue) {
          // Defaults must be constants, so they can be evaluated in any caller.
          const v = this.requireConst(p.defaultValue, `The default value of '${p.name}'`);
          const value = v instanceof SourceRef ? NaN : v;
          defaultValue = () => value;
        }
        return { name: p.name, slot: info.slot, defaultValue };
      });
      const body = this.block(s.body, false);
      const layout: FrameLayout = { kinds: this.fc.kinds, history: this.fc.history };
      this.functions.set(s.name, {
        name: s.name,
        params,
        layout,
        body,
        isMethod: s.isMethod,
      });
    } finally {
      this.fc = savedFc;
      this.scope = savedScope;
      this.loopDepth = savedLoop;
      this.compilingFunction = null;
    }
  }

  // ------------------------------------------------------------------ expressions

  private expr(e: Expr): Fn {
    switch (e.kind) {
      case 'num': {
        const v = e.value;
        return () => v;
      }
      case 'str': {
        const v = e.value;
        return () => v;
      }
      case 'bool': {
        const v = e.value;
        return () => v;
      }
      case 'na':
        return () => NaN;
      case 'color': {
        const c = Color.fromHex(e.hex);
        return () => c;
      }
      case 'ident':
        return this.identifier(e.name, e.span);
      case 'member':
        return this.member(e);
      case 'call':
        return this.call(e);
      case 'index':
        return this.history(e);
      case 'unary': {
        const operand = this.expr(e.operand);
        if (e.op === 'not') return (f) => !truthy(operand(f));
        if (e.op === '-') return (f) => -num(operand(f));
        return (f) => num(operand(f));
      }
      case 'binary':
        return this.binary(e);
      case 'ternary': {
        const c = this.expr(e.cond);
        const a = this.expr(e.then);
        const b = this.expr(e.else);
        return (f) => (truthy(c(f)) ? a(f) : b(f));
      }
      case 'tuple': {
        const items = e.items.map((x) => this.expr(x));
        return (f) => new Tuple(items.map((x) => x(f)));
      }
      case 'if':
        return this.ifExpr(e);
      case 'switch':
        return this.switchExpr(e);
      case 'for':
        return this.forExpr(e);
      case 'forin':
        return this.forInExpr(e);
      case 'while':
        return this.whileExpr(e);
    }
  }

  private binary(e: Extract<Expr, { kind: 'binary' }>): Fn {
    const l = this.expr(e.left);
    const r = this.expr(e.right);
    if (e.op === 'and') return (f) => truthy(l(f)) && truthy(r(f));
    if (e.op === 'or') return (f) => truthy(l(f)) || truthy(r(f));
    switch (e.op) {
      case '+':
        return (f) => {
          const a = l(f);
          const b = r(f);
          if (typeof a === 'number' && typeof b === 'number') return a + b;
          return binaryOp('+')(a, b);
        };
      case '-':
        return (f) => num(l(f)) - num(r(f));
      case '*':
        return (f) => num(l(f)) * num(r(f));
      case '>':
        return (f) => {
          const a = l(f);
          const b = r(f);
          return typeof a === 'number' && typeof b === 'number' ? a > b : (binaryOp('>')(a, b) as boolean);
        };
      case '<':
        return (f) => {
          const a = l(f);
          const b = r(f);
          return typeof a === 'number' && typeof b === 'number' ? a < b : (binaryOp('<')(a, b) as boolean);
        };
    }
    const op = binaryOp(e.op);
    return (f) => op(l(f), r(f));
  }

  private identifier(name: string, span: Span): Fn {
    const info = this.lookup(name);
    if (info) return this.reader(info);
    const getter = VARIABLES.get(name);
    if (getter) {
      this.noteStrategyUse(name, span);
      const rt = this.rt;
      return () => getter(rt);
    }
    if (CONSTANTS.has(name)) {
      const v = CONSTANTS.get(name);
      return () => v;
    }
    if (this.functions.has(name) || FUNCTIONS.has(name)) throw new ScriptError(`'${name}' is a function; call it with parentheses`, span);
    throw new ScriptError(`Unknown variable '${name}'`, span);
  }

  /** "ta.sma" for a chain of plain names that are not variables, otherwise null. */
  private dottedName(e: Expr): string | null {
    if (e.kind === 'ident') return this.lookup(e.name) ? null : e.name;
    if (e.kind === 'member') {
      const base = this.dottedName(e.object);
      return base === null ? null : `${base}.${e.name}`;
    }
    return null;
  }

  private member(e: Extract<Expr, { kind: 'member' }>): Fn {
    const name = this.dottedName(e);
    if (name !== null) {
      if (CONSTANTS.has(name)) {
        const v = CONSTANTS.get(name);
        return () => v;
      }
      const getter = VARIABLES.get(name);
      if (getter) {
        this.noteStrategyUse(name, e.span);
        const rt = this.rt;
        return () => getter(rt);
      }
      const builtin = FUNCTIONS.get(name);
      if (builtin?.asVariable) return this.builtinCall(name, builtin, [], e.span);
      if (builtin) throw new ScriptError(`'${name}' is a function; call it with parentheses`, e.span);
      throw this.unknown(name, e.span, false);
    }
    throw new ScriptError(`Fields like '.${e.name}' are not supported yet`, e.span);
  }

  private noteStrategyUse(name: string, span: Span): void {
    if (!this.strategyUse && name.startsWith('strategy.')) this.strategyUse = { name, span };
  }

  private unknown(name: string, span: Span, isCall: boolean): ScriptError {
    const ns = name.includes('.') ? name.slice(0, name.indexOf('.')) : null;
    if (ns && (KNOWN_UNSUPPORTED_NAMESPACES.has(ns) || ['ta', 'math', 'str', 'color', 'array', 'input', 'timeframe', 'syminfo', 'barstate', 'plot', 'shape', 'location', 'size', 'display', 'format', 'hline', 'strategy'].includes(ns))) {
      return new ScriptError(`'${name}' is not supported yet`, span);
    }
    if (UNSUPPORTED_CALLS.has(name)) return new ScriptError(`'${name}' is not supported yet`, span);
    return new ScriptError(isCall ? `Unknown function '${name}' (it may not be supported yet)` : `Unknown name '${name}'`, span);
  }

  private history(e: Extract<Expr, { kind: 'index' }>): Fn {
    const offset = this.expr(e.index);
    const rt = this.rt;
    const getOffset = (f: Frame): number => {
      const n = num(offset(f));
      if (n < 0) throw new ScriptError('History offsets cannot be negative', e.index.span);
      return Math.floor(n);
    };
    const obj = e.object;
    if (obj.kind === 'ident') {
      const info = this.lookup(obj.name);
      if (info) {
        info.ctx.history[info.slot] = true;
        const slot = info.slot;
        if (info.ctx === this.fc) return (f) => histAt(f.hist[slot], rt.bar - getOffset(f));
        return (f) => histAt(f.root.hist[slot], rt.bar - getOffset(f));
      }
      const series = HISTORY_SERIES[obj.name];
      if (series) {
        return (f) => {
          const i = rt.bar - getOffset(f);
          return i < 0 || i >= rt.count ? NaN : series(rt, i);
        };
      }
    }
    // Any other expression: keep its value for every bar at this call site.
    const value = this.expr(obj);
    const idx = this.fc.stateCount++;
    return (f) => {
      let buf = f.state[idx] as unknown[] | undefined;
      if (!buf) buf = f.state[idx] = [];
      buf[rt.bar] = value(f);
      return histAt(buf, rt.bar - getOffset(f));
    };
  }

  // ------------------------------------------------------------------ control flow

  private ifExpr(e: Extract<Expr, { kind: 'if' }>): Fn {
    const cond = this.expr(e.cond);
    const then = this.block(e.then);
    const otherwise = e.else ? this.block(e.else) : null;
    if (otherwise) return (f) => (truthy(cond(f)) ? then(f) : otherwise(f));
    return (f) => (truthy(cond(f)) ? then(f) : NaN);
  }

  private switchExpr(e: Extract<Expr, { kind: 'switch' }>): Fn {
    const subject = e.subject ? this.expr(e.subject) : null;
    const cases = e.cases.map((c) => ({ match: c.match ? this.expr(c.match) : null, body: this.block(c.body) }));
    return (f) => {
      const s = subject ? subject(f) : undefined;
      for (const c of cases) {
        if (!c.match) return c.body(f);
        const m = c.match(f);
        if (subject ? valuesEqual(s, m) : truthy(m)) return c.body(f);
      }
      return NaN;
    };
  }

  private loopGuard(span: Span): () => void {
    const rt = this.rt;
    return () => {
      if (++rt.loopCount > rt.loopLimit) throw new ScriptError('Loop ran too many times on one bar; check its exit condition', span);
    };
  }

  private forExpr(e: Extract<Expr, { kind: 'for' }>): Fn {
    const from = this.expr(e.from);
    const to = this.expr(e.to);
    const step = e.step ? this.expr(e.step) : null;
    const rt = this.rt;
    const guard = this.loopGuard(e.span);
    return this.withScope(() => {
      const info = this.declare(e.varName, SLOT_PLAIN, null, e.varSpan);
      const write = this.writer(info, e.varSpan);
      this.loopDepth++;
      const body = this.block(e.body);
      this.loopDepth--;
      return (f: Frame) => {
        const a = num(from(f));
        const b = num(to(f));
        const s = step ? Math.abs(num(step(f))) : 1;
        if (a !== a || b !== b || s !== s) return NaN;
        if (s === 0) throw new ScriptError('A for loop step cannot be 0', e.span);
        const dir = a <= b ? 1 : -1;
        let v: unknown = NaN;
        for (let i = a; dir > 0 ? i <= b : i >= b; i += dir * s) {
          guard();
          write(f, i);
          v = body(f);
          if (rt.ctl === 1) {
            rt.ctl = 0;
            break;
          }
          if (rt.ctl === 2) rt.ctl = 0;
        }
        return v;
      };
    });
  }

  private forInExpr(e: Extract<Expr, { kind: 'forin' }>): Fn {
    const iterable = this.expr(e.iterable);
    const rt = this.rt;
    const guard = this.loopGuard(e.span);
    return this.withScope(() => {
      const indexWrite = e.indexName ? this.writer(this.declare(e.indexName, SLOT_PLAIN, null, e.span), e.span) : null;
      const write = this.writer(this.declare(e.varName, SLOT_PLAIN, null, e.varSpan), e.varSpan);
      this.loopDepth++;
      const body = this.block(e.body);
      this.loopDepth--;
      return (f: Frame) => {
        const it = iterable(f);
        const items = it instanceof ScriptArray ? it.items : it instanceof Tuple ? it.items : null;
        if (!items) throw new ScriptError('for ... in needs an array', e.iterable.span);
        let v: unknown = NaN;
        for (let i = 0; i < items.length; i++) {
          guard();
          indexWrite?.(f, i);
          write(f, items[i]);
          v = body(f);
          if (rt.ctl === 1) {
            rt.ctl = 0;
            break;
          }
          if (rt.ctl === 2) rt.ctl = 0;
        }
        return v;
      };
    });
  }

  private whileExpr(e: Extract<Expr, { kind: 'while' }>): Fn {
    const cond = this.expr(e.cond);
    const rt = this.rt;
    const guard = this.loopGuard(e.span);
    this.loopDepth++;
    const body = this.block(e.body);
    this.loopDepth--;
    return (f) => {
      let v: unknown = NaN;
      while (truthy(cond(f))) {
        guard();
        v = body(f);
        if (rt.ctl === 1) {
          rt.ctl = 0;
          break;
        }
        if (rt.ctl === 2) rt.ctl = 0;
      }
      return v;
    };
  }

  // ------------------------------------------------------------------ calls

  private call(e: Extract<Expr, { kind: 'call' }>): Fn {
    const callee = e.callee;
    // Method call on a value: x.f(...)
    if (callee.kind === 'member' && this.dottedName(callee) === null) {
      return this.methodCall(callee.object, callee.name, e.args, e.span);
    }
    let name = callee.kind === 'na' ? 'na' : this.dottedName(callee);
    if (name === null) throw new ScriptError('This expression cannot be called', callee.span);
    if (e.generic && name === 'array.new') name = `array.new_${e.generic}`;

    // User functions shadow built-ins with the same name.
    const user = this.functions.get(name);
    if (user) return this.userCall(user, e.args, e.span, null);
    if (name === this.compilingFunction) throw new ScriptError(`'${name}' cannot call itself; recursion is not supported`, callee.span);

    if (name === 'indicator' || name === 'strategy') return this.declarationCall(name, e.args, e.span);
    if (name === 'input' || name.startsWith('input.')) return this.inputCall(name, e.args, e.span);
    if (name in OUTPUT_PARAMS) return this.outputCall(name, e.args, e.span);

    const builtin = FUNCTIONS.get(name);
    if (builtin) return this.builtinCall(name, builtin, e.args, e.span);
    // close.myMethod(): a user method called on a built-in series.
    if (callee.kind === 'member' && this.functions.get(callee.name)?.isMethod) {
      return this.methodCall(callee.object, callee.name, e.args, e.span);
    }
    throw this.unknown(name, callee.span, true);
  }

  private bindArgs(name: string, params: string[], required: number, variadic: boolean, args: Arg[], span: Span): Array<Expr | undefined> {
    const out: Array<Expr | undefined> = new Array(params.length).fill(undefined);
    let positional = 0;
    for (const a of args) {
      if (a.name === null) {
        if (positional >= params.length && !variadic) {
          throw new ScriptError(`'${name}' takes at most ${params.length} argument${params.length === 1 ? '' : 's'}`, a.span);
        }
        out[positional++] = a.value;
      } else {
        const i = params.indexOf(a.name);
        if (i < 0) throw new ScriptError(`'${name}' has no parameter named '${a.name}'`, a.span);
        if (out[i] !== undefined) throw new ScriptError(`'${a.name}' is given twice`, a.span);
        out[i] = a.value;
      }
    }
    for (let i = 0; i < required; i++) {
      if (out[i] === undefined) throw new ScriptError(`'${name}' needs the '${params[i]}' argument`, span);
    }
    return out;
  }

  private builtinCall(name: string, def: BuiltinFunction, rawArgs: Arg[], span: Span): Fn {
    let args = rawArgs;
    if (def.implicitSource) {
      const positional = args.filter((a) => a.name === null).length;
      const named = args.some((a) => a.name === 'source');
      if (!named && positional === def.params.length - 1 && args.every((a) => a.name === null)) {
        args = [{ name: null, value: { kind: 'ident', name: def.implicitSource, span }, span }, ...args];
      }
    }
    const bound = this.bindArgs(name, def.params, def.required, !!def.variadic, args, span);
    const fns = bound.map((x) => (x ? this.expr(x) : null));
    this.noteStrategyUse(name, span);
    if (def.mutates) this.mutatesState = true;
    const rt = this.rt;
    const n = fns.length;
    const call = def.call;
    if (def.variadic) {
      // Trim trailing missing arguments so math.max(a, b) sees two values.
      return (f) => {
        const vals: unknown[] = [];
        for (let i = 0; i < n; i++) {
          const g = fns[i];
          if (g) vals.push(g(f));
        }
        try {
          return call(vals, undefined, rt);
        } catch (err) {
          throw wrapError(err, span);
        }
      };
    }
    const vals: unknown[] = new Array(n);
    if (def.init) {
      const idx = this.fc.stateCount++;
      const init = def.init;
      return (f) => {
        for (let i = 0; i < n; i++) {
          const g = fns[i];
          vals[i] = g ? g(f) : undefined;
        }
        let st = f.state[idx];
        if (st === undefined) st = f.state[idx] = init();
        try {
          return call(vals, st, rt);
        } catch (err) {
          throw wrapError(err, span);
        }
      };
    }
    return (f) => {
      for (let i = 0; i < n; i++) {
        const g = fns[i];
        vals[i] = g ? g(f) : undefined;
      }
      try {
        return call(vals, undefined, rt);
      } catch (err) {
        throw wrapError(err, span);
      }
    };
  }

  private userCall(fnInfo: UserFunction, rawArgs: Arg[], span: Span, receiver: Expr | null): Fn {
    const params = fnInfo.params.map((p) => p.name);
    const args = receiver ? [{ name: null, value: receiver, span: receiver.span }, ...rawArgs] : rawArgs;
    const bound = this.bindArgs(fnInfo.name, params, 0, false, args, span);
    bound.forEach((b, i) => {
      if (b === undefined && !fnInfo.params[i].defaultValue) {
        throw new ScriptError(`'${fnInfo.name}' needs the '${params[i]}' argument`, span);
      }
    });
    const fns = bound.map((b, i) => (b ? this.expr(b) : (fnInfo.params[i].defaultValue as Fn)));
    const slots = fnInfo.params.map((p) => p.slot);
    const idx = this.fc.stateCount++;
    const rt = this.rt;
    const layout = fnInfo.layout;
    const body = fnInfo.body;
    const vals: unknown[] = new Array(fns.length);
    return (f) => {
      for (let i = 0; i < fns.length; i++) vals[i] = fns[i](f);
      let child = f.state[idx] as Frame | undefined;
      if (!child) child = f.state[idx] = new Frame(layout, f.root);
      child.enter(rt);
      for (let i = 0; i < slots.length; i++) {
        const s = slots[i];
        child.vals[s] = vals[i];
        const h = child.hist[s];
        if (h) h[rt.bar] = vals[i];
      }
      const ctl = rt.ctl;
      rt.ctl = 0;
      try {
        return body(child);
      } finally {
        rt.ctl = ctl;
      }
    };
  }

  private methodCall(object: Expr, method: string, args: Arg[], span: Span): Fn {
    const user = this.functions.get(method);
    if (user?.isMethod) return this.userCall(user, args, span, object);
    const arrayFn = FUNCTIONS.get(`array.${method}`);
    const strFn = FUNCTIONS.get(`str.${method}`);
    if (!arrayFn && !strFn) throw new ScriptError(`Unknown method '${method}'`, span);
    const withReceiver: Arg[] = [{ name: null, value: object, span: object.span }, ...args];
    const viaArray = arrayFn ? this.builtinCall(`array.${method}`, arrayFn, withReceiver, span) : null;
    const viaStr = strFn ? this.builtinCall(`str.${method}`, strFn, withReceiver, span) : null;
    if (viaArray && !viaStr) return viaArray;
    if (viaStr && !viaArray) return viaStr;
    const recv = this.expr(object);
    return (f) => (recv(f) instanceof ScriptArray ? viaArray!(f) : viaStr!(f));
  }

  // ------------------------------------------------------------------ constants

  private constEval(e: Expr): unknown {
    switch (e.kind) {
      case 'num':
      case 'str':
      case 'bool':
        return e.value;
      case 'na':
        return NaN;
      case 'color':
        return Color.fromHex(e.hex);
      case 'unary': {
        const v = this.constEval(e.operand);
        if (v === NOT_CONST) return NOT_CONST;
        if (e.op === '-') return -num(v);
        if (e.op === 'not') return !truthy(v);
        return v;
      }
      case 'binary': {
        if (e.op === 'and' || e.op === 'or') return NOT_CONST;
        const a = this.constEval(e.left);
        const b = this.constEval(e.right);
        if (a === NOT_CONST || b === NOT_CONST) return NOT_CONST;
        return binaryOp(e.op)(a, b);
      }
      case 'ident':
        if (this.lookup(e.name)) return NOT_CONST;
        if (e.name in SOURCE_SERIES) return new SourceRef(e.name);
        return CONSTANTS.has(e.name) ? CONSTANTS.get(e.name) : NOT_CONST;
      case 'member': {
        const name = this.dottedName(e);
        return name !== null && CONSTANTS.has(name) ? CONSTANTS.get(name) : NOT_CONST;
      }
      case 'tuple': {
        const items = e.items.map((x) => this.constEval(x));
        return items.includes(NOT_CONST) ? NOT_CONST : items;
      }
      case 'call': {
        const name = this.dottedName(e.callee);
        if (name !== 'color.new' && name !== 'color.rgb') return NOT_CONST;
        const def = FUNCTIONS.get(name)!;
        const bound = this.bindArgs(name, def.params, def.required, false, e.args, e.span);
        const vals = bound.map((b) => (b ? this.constEval(b) : undefined));
        if (vals.includes(NOT_CONST)) return NOT_CONST;
        return def.call(vals, undefined, this.rt);
      }
    }
    return NOT_CONST;
  }

  private requireConst(e: Expr | undefined, what: string): unknown {
    if (!e) return undefined;
    const v = this.constEval(e);
    if (v === NOT_CONST) throw new ScriptError(`${what} must be a constant value`, e.span);
    return v;
  }

  // ------------------------------------------------------------------ indicator() and inputs

  /** indicator() or strategy(): title, display settings and, for strategies, the broker settings. */
  private declarationCall(kind: 'indicator' | 'strategy', args: Arg[], span: Span): Fn {
    if (!this.isGlobalScope()) throw new ScriptError(`${kind}() must be called at the top level`, span);
    if (this.sawDeclaration) throw new ScriptError('A script can call indicator() or strategy() only once', span);
    this.sawDeclaration = true;
    const params = kind === 'strategy' ? STRATEGY_PARAMS : INDICATOR_PARAMS;
    const b = this.bindArgs(kind, params, 1, false, args, span);
    const get = (p: string) => this.requireConst(b[params.indexOf(p)], p);
    const title = get('title');
    if (typeof title !== 'string' || !title.trim()) throw new ScriptError(`${kind}() needs a title string`, b[0]?.span ?? span);
    const shortTitle = get('shorttitle');
    const overlay = get('overlay');
    const format = get('format');
    const precision = get('precision');
    this.meta.title = title.trim();
    this.meta.shortTitle = typeof shortTitle === 'string' && shortTitle.trim() ? shortTitle.trim() : this.meta.title;
    this.meta.overlay = overlay === true;
    this.meta.format = typeof format === 'string' ? format : null;
    this.meta.precision = typeof precision === 'number' && precision >= 0 ? Math.min(10, Math.floor(precision)) : null;
    if (kind === 'strategy') {
      const config = this.strategyConfig(b, params);
      this.meta.strategy = config;
      this.rt.strategy = new Broker(config);
      // Orders and positions depend on every earlier bar, so live updates recompute from the start.
      this.mutatesState = true;
    }
    return () => NaN;
  }

  private strategyConfig(b: Array<Expr | undefined>, params: string[]): StrategyConfig {
    const config: StrategyConfig = { ...DEFAULT_STRATEGY };
    const arg = (p: string) => b[params.indexOf(p)];
    const number = (p: string, min: number, integer = false): number | undefined => {
      const e = arg(p);
      if (!e) return undefined;
      const v = this.requireConst(e, p);
      if (typeof v !== 'number' || v !== v || v < min) throw new ScriptError(`${p} must be a number of at least ${min}`, e.span);
      return integer ? Math.floor(v) : v;
    };
    const choice = <T extends string>(p: string, options: readonly T[], prefix: string): T | undefined => {
      const e = arg(p);
      if (!e) return undefined;
      const v = this.requireConst(e, p);
      if (typeof v !== 'string' || !options.includes(v as T)) throw new ScriptError(`${p} must be one of ${options.map((o) => prefix + o).join(', ')}`, e.span);
      return v as T;
    };
    const capital = number('initial_capital', 0);
    if (capital !== undefined) {
      if (capital <= 0) throw new ScriptError('initial_capital must be more than 0', arg('initial_capital')!.span);
      config.initialCapital = capital;
    }
    config.defaultQtyType = choice('default_qty_type', QTY_TYPES, 'strategy.') ?? config.defaultQtyType;
    const qty = number('default_qty_value', 0);
    if (qty !== undefined) {
      if (qty <= 0) throw new ScriptError('default_qty_value must be more than 0', arg('default_qty_value')!.span);
      config.defaultQtyValue = qty;
    }
    config.commissionType = choice('commission_type', COMMISSION_TYPES, 'strategy.commission.') ?? config.commissionType;
    config.commissionValue = number('commission_value', 0) ?? config.commissionValue;
    config.slippage = number('slippage', 0, true) ?? config.slippage;
    config.pyramiding = number('pyramiding', 0, true) ?? config.pyramiding;
    const onClose = arg('process_orders_on_close') ? this.requireConst(arg('process_orders_on_close'), 'process_orders_on_close') : undefined;
    if (onClose !== undefined) config.processOrdersOnClose = onClose === true;
    return config;
  }

  private inputCall(name: string, args: Arg[], span: Span): Fn {
    const kind = name === 'input' ? 'generic' : name.slice('input.'.length);
    const params = INPUT_PARAMS[kind];
    if (!params) throw new ScriptError(`'${name}' is not supported yet`, span);
    // input.int(defval, title, [options]) puts a list where minval would be.
    let fixedArgs = args;
    if ((kind === 'int' || kind === 'float') && args[2]?.name === null && args[2].value.kind === 'tuple') {
      fixedArgs = args.map((a, i) => (i === 2 ? { ...a, name: 'options' } : a));
    }
    const b = this.bindArgs(name, params, 1, false, fixedArgs, span);
    const get = (p: string) => b[params.indexOf(p)];
    const defval = this.requireConst(get('defval'), 'An input default');
    const title = this.requireConst(get('title'), 'An input title');
    const index = this.inputs.length;

    let type: InputType;
    switch (kind) {
      case 'generic':
        if (defval instanceof SourceRef) type = 'source';
        else if (typeof defval === 'boolean') type = 'bool';
        else if (typeof defval === 'string') type = 'string';
        else if (defval instanceof Color) type = 'color';
        else if (typeof defval === 'number') type = get('defval')?.kind === 'num' && (get('defval') as { isInt: boolean }).isInt ? 'int' : 'float';
        else throw new ScriptError('Unsupported input default', span);
        break;
      case 'price':
        type = 'float';
        break;
      case 'text_area':
      case 'timeframe':
        type = 'string';
        break;
      default:
        type = kind as InputType;
    }

    let def: InputValue;
    if (type === 'source') {
      if (!(defval instanceof SourceRef)) throw new ScriptError('input.source needs a price series such as close or hl2', get('defval')?.span ?? span);
      def = defval.name;
    } else if (type === 'color') {
      if (!(defval instanceof Color)) throw new ScriptError('input.color needs a color', get('defval')?.span ?? span);
      def = defval.hex();
    } else if (type === 'bool') {
      if (typeof defval !== 'boolean') throw new ScriptError('input.bool needs true or false', get('defval')?.span ?? span);
      def = defval;
    } else if (type === 'string') {
      if (typeof defval !== 'string') throw new ScriptError(`${name} needs a string`, get('defval')?.span ?? span);
      def = defval;
    } else {
      if (typeof defval !== 'number' || defval !== defval) throw new ScriptError(`${name} needs a number`, get('defval')?.span ?? span);
      def = type === 'int' ? Math.trunc(defval) : defval;
    }

    const input: InputDef = {
      index,
      key: '',
      title: typeof title === 'string' && title ? title : `Input ${index + 1}`,
      type,
      defval: def,
    };
    const numberOpt = (p: string) => {
      if (!params.includes(p)) return undefined;
      const v = this.requireConst(get(p), p);
      return typeof v === 'number' && v === v ? v : undefined;
    };
    input.minval = numberOpt('minval');
    input.maxval = numberOpt('maxval');
    input.step = numberOpt('step');
    if (params.includes('options')) {
      const opts = this.requireConst(get('options'), 'options');
      if (Array.isArray(opts)) input.options = opts.filter((o): o is InputValue => typeof o === 'number' || typeof o === 'string' || typeof o === 'boolean');
    }
    const tooltip = this.requireConst(get('tooltip'), 'tooltip');
    if (typeof tooltip === 'string') input.tooltip = tooltip;
    const group = this.requireConst(get('group'), 'group');
    if (typeof group === 'string') input.group = group;
    for (const k of Object.keys(input) as Array<keyof InputDef>) if (input[k] === undefined) delete input[k];

    const taken = new Set(this.inputs.map((i) => i.key));
    input.key = typeof title === 'string' && title && !taken.has(title) ? title : `input ${index + 1}`;
    this.inputs.push(input);

    const rt = this.rt;
    if (type === 'source') {
      return () => {
        const series = SOURCE_SERIES[rt.inputValues[index] as string] ?? SOURCE_SERIES.close;
        return series(rt, rt.bar);
      };
    }
    if (type === 'color') {
      let cachedHex = '';
      let cached: Color | null = null;
      return () => {
        const hex = rt.inputValues[index] as string;
        if (hex !== cachedHex) {
          cachedHex = hex;
          cached = Color.fromHex(hex);
        }
        return cached;
      };
    }
    return () => rt.inputValues[index];
  }

  // ------------------------------------------------------------------ outputs

  private outputCall(name: string, rawArgs: Arg[], span: Span): Fn {
    if (!this.isGlobalScope()) throw new ScriptError(`${name}() can only be used at the top level of the script, not inside a block or function`, span);
    const params = OUTPUT_PARAMS[name];
    // fill() also accepts hline1/hline2.
    const args = rawArgs.map((a) => (a.name === 'hline1' ? { ...a, name: 'plot1' } : a.name === 'hline2' ? { ...a, name: 'plot2' } : a));
    if (name === 'fill' && args.some((a) => a.name === 'top_value' || a.name === 'bottom_value' || a.name === 'top_color')) {
      throw new ScriptError('Gradient fills are not supported yet', span);
    }
    const required = name === 'bgcolor' || name === 'barcolor' ? 1 : name === 'fill' ? 2 : 1;
    const b = this.bindArgs(name, params, required, false, args, span);
    const arg = (p: string): Fn | null => {
      const x = b[params.indexOf(p)];
      return x ? this.expr(x) : null;
    };
    const titleExpr = b[params.indexOf('title')];
    const constTitle = titleExpr ? this.constEval(titleExpr) : undefined;
    const rt = this.rt;
    const o = this.outputs;

    switch (name) {
      case 'plot': {
        const out: PlotOutput = {
          kind: 'plot',
          index: o.plots.length,
          title: typeof constTitle === 'string' ? constTitle : `Plot ${o.plots.length + 1}`,
          style: 'line',
          linewidth: 1,
          offset: 0,
          histbase: 0,
          color: PLOT_PALETTE[this.paletteIndex++ % PLOT_PALETTE.length],
          values: [],
          colors: [],
          visible: true,
        };
        o.plots.push(out);
        const series = arg('series')!;
        const color = arg('color');
        const lw = arg('linewidth');
        const style = arg('style');
        const offset = arg('offset');
        const histbase = arg('histbase');
        const display = arg('display');
        const handle = new PlotHandle('plot', out.index);
        return (f) => {
          const v = series(f);
          out.values[rt.bar] = typeof v === 'boolean' ? (v ? 1 : 0) : num(v);
          if (color) out.colors[rt.bar] = cssOf(color(f));
          if (rt.bar === 0 || rt.bar === rt.count - 1) {
            if (lw) out.linewidth = Math.max(1, Math.min(10, num(lw(f)) || 1));
            if (style) out.style = normalizeStyle(style(f));
            if (offset) out.offset = Math.trunc(num(offset(f))) || 0;
            if (histbase) out.histbase = num(histbase(f)) || 0;
            if (display) out.visible = display(f) !== 'none';
          }
          return handle;
        };
      }
      case 'plotshape':
      case 'plotchar': {
        const out: ShapeOutput = {
          kind: 'shape',
          index: o.shapes.length,
          title: typeof constTitle === 'string' ? constTitle : `Shape ${o.shapes.length + 1}`,
          char: name === 'plotchar' ? '★' : null,
          style: name === 'plotchar' ? 'circle' : 'xcross',
          location: 'abovebar',
          size: SHAPE_SIZES.small,
          offset: 0,
          text: '',
          color: PLOT_PALETTE[0],
          textColor: null,
          values: [],
          colors: [],
          textColors: [],
        };
        o.shapes.push(out);
        const series = arg('series')!;
        const color = arg('color');
        const textColor = arg('textcolor');
        const style = name === 'plotshape' ? arg('style') : null;
        const ch = name === 'plotchar' ? arg('char') : null;
        const location = arg('location');
        const size = arg('size');
        const text = arg('text');
        const offset = arg('offset');
        return (f) => {
          if (rt.bar === 0 || rt.bar === rt.count - 1) {
            if (style) out.style = String(style(f)) as ShapeOutput['style'];
            if (ch) {
              const c = ch(f);
              if (typeof c === 'string' && c) out.char = [...c][0];
            }
            if (location) out.location = String(location(f)) as ShapeOutput['location'];
            if (size) out.size = SHAPE_SIZES[String(size(f))] ?? SHAPE_SIZES.small;
            if (text) {
              const t = text(f);
              out.text = typeof t === 'string' ? t : '';
            }
            if (offset) out.offset = Math.trunc(num(offset(f))) || 0;
          }
          const v = series(f);
          const shown = out.location === 'absolute' ? !isNa(v) && typeof v === 'number' : truthy(v);
          out.values[rt.bar] = shown ? (typeof v === 'number' ? v : 1) : NaN;
          if (color) out.colors[rt.bar] = cssOf(color(f));
          if (textColor) out.textColors[rt.bar] = cssOf(textColor(f));
          return NaN;
        };
      }
      case 'hline': {
        const out: HlineOutput = {
          kind: 'hline',
          index: o.hlines.length,
          title: typeof constTitle === 'string' ? constTitle : `Level ${o.hlines.length + 1}`,
          price: NaN,
          color: '#787b86',
          lineStyle: 'solid',
          linewidth: 1,
        };
        o.hlines.push(out);
        const price = arg('price')!;
        const color = arg('color');
        const ls = arg('linestyle');
        const lw = arg('linewidth');
        const handle = new PlotHandle('hline', out.index);
        return (f) => {
          if (rt.bar === rt.count - 1 || rt.bar === 0) {
            out.price = num(price(f));
            if (color) out.color = cssOf(color(f));
            if (ls) out.lineStyle = String(ls(f)) as HlineOutput['lineStyle'];
            if (lw) out.linewidth = Math.max(1, Math.min(10, num(lw(f)) || 1));
          }
          return handle;
        };
      }
      case 'fill': {
        const out: FillOutput = { kind: 'fill', index: o.fills.length, from: null, to: null, color: 'rgba(33,150,243,0.2)', colors: [] };
        o.fills.push(out);
        const p1 = arg('plot1')!;
        const p2 = arg('plot2')!;
        const color = arg('color');
        return (f) => {
          if (!out.from) {
            const a = p1(f);
            const c = p2(f);
            if (!(a instanceof PlotHandle) || !(c instanceof PlotHandle)) throw new ScriptError('fill() needs two plots or two hlines', span);
            if (a.kind !== c.kind) throw new ScriptError('fill() needs two plots or two hlines, not one of each', span);
            out.from = { kind: a.kind, index: a.index };
            out.to = { kind: c.kind, index: c.index };
          }
          if (color) out.colors[rt.bar] = cssOf(color(f));
          return NaN;
        };
      }
      case 'bgcolor':
      case 'barcolor': {
        const list = name === 'bgcolor' ? o.backgrounds : o.barColors;
        const out: BarColorOutput = { kind: name, index: list.length, offset: 0, colors: [] };
        list.push(out);
        const color = arg('color')!;
        const offset = arg('offset');
        return (f) => {
          out.colors[rt.bar] = cssOf(color(f));
          if (offset && (rt.bar === 0 || rt.bar === rt.count - 1)) out.offset = Math.trunc(num(offset(f))) || 0;
          return NaN;
        };
      }
    }
    throw new ScriptError(`'${name}' is not supported yet`, span);
  }
}

function normalizeStyle(v: unknown): PlotOutput['style'] {
  switch (v) {
    case 'linebr':
    case 'stepline':
    case 'histogram':
    case 'columns':
    case 'circles':
    case 'cross':
    case 'area':
    case 'areabr':
      return v;
    case 'stepline_diamond':
    case 'steplinebr':
      return 'stepline';
    default:
      return 'line';
  }
}
