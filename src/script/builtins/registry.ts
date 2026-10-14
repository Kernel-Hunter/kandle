import type { Runtime } from '../runtime';

/** A built-in function. `call` gets the bound arguments in parameter order. */
export interface BuiltinFunction {
  /** Parameter names, used for named arguments and for error messages. */
  params: string[];
  /** Number of leading parameters that must be given. */
  required: number;
  /** Extra positional arguments are allowed (math.max, array.from, str.format). */
  variadic?: boolean;
  /**
   * When the call has one positional argument fewer than `params` and no argument named
   * `source`, this series is used as the first argument (ta.highest(10) uses high).
   */
  implicitSource?: 'high' | 'low' | 'close';
  /** Creates per-call-site state. Present only for functions that remember past bars. */
  init?: () => unknown;
  /** Changes state that a live-bar rerun cannot roll back (arrays). */
  mutates?: boolean;
  /** Can be read without parentheses, like ta.tr or ta.obv. */
  asVariable?: boolean;
  call(args: unknown[], state: any, rt: Runtime): unknown;
}

/** Thrown by built-ins; the compiler adds the source position. */
export class BuiltinError extends Error {}

export const FUNCTIONS = new Map<string, BuiltinFunction>();
export const VARIABLES = new Map<string, (rt: Runtime) => unknown>();
/** Constants are folded at compile time (color.red, plot.style_line, shape.circle...). */
export const CONSTANTS = new Map<string, unknown>();

export function fn(name: string, params: string[], required: number, call: BuiltinFunction['call'], extra: Partial<BuiltinFunction> = {}): void {
  FUNCTIONS.set(name, { params, required, call, ...extra });
}

export function stateful<S>(
  name: string,
  params: string[],
  required: number,
  init: () => S,
  call: (args: unknown[], state: S, rt: Runtime) => unknown,
  extra: Partial<BuiltinFunction> = {},
): void {
  FUNCTIONS.set(name, { params, required, init, call, ...extra });
}

export function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return NaN;
}

/** Lengths must be positive integers; anything else yields NaN so callers return na. */
export function len(v: unknown): number {
  const n = num(v);
  if (!(n >= 1)) return NaN;
  return Math.floor(n);
}

/** Names that exist in the original language but are not implemented here yet. */
export const KNOWN_UNSUPPORTED_NAMESPACES = new Set([
  'strategy',
  'request',
  'label',
  'line',
  'box',
  'table',
  'linefill',
  'polyline',
  'matrix',
  'map',
  'chart',
  'log',
  'runtime',
  'ticker',
  'alert',
]);
