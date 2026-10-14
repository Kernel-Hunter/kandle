/** General built-ins: math, na handling, casts, colors, strings, arrays, time and bar state. */
import type { Runtime } from '../runtime';
import { Color, ScriptArray, isNa, truthy, valueToString, formatNumber } from '../values';
import { BuiltinError, CONSTANTS, VARIABLES, fn, num } from './registry';

// ------------------------------------------------------------------ na handling and casts

fn('na', ['x'], 1, ([x]) => isNa(x));
fn('nz', ['source', 'replacement'], 1, ([x, r]) => {
  if (!isNa(x)) return x;
  if (r !== undefined) return r;
  return typeof x === 'number' || x === undefined ? 0 : x;
});
fn('int', ['x'], 1, ([x]) => {
  const n = num(x);
  return n !== n ? NaN : Math.trunc(n);
});
fn('float', ['x'], 1, ([x]) => num(x));
fn('bool', ['x'], 1, ([x]) => truthy(x));
fn('string', ['x'], 1, ([x]) => (isNa(x) ? null : valueToString(x)));

// ------------------------------------------------------------------ math

const unary = (name: string, f: (x: number) => number) => fn(`math.${name}`, ['number'], 1, ([x]) => f(num(x)));
unary('abs', Math.abs);
unary('sqrt', Math.sqrt);
unary('log', Math.log);
unary('log10', Math.log10);
unary('exp', Math.exp);
unary('floor', Math.floor);
unary('ceil', Math.ceil);
unary('sin', Math.sin);
unary('cos', Math.cos);
unary('tan', Math.tan);
unary('asin', Math.asin);
unary('acos', Math.acos);
unary('atan', Math.atan);
unary('todegrees', (x) => (x * 180) / Math.PI);
unary('toradians', (x) => (x * Math.PI) / 180);
unary('sign', (x) => (x !== x ? NaN : Math.sign(x)));

fn('math.round', ['number', 'precision'], 1, ([x, p]) => {
  const v = num(x);
  if (p === undefined) return roundHalfAway(v);
  const f = 10 ** Math.max(0, Math.floor(num(p)));
  return roundHalfAway(v * f) / f;
});
fn('math.pow', ['base', 'exponent'], 2, ([a, b]) => num(a) ** num(b));
fn('math.max', ['number0', 'number1'], 1, (args) => reduceNums(args, Math.max), { variadic: true });
fn('math.min', ['number0', 'number1'], 1, (args) => reduceNums(args, Math.min), { variadic: true });
fn('math.avg', ['number0', 'number1'], 1, (args) => reduceNums(args, (a, b) => a + b) / args.length, { variadic: true });
fn('math.random', ['min', 'max', 'seed'], 0, ([lo, hi]) => {
  const a = lo === undefined ? 0 : num(lo);
  const b = hi === undefined ? 1 : num(hi);
  return a + Math.random() * (b - a);
});
fn('math.round_to_mintick', ['number'], 1, ([x], _s, rt) => Math.round(num(x) / rt.symbol.mintick) * rt.symbol.mintick);

function roundHalfAway(v: number): number {
  return v < 0 ? -Math.round(-v) : Math.round(v);
}

function reduceNums(args: unknown[], f: (a: number, b: number) => number): number {
  let acc = num(args[0]);
  for (let i = 1; i < args.length; i++) acc = f(acc, num(args[i]));
  return acc;
}

CONSTANTS.set('math.pi', Math.PI);
CONSTANTS.set('math.e', Math.E);
CONSTANTS.set('math.phi', (1 + Math.sqrt(5)) / 2);
CONSTANTS.set('math.rphi', 2 / (1 + Math.sqrt(5)));

// ------------------------------------------------------------------ colors

/** Named colors. Values follow the common Material palette. */
export const NAMED_COLORS: Record<string, string> = {
  aqua: '#00BCD4',
  black: '#363A45',
  blue: '#2196F3',
  fuchsia: '#E040FB',
  gray: '#787B86',
  green: '#4CAF50',
  lime: '#00E676',
  maroon: '#880E4F',
  navy: '#311B92',
  olive: '#808000',
  orange: '#FF9800',
  purple: '#9C27B0',
  red: '#FF5252',
  silver: '#B2B5BE',
  teal: '#00897B',
  white: '#FFFFFF',
  yellow: '#FFEB3B',
};

for (const [name, hex] of Object.entries(NAMED_COLORS)) CONSTANTS.set(`color.${name}`, Color.fromHex(hex));

const clampByte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

fn('color.new', ['color', 'transp'], 2, ([c, t]) => {
  if (!(c instanceof Color)) return null;
  const tr = num(t);
  return tr !== tr ? c : c.withTransparency(tr);
});
fn('color.rgb', ['red', 'green', 'blue', 'transp'], 3, ([r, g, b, t]) => {
  const tr = t === undefined ? 0 : num(t);
  if ([num(r), num(g), num(b)].some((x) => x !== x)) return null;
  return new Color(clampByte(num(r)), clampByte(num(g)), clampByte(num(b)), 1 - Math.min(100, Math.max(0, tr)) / 100);
});
fn('color.r', ['color'], 1, ([c]) => (c instanceof Color ? c.r : NaN));
fn('color.g', ['color'], 1, ([c]) => (c instanceof Color ? c.g : NaN));
fn('color.b', ['color'], 1, ([c]) => (c instanceof Color ? c.b : NaN));
fn('color.t', ['color'], 1, ([c]) => (c instanceof Color ? c.transparency : NaN));
fn('color.from_gradient', ['value', 'bottom_value', 'top_value', 'bottom_color', 'top_color'], 5, ([v, lo, hi, cl, ch]) => {
  if (!(cl instanceof Color) || !(ch instanceof Color)) return null;
  const x = num(v);
  const a = num(lo);
  const b = num(hi);
  if (x !== x || a !== a || b !== b) return null;
  const t = b === a ? 0 : Math.max(0, Math.min(1, (x - a) / (b - a)));
  const mix = (p: number, q: number) => p + (q - p) * t;
  return new Color(clampByte(mix(cl.r, ch.r)), clampByte(mix(cl.g, ch.g)), clampByte(mix(cl.b, ch.b)), mix(cl.a, ch.a));
});

// ------------------------------------------------------------------ strings

fn('str.tostring', ['value', 'format'], 1, ([v, f]) => (typeof f === 'string' ? valueToString(v, f) : valueToString(v)));
fn('str.tonumber', ['string'], 1, ([s]) => {
  const n = typeof s === 'string' && s.trim() !== '' ? Number(s) : NaN;
  return Number.isFinite(n) ? n : NaN;
});
fn('str.length', ['string'], 1, ([s]) => (typeof s === 'string' ? s.length : NaN));
fn('str.upper', ['source'], 1, ([s]) => (typeof s === 'string' ? s.toUpperCase() : null));
fn('str.lower', ['source'], 1, ([s]) => (typeof s === 'string' ? s.toLowerCase() : null));
fn('str.contains', ['source', 'str'], 2, ([s, x]) => typeof s === 'string' && typeof x === 'string' && s.includes(x));
fn('str.startswith', ['source', 'str'], 2, ([s, x]) => typeof s === 'string' && typeof x === 'string' && s.startsWith(x));
fn('str.endswith', ['source', 'str'], 2, ([s, x]) => typeof s === 'string' && typeof x === 'string' && s.endsWith(x));
fn('str.replace_all', ['source', 'target', 'replacement'], 3, ([s, t, r]) =>
  typeof s === 'string' && typeof t === 'string' ? s.split(t).join(String(r ?? '')) : null,
);
fn('str.substring', ['source', 'begin_pos', 'end_pos'], 2, ([s, a, b]) =>
  typeof s === 'string' ? s.substring(num(a), b === undefined ? undefined : num(b)) : null,
);
fn('str.format', ['formatString', 'arg0'], 1, ([f, ...rest]) => {
  if (typeof f !== 'string') return null;
  return f.replace(/\{(\d+)(?:,\s*number\s*,\s*([^}]*))?\}/g, (_m, i: string, pattern?: string) => {
    const v = rest[Number(i)];
    if (v === undefined) return '';
    return typeof v === 'number' && pattern ? formatNumber(v, pattern.trim()) : valueToString(v);
  });
}, { variadic: true });

// ------------------------------------------------------------------ arrays

const arr = (a: unknown, name: string): ScriptArray => {
  if (a instanceof ScriptArray) return a;
  throw new BuiltinError(`${name} needs an array, got ${a === null ? 'na' : typeof a}`);
};
const index = (a: ScriptArray, i: unknown): number => {
  let k = Math.floor(num(i));
  if (k < 0) k += a.items.length;
  if (!(k >= 0 && k < a.items.length)) throw new BuiltinError(`Index ${num(i)} is out of bounds; the array has ${a.items.length} elements`);
  return k;
};
const numbers = (a: ScriptArray) => a.items.map(num).filter((x) => x === x);

for (const t of ['float', 'int', 'bool', 'string', 'color']) {
  fn(`array.new_${t}`, ['size', 'initial_value'], 0, ([size, init]) => {
    const n = size === undefined ? 0 : Math.max(0, Math.floor(num(size)));
    const fill = init === undefined ? (t === 'float' || t === 'int' ? NaN : t === 'bool' ? false : null) : init;
    return new ScriptArray(new Array(n).fill(fill));
  });
}
fn('array.new', ['size', 'initial_value'], 0, ([size, init]) => {
  const n = size === undefined ? 0 : Math.max(0, Math.floor(num(size)));
  return new ScriptArray(new Array(n).fill(init === undefined ? NaN : init));
});
fn('array.from', ['arg0'], 0, (args) => new ScriptArray([...args]), { variadic: true });
fn('array.size', ['id'], 1, ([a]) => arr(a, 'array.size').items.length);
fn('array.get', ['id', 'index'], 2, ([a, i]) => {
  const x = arr(a, 'array.get');
  return x.items[index(x, i)];
});
fn('array.set', ['id', 'index', 'value'], 3, ([a, i, v]) => {
  const x = arr(a, 'array.set');
  x.items[index(x, i)] = v;
}, { mutates: true });
fn('array.push', ['id', 'value'], 2, ([a, v]) => {
  arr(a, 'array.push').items.push(v);
}, { mutates: true });
fn('array.unshift', ['id', 'value'], 2, ([a, v]) => {
  arr(a, 'array.unshift').items.unshift(v);
}, { mutates: true });
fn('array.insert', ['id', 'index', 'value'], 3, ([a, i, v]) => {
  arr(a, 'array.insert').items.splice(Math.floor(num(i)), 0, v);
}, { mutates: true });
fn('array.pop', ['id'], 1, ([a]) => {
  const x = arr(a, 'array.pop');
  if (x.items.length === 0) throw new BuiltinError('Cannot pop from an empty array');
  return x.items.pop();
}, { mutates: true });
fn('array.shift', ['id'], 1, ([a]) => {
  const x = arr(a, 'array.shift');
  if (x.items.length === 0) throw new BuiltinError('Cannot shift an empty array');
  return x.items.shift();
}, { mutates: true });
fn('array.remove', ['id', 'index'], 2, ([a, i]) => {
  const x = arr(a, 'array.remove');
  return x.items.splice(index(x, i), 1)[0];
}, { mutates: true });
fn('array.clear', ['id'], 1, ([a]) => {
  arr(a, 'array.clear').items.length = 0;
}, { mutates: true });
fn('array.first', ['id'], 1, ([a]) => {
  const x = arr(a, 'array.first');
  return x.items[index(x, 0)];
});
fn('array.last', ['id'], 1, ([a]) => {
  const x = arr(a, 'array.last');
  return x.items[index(x, -1)];
});
fn('array.includes', ['id', 'value'], 2, ([a, v]) => arr(a, 'array.includes').items.includes(v));
fn('array.indexof', ['id', 'value'], 2, ([a, v]) => arr(a, 'array.indexof').items.indexOf(v));
fn('array.copy', ['id'], 1, ([a]) => new ScriptArray([...arr(a, 'array.copy').items]));
fn('array.slice', ['id', 'index_from', 'index_to'], 3, ([a, f, t]) => new ScriptArray(arr(a, 'array.slice').items.slice(num(f), num(t))));
fn('array.reverse', ['id'], 1, ([a]) => {
  arr(a, 'array.reverse').items.reverse();
}, { mutates: true });
fn('array.sort', ['id', 'order'], 1, ([a, o]) => {
  const desc = o === 'descending';
  arr(a, 'array.sort').items.sort((p, q) => (desc ? num(q) - num(p) : num(p) - num(q)));
}, { mutates: true });
fn('array.sum', ['id'], 1, ([a]) => numbers(arr(a, 'array.sum')).reduce((s, x) => s + x, 0));
fn('array.avg', ['id'], 1, ([a]) => {
  const xs = numbers(arr(a, 'array.avg'));
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN;
});
fn('array.max', ['id'], 1, ([a]) => {
  const xs = numbers(arr(a, 'array.max'));
  return xs.length ? Math.max(...xs) : NaN;
});
fn('array.min', ['id'], 1, ([a]) => {
  const xs = numbers(arr(a, 'array.min'));
  return xs.length ? Math.min(...xs) : NaN;
});
fn('array.stdev', ['id', 'biased'], 1, ([a, biased]) => {
  const xs = numbers(arr(a, 'array.stdev'));
  if (xs.length === 0) return NaN;
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const ss = xs.reduce((s, x) => s + (x - mean) ** 2, 0);
  return Math.sqrt(ss / (biased === false ? xs.length - 1 : xs.length));
});
CONSTANTS.set('order.ascending', 'ascending');
CONSTANTS.set('order.descending', 'descending');

// ------------------------------------------------------------------ bar data and time

const utc = (rt: Runtime) => new Date(rt.time[rt.bar]);
const bar = (rt: Runtime, a: number[]) => a[rt.bar];

VARIABLES.set('open', (rt) => bar(rt, rt.open));
VARIABLES.set('high', (rt) => bar(rt, rt.high));
VARIABLES.set('low', (rt) => bar(rt, rt.low));
VARIABLES.set('close', (rt) => bar(rt, rt.close));
VARIABLES.set('volume', (rt) => bar(rt, rt.volume));
VARIABLES.set('time', (rt) => bar(rt, rt.time));
VARIABLES.set('time_close', (rt) => bar(rt, rt.time) + rt.symbol.periodSeconds * 1000);
VARIABLES.set('hl2', (rt) => (rt.high[rt.bar] + rt.low[rt.bar]) / 2);
VARIABLES.set('hlc3', (rt) => (rt.high[rt.bar] + rt.low[rt.bar] + rt.close[rt.bar]) / 3);
VARIABLES.set('ohlc4', (rt) => (rt.open[rt.bar] + rt.high[rt.bar] + rt.low[rt.bar] + rt.close[rt.bar]) / 4);
VARIABLES.set('hlcc4', (rt) => (rt.high[rt.bar] + rt.low[rt.bar] + 2 * rt.close[rt.bar]) / 4);
VARIABLES.set('bar_index', (rt) => rt.bar);
VARIABLES.set('last_bar_index', (rt) => rt.count - 1);
VARIABLES.set('last_bar_time', (rt) => rt.time[rt.count - 1]);
VARIABLES.set('timenow', () => Date.now());
VARIABLES.set('year', (rt) => utc(rt).getUTCFullYear());
VARIABLES.set('month', (rt) => utc(rt).getUTCMonth() + 1);
VARIABLES.set('weekofyear', (rt) => isoWeek(utc(rt)));
VARIABLES.set('dayofmonth', (rt) => utc(rt).getUTCDate());
VARIABLES.set('dayofweek', (rt) => utc(rt).getUTCDay() + 1);
VARIABLES.set('hour', (rt) => utc(rt).getUTCHours());
VARIABLES.set('minute', (rt) => utc(rt).getUTCMinutes());
VARIABLES.set('second', (rt) => utc(rt).getUTCSeconds());

VARIABLES.set('barstate.isfirst', (rt) => rt.bar === 0);
VARIABLES.set('barstate.islast', (rt) => rt.bar === rt.count - 1);
VARIABLES.set('barstate.ishistory', (rt) => !(rt.realtime && rt.bar === rt.count - 1));
VARIABLES.set('barstate.isrealtime', (rt) => rt.realtime && rt.bar === rt.count - 1);
VARIABLES.set('barstate.isconfirmed', (rt) => !(rt.realtime && rt.bar === rt.count - 1));
VARIABLES.set('barstate.isnew', () => true);
VARIABLES.set('barstate.islastconfirmedhistory', (rt) => rt.bar === (rt.realtime ? rt.count - 2 : rt.count - 1));

VARIABLES.set('syminfo.ticker', (rt) => rt.symbol.ticker);
VARIABLES.set('syminfo.tickerid', (rt) => rt.symbol.ticker);
VARIABLES.set('syminfo.mintick', (rt) => rt.symbol.mintick);
VARIABLES.set('timeframe.period', (rt) => rt.symbol.period);
VARIABLES.set('timeframe.multiplier', (rt) => {
  const m = /^(\d+)/.exec(rt.symbol.period);
  return m ? Number(m[1]) : 1;
});
VARIABLES.set('timeframe.in_seconds', (rt) => rt.symbol.periodSeconds);
VARIABLES.set('timeframe.isintraday', (rt) => rt.symbol.periodSeconds < 86400);
VARIABLES.set('timeframe.isdaily', (rt) => rt.symbol.periodSeconds === 86400);
VARIABLES.set('timeframe.isweekly', (rt) => rt.symbol.periodSeconds === 604800);
VARIABLES.set('timeframe.isminutes', (rt) => rt.symbol.periodSeconds < 86400);
VARIABLES.set('timeframe.isseconds', (rt) => rt.symbol.periodSeconds < 60);

function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  return Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
}

/** Start of the UTC bucket containing `t` for "D", "W", "M", or an intraday minute count. */
function bucket(t: number, tf: string): number {
  const d = new Date(t);
  const m = /^(\d*)([DWM]?)$/.exec(tf.trim().toUpperCase());
  if (!m) throw new BuiltinError(`Unknown timeframe "${tf}"`);
  const mult = m[1] ? Number(m[1]) : 1;
  switch (m[2]) {
    case 'D':
      return Math.floor(t / (86_400_000 * mult));
    case 'W': {
      // Weeks start on Monday 00:00 UTC.
      return Math.floor((t + 3 * 86_400_000) / (604_800_000 * mult));
    }
    case 'M':
      return Math.floor((d.getUTCFullYear() * 12 + d.getUTCMonth()) / mult);
    default:
      return Math.floor(t / (60_000 * mult));
  }
}

fn('timeframe.change', ['timeframe'], 1, ([tf], _s, rt) => {
  const b = rt.bar;
  if (b === 0) return true;
  return bucket(rt.time[b], String(tf)) !== bucket(rt.time[b - 1], String(tf));
});

fn('timestamp', ['year', 'month', 'day', 'hour', 'minute', 'second'], 3, ([y, mo, d, h, mi, s]) =>
  Date.UTC(num(y), num(mo) - 1, num(d), h === undefined ? 0 : num(h), mi === undefined ? 0 : num(mi), s === undefined ? 0 : num(s)),
);

// Alerts are handled elsewhere in the app; scripts may declare them without effect for now.
fn('alertcondition', ['condition', 'title', 'message'], 1, () => undefined);
