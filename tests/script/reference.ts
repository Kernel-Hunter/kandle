/**
 * Straightforward whole-array reference implementations used to check the script
 * built-ins. They favour clarity over speed and share no code with src/script.
 */
import type { Candle } from '../../src/script/runtime';

export type S = number[];

const nan = (n: number): S => new Array(n).fill(NaN);
const ok = (v: number) => !Number.isNaN(v);

export function sma(x: S, n: number): S {
  return x.map((_, i) => {
    if (i < n - 1) return NaN;
    const w = x.slice(i - n + 1, i + 1);
    return w.every(ok) ? w.reduce((a, b) => a + b, 0) / n : NaN;
  });
}

function smoothed(x: S, n: number, alpha: number): S {
  const base = sma(x, n);
  const out = nan(x.length);
  for (let i = 0; i < x.length; i++) {
    const prev = i > 0 ? out[i - 1] : NaN;
    out[i] = ok(prev) ? alpha * x[i] + (1 - alpha) * prev : base[i];
  }
  return out;
}

export const ema = (x: S, n: number) => smoothed(x, n, 2 / (n + 1));
export const rma = (x: S, n: number) => smoothed(x, n, 1 / n);

export function wma(x: S, n: number): S {
  return x.map((_, i) => {
    if (i < n - 1) return NaN;
    let num = 0;
    let den = 0;
    for (let k = 0; k < n; k++) {
      num += x[i - n + 1 + k] * (k + 1);
      den += k + 1;
    }
    return num / den;
  });
}

export const sub = (a: S, b: S) => a.map((v, i) => v - b[i]);
export const add = (a: S, b: S) => a.map((v, i) => v + b[i]);
export const mul = (a: S, k: number | S) => a.map((v, i) => v * (typeof k === 'number' ? k : k[i]));
export const div = (a: S, b: S) => a.map((v, i) => v / b[i]);

export function hma(x: S, n: number): S {
  const diff = sub(mul(wma(x, Math.floor(n / 2)), 2), wma(x, n));
  // wma over a series with leading NaN: shift so the window only sees valid values.
  const m = Math.floor(Math.sqrt(n));
  return diff.map((_, i) => {
    if (i < m - 1) return NaN;
    const w = diff.slice(i - m + 1, i + 1);
    if (!w.every(ok)) return NaN;
    let num = 0;
    let den = 0;
    w.forEach((v, k) => {
      num += v * (k + 1);
      den += k + 1;
    });
    return num / den;
  });
}

export function stdev(x: S, n: number, biased = true): S {
  const m = sma(x, n);
  return x.map((_, i) => {
    if (!ok(m[i])) return NaN;
    let ss = 0;
    for (let k = i - n + 1; k <= i; k++) ss += (x[k] - m[i]) ** 2;
    return Math.sqrt(ss / (biased ? n : n - 1));
  });
}

export function variance(x: S, n: number): S {
  return stdev(x, n).map((v) => v * v);
}

export function meanDev(x: S, n: number): S {
  const m = sma(x, n);
  return x.map((_, i) => {
    if (!ok(m[i])) return NaN;
    let s = 0;
    for (let k = i - n + 1; k <= i; k++) s += Math.abs(x[k] - m[i]);
    return s / n;
  });
}

export function change(x: S, n = 1): S {
  return x.map((v, i) => (i >= n ? v - x[i - n] : NaN));
}

export function tr(c: Candle[], handleNa: boolean): S {
  return c.map((b, i) => {
    if (i === 0) return handleNa ? b.high - b.low : NaN;
    const pc = c[i - 1].close;
    return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  });
}

export function highest(x: S, n: number): S {
  return x.map((_, i) => (i < n - 1 ? NaN : Math.max(...x.slice(i - n + 1, i + 1))));
}

export function lowest(x: S, n: number): S {
  return x.map((_, i) => (i < n - 1 ? NaN : Math.min(...x.slice(i - n + 1, i + 1))));
}

export function highestbars(x: S, n: number): S {
  return x.map((_, i) => {
    if (i < n - 1) return NaN;
    let best = -Infinity;
    let off = 0;
    for (let k = n - 1; k >= 0; k--) {
      // iterate oldest to newest, keep the newest of equal highs
      if (x[i - k] >= best) {
        best = x[i - k];
        off = k;
      }
    }
    return -off;
  });
}

export function lowestbars(x: S, n: number): S {
  return highestbars(x.map((v) => -v), n);
}

export function rsi(x: S, n: number): S {
  const ch = change(x);
  const up = rma(ch.map((v) => Math.max(v, 0)), n);
  const down = rma(ch.map((v) => -Math.min(v, 0)), n);
  return up.map((u, i) => {
    const d = down[i];
    if (!ok(u) || !ok(d)) return NaN;
    if (d === 0) return 100;
    if (u === 0) return 0;
    return 100 - 100 / (1 + u / d);
  });
}

export function stoch(src: S, hi: S, lo: S, n: number): S {
  const hh = highest(hi, n);
  const ll = lowest(lo, n);
  return src.map((v, i) => (hh[i] === ll[i] ? NaN : (100 * (v - ll[i])) / (hh[i] - ll[i])));
}

export function cci(x: S, n: number): S {
  const m = sma(x, n);
  const d = meanDev(x, n);
  return x.map((v, i) => (v - m[i]) / (0.015 * d[i]));
}

export function rollingSum(x: S, n: number): S {
  return sma(x, n).map((v) => v * n);
}

export function mfi(c: Candle[], src: S, n: number): S {
  const ch = change(src);
  const up = src.map((v, i) => c[i].volume! * (ch[i] <= 0 ? 0 : v));
  const down = src.map((v, i) => c[i].volume! * (ch[i] >= 0 ? 0 : v));
  const su = rollingSum(up, n);
  const sd = rollingSum(down, n);
  return su.map((u, i) => 100 - 100 / (1 + u / sd[i]));
}

export function obv(c: Candle[]): S {
  let acc = 0;
  return c.map((b, i) => {
    if (i > 0) acc += Math.sign(b.close - c[i - 1].close) * b.volume!;
    return acc;
  });
}

export function cum(x: S): S {
  let acc = 0;
  return x.map((v) => (acc += ok(v) ? v : 0));
}

export function vwapDaily(c: Candle[], src: S, mult?: number): { mid: S; upper: S; lower: S } {
  const mid: S = [];
  const upper: S = [];
  const lower: S = [];
  let day = NaN;
  let pv = 0;
  let v = 0;
  let pv2 = 0;
  c.forEach((b, i) => {
    const d = Math.floor(b.timestamp / 86_400_000);
    if (d !== day) {
      day = d;
      pv = 0;
      v = 0;
      pv2 = 0;
    }
    pv += src[i] * b.volume!;
    v += b.volume!;
    pv2 += src[i] * src[i] * b.volume!;
    const m = pv / v;
    const sd = Math.sqrt(Math.max(0, pv2 / v - m * m));
    mid.push(m);
    upper.push(m + sd * (mult ?? 0));
    lower.push(m - sd * (mult ?? 0));
  });
  return { mid, upper, lower };
}

export function supertrend(c: Candle[], factor: number, period: number): { line: S; dir: S } {
  const atr = rma(tr(c, true), period);
  const line: S = [];
  const dir: S = [];
  const ub: S = [];
  const lb: S = [];
  c.forEach((b, i) => {
    if (!ok(atr[i])) {
      ub.push(NaN);
      lb.push(NaN);
      line.push(NaN);
      dir.push(NaN);
      return;
    }
    const mid = (b.high + b.low) / 2;
    const pu = i > 0 && ok(ub[i - 1]) ? ub[i - 1] : 0;
    const pl = i > 0 && ok(lb[i - 1]) ? lb[i - 1] : 0;
    const pc = i > 0 ? c[i - 1].close : NaN;
    let up = mid + factor * atr[i];
    let lo = mid - factor * atr[i];
    if (!(lo > pl || pc < pl)) lo = pl;
    if (!(up < pu || pc > pu)) up = pu;
    let d: number;
    if (i === 0 || !ok(atr[i - 1])) d = 1;
    else if (line[i - 1] === pu) d = b.close > up ? -1 : 1;
    else d = b.close < lo ? 1 : -1;
    ub.push(up);
    lb.push(lo);
    line.push(d === -1 ? lo : up);
    dir.push(d);
  });
  return { line, dir };
}

export function linreg(x: S, n: number, offset: number): S {
  return x.map((_, i) => {
    if (i < n - 1) return NaN;
    const ys = x.slice(i - n + 1, i + 1);
    const xs = ys.map((_, k) => k);
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0;
    let den = 0;
    xs.forEach((xv, k) => {
      num += (xv - mx) * (ys[k] - my);
      den += (xv - mx) ** 2;
    });
    const slope = num / den;
    const intercept = my - slope * mx;
    return intercept + slope * (n - 1 - offset);
  });
}

export function correlation(a: S, b: S, n: number): S {
  return a.map((_, i) => {
    if (i < n - 1) return NaN;
    const xa = a.slice(i - n + 1, i + 1);
    const xb = b.slice(i - n + 1, i + 1);
    const ma = xa.reduce((p, q) => p + q, 0) / n;
    const mb = xb.reduce((p, q) => p + q, 0) / n;
    let cov = 0;
    let va = 0;
    let vb = 0;
    for (let k = 0; k < n; k++) {
      cov += (xa[k] - ma) * (xb[k] - mb);
      va += (xa[k] - ma) ** 2;
      vb += (xb[k] - mb) ** 2;
    }
    return cov / Math.sqrt(va * vb);
  });
}

export function percentrank(x: S, n: number): S {
  return x.map((v, i) => {
    if (i < n) return NaN;
    let c = 0;
    for (let k = 1; k <= n; k++) if (x[i - k] <= v) c++;
    return (100 * c) / n;
  });
}

export function median(x: S, n: number): S {
  return x.map((_, i) => {
    if (i < n - 1) return NaN;
    const w = x.slice(i - n + 1, i + 1).sort((p, q) => p - q);
    return n % 2 ? w[(n - 1) / 2] : (w[n / 2 - 1] + w[n / 2]) / 2;
  });
}

export function pivot(x: S, left: number, right: number, high: boolean): S {
  return x.map((_, i) => {
    const p = i - right;
    if (p - left < 0) return NaN;
    for (let k = p - left; k <= i; k++) {
      if (k === p) continue;
      if (high ? x[k] >= x[p] : x[k] <= x[p]) return NaN;
    }
    return x[p];
  });
}

export function barssince(cond: boolean[]): S {
  let last = NaN;
  return cond.map((c, i) => {
    if (c) last = i;
    return i - last;
  });
}

export function valuewhen(cond: boolean[], src: S, occurrence: number): S {
  const hits: number[] = [];
  return cond.map((c, i) => {
    if (c) hits.push(src[i]);
    const k = hits.length - 1 - occurrence;
    return k >= 0 ? hits[k] : NaN;
  });
}

export function crossover(a: S, b: S): boolean[] {
  return a.map((v, i) => i > 0 && v > b[i] && a[i - 1] <= b[i - 1]);
}

export function crossunder(a: S, b: S): boolean[] {
  return a.map((v, i) => i > 0 && v < b[i] && a[i - 1] >= b[i - 1]);
}

export function rising(x: S, n: number): boolean[] {
  return x.map((v, i) => {
    if (i < n) return false;
    for (let k = 1; k <= n; k++) if (!(v > x[i - k])) return false;
    return true;
  });
}

export function roc(x: S, n: number): S {
  return x.map((v, i) => (i >= n ? (100 * (v - x[i - n])) / x[i - n] : NaN));
}

export function vwma(x: S, vol: S, n: number): S {
  return div(sma(mul(x, vol), n), sma(vol, n));
}

export function dmi(c: Candle[], n: number, adxLen: number): { plus: S; minus: S; adx: S } {
  const up = c.map((b, i) => (i > 0 ? b.high - c[i - 1].high : NaN));
  const down = c.map((b, i) => (i > 0 ? c[i - 1].low - b.low : NaN));
  const plusDM = up.map((u, i) => (Number.isNaN(u) ? NaN : u > down[i] && u > 0 ? u : 0));
  const minusDM = down.map((d, i) => (Number.isNaN(d) ? NaN : d > up[i] && d > 0 ? d : 0));
  const trur = rma(tr(c, false), n);
  const plus = div(mul(rma(plusDM, n), 100), trur);
  const minus = div(mul(rma(minusDM, n), 100), trur);
  const dx = plus.map((p, i) => {
    const s = p + minus[i];
    return Math.abs(p - minus[i]) / (s === 0 ? 1 : s);
  });
  return { plus, minus, adx: mul(rma(dx, adxLen), 100) };
}
