import type { Candle } from '../../src/script/runtime';
import { compileScript, type ScriptEngine } from '../../src/script/engine';

/** Deterministic pseudo-random candles: a random walk with realistic ranges and volume. */
export function makeCandles(count: number, seed = 42, start = Date.UTC(2026, 0, 1)): Candle[] {
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  const out: Candle[] = [];
  let close = 100;
  for (let i = 0; i < count; i++) {
    const open = close;
    const move = (rand() - 0.5) * 4;
    close = Math.max(1, open + move);
    const high = Math.max(open, close) + rand() * 2;
    const low = Math.min(open, close) - rand() * 2;
    out.push({ timestamp: start + i * 3_600_000, open, high, low, close, volume: 100 + Math.floor(rand() * 900) });
  }
  return out;
}

export const CANDLES = makeCandles(400);

export function compile(source: string): ScriptEngine {
  const r = compileScript(source);
  if (!r.ok) throw new Error(r.error.format());
  return r.engine;
}

/** Compiles and runs a script, failing the test on any error. */
export function run(source: string, candles: Candle[] = CANDLES): ScriptEngine {
  const engine = compile(source);
  const res = engine.run(candles);
  if (res.error) throw new Error(res.error.format());
  return engine;
}

/** Values of plot `i`, with NaN for na. */
export function plotValues(engine: ScriptEngine, i = 0): number[] {
  const p = engine.outputs.plots[i];
  return Array.from({ length: engine.barCount }, (_, k) => (p.values[k] === undefined ? NaN : p.values[k]));
}

export function expectSeriesClose(actual: number[], expected: Array<number | undefined>, tol = 1e-9): void {
  if (actual.length !== expected.length) throw new Error(`length ${actual.length} != ${expected.length}`);
  for (let i = 0; i < actual.length; i++) {
    const a = actual[i];
    const e = expected[i] === undefined ? NaN : (expected[i] as number);
    if (Number.isNaN(e) || Number.isNaN(a)) {
      if (Number.isNaN(e) !== Number.isNaN(a)) throw new Error(`bar ${i}: got ${a}, expected ${e}`);
      continue;
    }
    if (Math.abs(a - e) > tol) throw new Error(`bar ${i}: got ${a}, expected ${e}`);
  }
}
