/**
 * Technical analysis built-ins (ta.*). Each call site gets its own state object, and all
 * state is stored per bar index so re-running the last bar gives the same answer.
 */
import type { Runtime } from '../runtime';
import { Tuple } from '../values';
import { len, num, stateful, type BuiltinFunction, FUNCTIONS } from './registry';

type Arr = number[];

const at = (a: Arr, i: number): number => {
  if (i < 0) return NaN;
  const v = a[i];
  return v === undefined ? NaN : v;
};

// ------------------------------------------------------------------ window helpers

function windowSum(a: Arr, b: number, n: number): number {
  if (!(n >= 1) || b < n - 1) return NaN;
  let sum = 0;
  for (let i = b - n + 1; i <= b; i++) {
    const v = a[i];
    if (v === undefined || v !== v) return NaN;
    sum += v;
  }
  return sum;
}

function windowMean(a: Arr, b: number, n: number): number {
  return windowSum(a, b, n) / n;
}

function windowVariance(a: Arr, b: number, n: number, biased: boolean): number {
  const mean = windowMean(a, b, n);
  if (mean !== mean) return NaN;
  let ss = 0;
  for (let i = b - n + 1; i <= b; i++) {
    const d = (a[i] as number) - mean;
    ss += d * d;
  }
  const div = biased ? n : n - 1;
  return div > 0 ? ss / div : NaN;
}

/** Highest (sign 1) or lowest (sign -1) value over the window, skipping na. Returns [value, offset]. */
function windowExtreme(a: Arr, b: number, n: number, sign: 1 | -1): [number, number] {
  if (!(n >= 1) || b < n - 1) return [NaN, NaN];
  let best = NaN;
  let offset = NaN;
  for (let k = 0; k < n; k++) {
    const v = a[b - k];
    if (v === undefined || v !== v) continue;
    if (best !== best || (sign === 1 ? v > best : v < best)) {
      best = v;
      offset = k;
    }
  }
  return [best, offset];
}

// ------------------------------------------------------------------ reusable steps

interface Src {
  src: Arr;
}
interface Rec extends Src {
  out: Arr;
}

const newSrc = (): Src => ({ src: [] });
const newRec = (): Rec => ({ src: [], out: [] });

function smaStep(st: Src, x: number, n: number, b: number): number {
  st.src[b] = x;
  return windowMean(st.src, b, n);
}

/** Exponential average seeded with a simple average, the convention scripts expect. */
function expStep(st: Rec, x: number, n: number, b: number, alpha: number): number {
  st.src[b] = x;
  const prev = at(st.out, b - 1);
  const out = prev !== prev ? windowMean(st.src, b, n) : alpha * x + (1 - alpha) * prev;
  st.out[b] = out;
  return out;
}

const emaStep = (st: Rec, x: number, n: number, b: number) => expStep(st, x, n, b, 2 / (n + 1));
const rmaStep = (st: Rec, x: number, n: number, b: number) => expStep(st, x, n, b, 1 / n);

function wmaStep(st: Src, x: number, n: number, b: number): number {
  st.src[b] = x;
  if (!(n >= 1) || b < n - 1) return NaN;
  let sum = 0;
  let norm = 0;
  for (let k = 0; k < n; k++) {
    const v = st.src[b - k];
    if (v === undefined || v !== v) return NaN;
    const w = n - k;
    sum += v * w;
    norm += w;
  }
  return sum / norm;
}

function trueRange(rt: Runtime, b: number, handleNa: boolean): number {
  const h = rt.high[b];
  const l = rt.low[b];
  if (b === 0) return handleNa ? h - l : NaN;
  const pc = rt.close[b - 1];
  return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
}

/** Volume-weighted average since the last anchor. */
interface VwapState {
  pv: Arr;
  v: Arr;
  pv2: Arr;
}

function vwapStep(st: VwapState, rt: Runtime, src: number, reset: boolean, b: number): [number, number] {
  const vol = rt.volume[b];
  const fresh = reset || b === 0;
  const pv = (fresh ? 0 : at(st.pv, b - 1)) + src * vol;
  const v = (fresh ? 0 : at(st.v, b - 1)) + vol;
  const pv2 = (fresh ? 0 : at(st.pv2, b - 1)) + src * src * vol;
  st.pv[b] = pv;
  st.v[b] = v;
  st.pv2[b] = pv2;
  const mean = pv / v;
  const variance = pv2 / v - mean * mean;
  return [mean, Math.sqrt(Math.max(0, variance))];
}

const dayOf = (t: number) => Math.floor(t / 86_400_000);

// ------------------------------------------------------------------ moving averages

stateful('ta.sma', ['source', 'length'], 2, newSrc, ([s, l], st, rt) => smaStep(st, num(s), len(l), rt.bar));
stateful('ta.ema', ['source', 'length'], 2, newRec, ([s, l], st, rt) => emaStep(st, num(s), len(l), rt.bar));
stateful('ta.rma', ['source', 'length'], 2, newRec, ([s, l], st, rt) => rmaStep(st, num(s), len(l), rt.bar));
stateful('ta.wma', ['source', 'length'], 2, newSrc, ([s, l], st, rt) => wmaStep(st, num(s), len(l), rt.bar));

stateful(
  'ta.vwma',
  ['source', 'length'],
  2,
  () => ({ pv: newSrc(), v: newSrc() }),
  ([s, l], st, rt) => {
    const b = rt.bar;
    const n = len(l);
    const vol = rt.volume[b];
    return smaStep(st.pv, num(s) * vol, n, b) / smaStep(st.v, vol, n, b);
  },
);

stateful(
  'ta.hma',
  ['source', 'length'],
  2,
  () => ({ half: newSrc(), full: newSrc(), final: newSrc() }),
  ([s, l], st, rt) => {
    const b = rt.bar;
    const n = len(l);
    const x = num(s);
    const half = wmaStep(st.half, x, Math.floor(n / 2), b);
    const full = wmaStep(st.full, x, n, b);
    return wmaStep(st.final, 2 * half - full, Math.floor(Math.sqrt(n)), b);
  },
);

// ------------------------------------------------------------------ oscillators

function rsiState() {
  return { src: [] as Arr, up: newRec(), down: newRec() };
}

function rsiStep(st: ReturnType<typeof rsiState>, x: number, n: number, b: number): number {
  st.src[b] = x;
  const ch = x - at(st.src, b - 1);
  const u = rmaStep(st.up, Math.max(ch, 0), n, b);
  const d = rmaStep(st.down, -Math.min(ch, 0), n, b);
  if (u !== u || d !== d) return NaN;
  return d === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / d);
}

stateful('ta.rsi', ['source', 'length'], 2, rsiState, ([s, l], st, rt) => rsiStep(st, num(s), len(l), rt.bar));

stateful(
  'ta.macd',
  ['source', 'fastlen', 'slowlen', 'siglen'],
  4,
  () => ({ fast: newRec(), slow: newRec(), sig: newRec() }),
  ([s, f, sl, sg], st, rt) => {
    const b = rt.bar;
    const x = num(s);
    const macd = emaStep(st.fast, x, len(f), b) - emaStep(st.slow, x, len(sl), b);
    const signal = emaStep(st.sig, macd, len(sg), b);
    return new Tuple([macd, signal, macd - signal]);
  },
);

stateful(
  'ta.stoch',
  ['source', 'high', 'low', 'length'],
  4,
  () => ({ h: [] as Arr, l: [] as Arr }),
  ([s, hi, lo, l], st, rt) => {
    const b = rt.bar;
    const n = len(l);
    st.h[b] = num(hi);
    st.l[b] = num(lo);
    const [hh] = windowExtreme(st.h, b, n, 1);
    const [ll] = windowExtreme(st.l, b, n, -1);
    const range = hh - ll;
    return range === 0 ? NaN : (100 * (num(s) - ll)) / range;
  },
);

stateful(
  'ta.cci',
  ['source', 'length'],
  2,
  newSrc,
  ([s, l], st, rt) => {
    const b = rt.bar;
    const n = len(l);
    const x = num(s);
    const mean = smaStep(st, x, n, b);
    if (mean !== mean) return NaN;
    let dev = 0;
    for (let i = b - n + 1; i <= b; i++) dev += Math.abs((st.src[i] as number) - mean);
    dev /= n;
    return (x - mean) / (0.015 * dev);
  },
);

stateful(
  'ta.mfi',
  ['source', 'length'],
  2,
  () => ({ src: [] as Arr, up: [] as Arr, down: [] as Arr }),
  ([s, l], st, rt) => {
    const b = rt.bar;
    const n = len(l);
    const x = num(s);
    st.src[b] = x;
    const ch = x - at(st.src, b - 1);
    const vol = rt.volume[b];
    st.up[b] = vol * (ch <= 0 ? 0 : x);
    st.down[b] = vol * (ch >= 0 ? 0 : x);
    const upper = windowSum(st.up, b, n);
    const lower = windowSum(st.down, b, n);
    return 100 - 100 / (1 + upper / lower);
  },
);

stateful(
  'ta.wpr',
  ['length'],
  1,
  () => ({}),
  ([l], _st, rt) => {
    const b = rt.bar;
    const n = len(l);
    const [hh] = windowExtreme(rt.high, b, n, 1);
    const [ll] = windowExtreme(rt.low, b, n, -1);
    return hh === ll ? NaN : (100 * (rt.close[b] - hh)) / (hh - ll);
  },
);

stateful(
  'ta.dmi',
  ['diLength', 'adxSmoothing'],
  2,
  () => ({ tr: newRec(), plus: newRec(), minus: newRec(), adx: newRec() }),
  ([dl, al], st, rt) => {
    const b = rt.bar;
    const n = len(dl);
    const up = b > 0 ? rt.high[b] - rt.high[b - 1] : NaN;
    const down = b > 0 ? rt.low[b - 1] - rt.low[b] : NaN;
    const plusDM = up !== up ? NaN : up > down && up > 0 ? up : 0;
    const minusDM = down !== down ? NaN : down > up && down > 0 ? down : 0;
    const trur = rmaStep(st.tr, trueRange(rt, b, false), n, b);
    const plus = (100 * rmaStep(st.plus, plusDM, n, b)) / trur;
    const minus = (100 * rmaStep(st.minus, minusDM, n, b)) / trur;
    const sum = plus + minus;
    const adx = 100 * rmaStep(st.adx, Math.abs(plus - minus) / (sum === 0 ? 1 : sum), len(al), b);
    return new Tuple([plus, minus, adx]);
  },
);

// ------------------------------------------------------------------ volatility and bands

stateful('ta.tr', ['handle_na'], 0, () => ({}), ([h], _st, rt) => trueRange(rt, rt.bar, h === true), { asVariable: true });

stateful('ta.atr', ['length'], 1, newRec, ([l], st, rt) => rmaStep(st, trueRange(rt, rt.bar, true), len(l), rt.bar));

stateful('ta.stdev', ['source', 'length', 'biased'], 2, newSrc, ([s, l, biased], st, rt) => {
  const b = rt.bar;
  st.src[b] = num(s);
  return Math.sqrt(windowVariance(st.src, b, len(l), biased !== false));
});

stateful('ta.variance', ['source', 'length', 'biased'], 2, newSrc, ([s, l, biased], st, rt) => {
  const b = rt.bar;
  st.src[b] = num(s);
  return windowVariance(st.src, b, len(l), biased !== false);
});

stateful('ta.dev', ['source', 'length'], 2, newSrc, ([s, l], st, rt) => {
  const b = rt.bar;
  const n = len(l);
  const mean = smaStep(st, num(s), n, b);
  if (mean !== mean) return NaN;
  let dev = 0;
  for (let i = b - n + 1; i <= b; i++) dev += Math.abs((st.src[i] as number) - mean);
  return dev / n;
});

function bands(st: Src, x: number, n: number, mult: number, b: number): [number, number, number] {
  const basis = smaStep(st, x, n, b);
  const dev = mult * Math.sqrt(windowVariance(st.src, b, n, true));
  return [basis, basis + dev, basis - dev];
}

stateful('ta.bb', ['series', 'length', 'mult'], 3, newSrc, ([s, l, m], st, rt) => new Tuple(bands(st, num(s), len(l), num(m), rt.bar)));

stateful('ta.bbw', ['series', 'length', 'mult'], 3, newSrc, ([s, l, m], st, rt) => {
  const [basis, upper, lower] = bands(st, num(s), len(l), num(m), rt.bar);
  return (upper - lower) / basis;
});

stateful(
  'ta.kc',
  ['series', 'length', 'mult', 'useTrueRange'],
  3,
  () => ({ mid: newRec(), range: newRec() }),
  ([s, l, m, useTr], st, rt) => {
    const b = rt.bar;
    const n = len(l);
    const basis = emaStep(st.mid, num(s), n, b);
    const range = useTr === false ? rt.high[b] - rt.low[b] : trueRange(rt, b, false);
    const r = emaStep(st.range, range, n, b) * num(m);
    return new Tuple([basis, basis + r, basis - r]);
  },
);

stateful(
  'ta.supertrend',
  ['factor', 'atrPeriod'],
  2,
  () => ({ atr: newRec(), upper: [] as Arr, lower: [] as Arr, line: [] as Arr }),
  ([f, p], st, rt) => {
    const b = rt.bar;
    const factor = num(f);
    const a = rmaStep(st.atr, trueRange(rt, b, true), len(p), b);
    if (a !== a) {
      st.upper[b] = NaN;
      st.lower[b] = NaN;
      st.line[b] = NaN;
      return new Tuple([NaN, NaN]);
    }
    const mid = (rt.high[b] + rt.low[b]) / 2;
    const prevClose = at(rt.close, b - 1);
    const prevUpperRaw = at(st.upper, b - 1);
    const prevLowerRaw = at(st.lower, b - 1);
    const prevUpper = prevUpperRaw !== prevUpperRaw ? 0 : prevUpperRaw;
    const prevLower = prevLowerRaw !== prevLowerRaw ? 0 : prevLowerRaw;
    let upper = mid + factor * a;
    let lower = mid - factor * a;
    lower = lower > prevLower || prevClose < prevLower ? lower : prevLower;
    upper = upper < prevUpper || prevClose > prevUpper ? upper : prevUpper;
    const close = rt.close[b];
    let dir: number;
    if (at(st.atr.out, b - 1) !== at(st.atr.out, b - 1)) dir = 1;
    else if (at(st.line, b - 1) === prevUpper) dir = close > upper ? -1 : 1;
    else dir = close < lower ? 1 : -1;
    const line = dir === -1 ? lower : upper;
    st.upper[b] = upper;
    st.lower[b] = lower;
    st.line[b] = line;
    return new Tuple([line, dir]);
  },
);

// ------------------------------------------------------------------ volume

stateful('ta.obv', [], 0, () => ({ out: [] as Arr }), (_a, st, rt) => {
  const b = rt.bar;
  const ch = b > 0 ? rt.close[b] - rt.close[b - 1] : NaN;
  const step = Math.sign(ch) * rt.volume[b];
  const out = (b > 0 ? at(st.out, b - 1) : 0) + (step === step ? step : 0);
  st.out[b] = out;
  return out;
}, { asVariable: true });

stateful(
  'ta.vwap',
  ['source', 'anchor', 'stdev_mult'],
  0,
  () => ({ pv: [] as Arr, v: [] as Arr, pv2: [] as Arr }),
  (args, st, rt) => {
    const b = rt.bar;
    const src = args[0] === undefined ? (rt.high[b] + rt.low[b] + rt.close[b]) / 3 : num(args[0]);
    const anchor = args[1];
    const reset = anchor === undefined ? b > 0 && dayOf(rt.time[b]) !== dayOf(rt.time[b - 1]) : anchor === true;
    const [mean, sd] = vwapStep(st, rt, src, reset, b);
    if (args[2] === undefined) return mean;
    const m = num(args[2]);
    return new Tuple([mean, mean + sd * m, mean - sd * m]);
  },
  { asVariable: true },
);

// ------------------------------------------------------------------ change and momentum

function changeState() {
  return { src: [] as unknown[] };
}

stateful('ta.change', ['source', 'length'], 1, changeState, ([s, l], st, rt) => {
  const b = rt.bar;
  st.src[b] = s;
  const n = l === undefined ? 1 : len(l);
  const past = b - n >= 0 ? st.src[b - n] : undefined;
  if (typeof s === 'boolean') return past === undefined ? false : s !== past;
  return num(s) - (past === undefined ? NaN : num(past));
});

stateful('ta.mom', ['source', 'length'], 2, newSrc, ([s, l], st, rt) => {
  const b = rt.bar;
  st.src[b] = num(s);
  return num(s) - at(st.src, b - len(l));
});

stateful('ta.roc', ['source', 'length'], 2, newSrc, ([s, l], st, rt) => {
  const b = rt.bar;
  const x = num(s);
  st.src[b] = x;
  const past = at(st.src, b - len(l));
  return (100 * (x - past)) / past;
});

stateful('ta.cum', ['source'], 1, () => ({ out: [] as Arr }), ([s], st, rt) => {
  const b = rt.bar;
  const x = num(s);
  const out = (b > 0 ? at(st.out, b - 1) : 0) + (x === x ? x : 0);
  st.out[b] = out;
  return out;
});

// ------------------------------------------------------------------ highest and lowest

for (const [name, sign, source] of [
  ['highest', 1, 'high'],
  ['lowest', -1, 'low'],
] as const) {
  stateful(`ta.${name}`, ['source', 'length'], 2, newSrc, ([s, l], st, rt) => {
    const b = rt.bar;
    st.src[b] = num(s);
    return windowExtreme(st.src, b, len(l), sign)[0];
  }, { implicitSource: source });
  stateful(`ta.${name}bars`, ['source', 'length'], 2, newSrc, ([s, l], st, rt) => {
    const b = rt.bar;
    st.src[b] = num(s);
    return -windowExtreme(st.src, b, len(l), sign)[1];
  }, { implicitSource: source });
}

// ------------------------------------------------------------------ crosses and direction

function pairState() {
  return { a: [] as Arr, b: [] as Arr };
}

function pairStep(st: ReturnType<typeof pairState>, x: unknown, y: unknown, b: number): [number, number, number, number] {
  const a = num(x);
  const c = num(y);
  st.a[b] = a;
  st.b[b] = c;
  return [a, c, at(st.a, b - 1), at(st.b, b - 1)];
}

stateful('ta.crossover', ['source1', 'source2'], 2, pairState, ([x, y], st, rt) => {
  const [a, b, a1, b1] = pairStep(st, x, y, rt.bar);
  return a > b && a1 <= b1;
});

stateful('ta.crossunder', ['source1', 'source2'], 2, pairState, ([x, y], st, rt) => {
  const [a, b, a1, b1] = pairStep(st, x, y, rt.bar);
  return a < b && a1 >= b1;
});

stateful('ta.cross', ['source1', 'source2'], 2, pairState, ([x, y], st, rt) => {
  const [a, b, a1, b1] = pairStep(st, x, y, rt.bar);
  return (a > b && a1 <= b1) || (a < b && a1 >= b1);
});

for (const [name, up] of [
  ['rising', true],
  ['falling', false],
] as const) {
  stateful(`ta.${name}`, ['source', 'length'], 2, newSrc, ([s, l], st, rt) => {
    const b = rt.bar;
    const x = num(s);
    st.src[b] = x;
    const n = len(l);
    if (!(n >= 1) || b < n) return false;
    for (let k = 1; k <= n; k++) {
      const v = at(st.src, b - k);
      if (!(up ? x > v : x < v)) return false;
    }
    return true;
  });
}

// ------------------------------------------------------------------ events

stateful(
  'ta.valuewhen',
  ['condition', 'source', 'occurrence'],
  3,
  () => ({ bars: [] as number[], values: [] as unknown[] }),
  ([c, s, o], st, rt) => {
    const b = rt.bar;
    // Forget anything recorded by an earlier run of this same bar.
    while (st.bars.length > 0 && st.bars[st.bars.length - 1] >= b) {
      st.bars.pop();
      st.values.pop();
    }
    if (c === true || (typeof c === 'number' && c !== 0 && c === c)) {
      st.bars.push(b);
      st.values.push(s);
    }
    const k = st.values.length - 1 - Math.floor(num(o));
    if (k < 0 || k >= st.values.length) return typeof s === 'number' || s === undefined ? NaN : null;
    return st.values[k];
  },
);

stateful('ta.barssince', ['condition'], 1, () => ({ last: [] as Arr }), ([c], st, rt) => {
  const b = rt.bar;
  const hit = c === true || (typeof c === 'number' && c !== 0 && c === c);
  const last = hit ? b : at(st.last, b - 1);
  st.last[b] = last;
  return b - last;
});

for (const [name, sign, source] of [
  ['pivothigh', 1, 'high'],
  ['pivotlow', -1, 'low'],
] as const) {
  stateful(`ta.${name}`, ['source', 'leftbars', 'rightbars'], 3, newSrc, ([s, lb, rb], st, rt) => {
    const b = rt.bar;
    st.src[b] = num(s);
    const left = Math.floor(num(lb));
    const right = Math.floor(num(rb));
    if (!(left >= 0) || !(right >= 0) || b < left + right) return NaN;
    const p = b - right;
    const center = at(st.src, p);
    if (center !== center) return NaN;
    for (let i = p - left; i <= b; i++) {
      if (i === p) continue;
      const v = at(st.src, i);
      if (v !== v) return NaN;
      if (sign === 1 ? v >= center : v <= center) return NaN;
    }
    return center;
  }, { implicitSource: source });
}

// ------------------------------------------------------------------ statistics

stateful('ta.linreg', ['source', 'length', 'offset'], 3, newSrc, ([s, l, o], st, rt) => {
  const b = rt.bar;
  st.src[b] = num(s);
  const n = len(l);
  if (!(n >= 1) || b < n - 1) return NaN;
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  for (let k = 0; k < n; k++) {
    const x = k;
    const y = st.src[b - n + 1 + k] as number;
    if (y !== y || y === undefined) return NaN;
    sx += x;
    sy += y;
    sxy += x * y;
    sxx += x * x;
  }
  const denom = n * sxx - sx * sx;
  const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  return intercept + slope * (n - 1 - num(o));
});

stateful('ta.correlation', ['source1', 'source2', 'length'], 3, pairState, ([x, y, l], st, rt) => {
  const b = rt.bar;
  pairStep(st, x, y, b);
  const n = len(l);
  const ma = windowMean(st.a, b, n);
  const mb = windowMean(st.b, b, n);
  if (ma !== ma || mb !== mb) return NaN;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = b - n + 1; i <= b; i++) {
    const da = st.a[i] - ma;
    const db = st.b[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  return cov / Math.sqrt(va * vb);
});

stateful('ta.percentrank', ['source', 'length'], 2, newSrc, ([s, l], st, rt) => {
  const b = rt.bar;
  const x = num(s);
  st.src[b] = x;
  const n = len(l);
  if (!(n >= 1) || b < n || x !== x) return NaN;
  let count = 0;
  for (let k = 1; k <= n; k++) {
    const v = at(st.src, b - k);
    if (v !== v) return NaN;
    if (v <= x) count++;
  }
  return (100 * count) / n;
});

stateful('ta.median', ['source', 'length'], 2, newSrc, ([s, l], st, rt) => {
  const b = rt.bar;
  st.src[b] = num(s);
  const n = len(l);
  if (!(n >= 1) || b < n - 1) return NaN;
  const w = st.src.slice(b - n + 1, b + 1);
  if (w.some((v) => v !== v || v === undefined)) return NaN;
  w.sort((p, q) => p - q);
  return n % 2 === 1 ? w[(n - 1) / 2] : (w[n / 2 - 1] + w[n / 2]) / 2;
});

// ------------------------------------------------------------------ math functions with memory

stateful('math.sum', ['source', 'length'], 2, newSrc, ([s, l], st, rt) => {
  const b = rt.bar;
  st.src[b] = num(s);
  return windowSum(st.src, b, len(l));
});

stateful('fixnan', ['source'], 1, () => ({ out: [] as unknown[] }), ([s], st, rt) => {
  const b = rt.bar;
  const missing = s === null || s === undefined || (typeof s === 'number' && s !== s);
  const out = missing ? (b > 0 ? st.out[b - 1] : s) : s;
  st.out[b] = out;
  return out === undefined ? NaN : out;
});

/** Names exported for tests and documentation. */
export function taFunctionNames(): string[] {
  return [...FUNCTIONS.keys()].filter((k) => k.startsWith('ta.'));
}

export type { BuiltinFunction };
