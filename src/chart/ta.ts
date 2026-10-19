/**
 * Small technical-analysis helpers for the indicators the chart engine does not ship.
 * Every function returns an array aligned with the input, using `undefined` until enough
 * bars exist.
 */

export interface Bar {
  high: number;
  low: number;
  close: number;
  volume?: number;
  timestamp: number;
}

export type Series = Array<number | undefined>;

/** Wilder's Average True Range. */
export function atr(bars: Bar[], length: number): Series {
  const out: Series = new Array(bars.length).fill(undefined);
  if (length < 1) return out;
  let prevAtr: number | undefined;
  let trSum = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const prevClose = i > 0 ? bars[i - 1].close : b.close;
    const tr = Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose));
    if (i < length) {
      trSum += tr;
      if (i === length - 1) {
        prevAtr = trSum / length;
        out[i] = prevAtr;
      }
    } else {
      prevAtr = ((prevAtr as number) * (length - 1) + tr) / length;
      out[i] = prevAtr;
    }
  }
  return out;
}

/** Linearly weighted moving average of closes. */
export function wma(values: number[], length: number): Series {
  const out: Series = new Array(values.length).fill(undefined);
  if (length < 1) return out;
  const denom = (length * (length + 1)) / 2;
  for (let i = length - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = 0; j < length; j++) sum += values[i - j] * (length - j);
    out[i] = sum / denom;
  }
  return out;
}

/** Highest high and lowest low over `length` bars, plus the midline. */
export function donchian(bars: Bar[], length: number): Array<{ upper?: number; middle?: number; lower?: number }> {
  return bars.map((_, i) => {
    if (length < 1 || i < length - 1) return {};
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - length + 1; j <= i; j++) {
      hi = Math.max(hi, bars[j].high);
      lo = Math.min(lo, bars[j].low);
    }
    return { upper: hi, middle: (hi + lo) / 2, lower: lo };
  });
}

/** Volume weighted average price that restarts every UTC day. */
export function vwap(bars: Bar[]): Series {
  let day = -1;
  let pv = 0;
  let vol = 0;
  return bars.map((b) => {
    const d = Math.floor(b.timestamp / 86_400_000);
    if (d !== day) {
      day = d;
      pv = 0;
      vol = 0;
    }
    const typical = (b.high + b.low + b.close) / 3;
    const v = b.volume ?? 0;
    pv += typical * v;
    vol += v;
    return vol > 0 ? pv / vol : typical;
  });
}

/** Wilder RSI of closes. */
export function rsi(values: number[], length: number): Series {
  const out: Series = new Array(values.length).fill(undefined);
  if (length < 1 || values.length <= length) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  gain /= length;
  loss /= length;
  out[length] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = length + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    gain = (gain * (length - 1) + Math.max(diff, 0)) / length;
    loss = (loss * (length - 1) + Math.max(-diff, 0)) / length;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

function smaOfSeries(values: Series, length: number): Series {
  const out: Series = new Array(values.length).fill(undefined);
  for (let i = 0; i < values.length; i++) {
    if (i < length - 1) continue;
    let sum = 0;
    let ok = true;
    for (let j = i - length + 1; j <= i; j++) {
      const v = values[j];
      if (v === undefined) {
        ok = false;
        break;
      }
      sum += v;
    }
    if (ok) out[i] = sum / length;
  }
  return out;
}

/** Stochastic RSI with %K and %D smoothing. */
export function stochRsi(
  values: number[],
  rsiLength: number,
  stochLength: number,
  kSmooth: number,
  dSmooth: number,
): Array<{ k?: number; d?: number }> {
  const r = rsi(values, rsiLength);
  const raw: Series = r.map((_, i) => {
    if (i < stochLength - 1) return undefined;
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - stochLength + 1; j <= i; j++) {
      const v = r[j];
      if (v === undefined) return undefined;
      hi = Math.max(hi, v);
      lo = Math.min(lo, v);
    }
    const cur = r[i] as number;
    return hi === lo ? 0 : ((cur - lo) / (hi - lo)) * 100;
  });
  const k = smaOfSeries(raw, Math.max(1, kSmooth));
  const d = smaOfSeries(k, Math.max(1, dSmooth));
  return k.map((kv, i) => ({ k: kv, d: d[i] }));
}

/** Hull moving average: WMA(2 * WMA(n/2) - WMA(n), sqrt(n)). */
export function hma(values: number[], length: number): Series {
  const half = wma(values, Math.max(1, Math.floor(length / 2)));
  const full = wma(values, length);
  const diff: number[] = [];
  const index: number[] = [];
  values.forEach((_, i) => {
    const h = half[i];
    const f = full[i];
    if (h !== undefined && f !== undefined) {
      diff.push(2 * h - f);
      index.push(i);
    }
  });
  const smoothed = wma(diff, Math.max(1, Math.round(Math.sqrt(length))));
  const out: Series = new Array(values.length).fill(undefined);
  smoothed.forEach((v, j) => {
    out[index[j]] = v;
  });
  return out;
}

/** Supertrend line and direction (1 up, -1 down). */
export function supertrend(bars: Bar[], length: number, multiplier: number): Array<{ up?: number; down?: number }> {
  const a = atr(bars, length);
  const out: Array<{ up?: number; down?: number }> = [];
  let upper = 0;
  let lower = 0;
  let dir = 1;
  for (let i = 0; i < bars.length; i++) {
    const v = a[i];
    if (v === undefined) {
      out.push({});
      continue;
    }
    const b = bars[i];
    const mid = (b.high + b.low) / 2;
    const basicUpper = mid + multiplier * v;
    const basicLower = mid - multiplier * v;
    const prevClose = i > 0 ? bars[i - 1].close : b.close;
    const first = out.length === 0 || a[i - 1] === undefined;
    upper = first || basicUpper < upper || prevClose > upper ? basicUpper : upper;
    lower = first || basicLower > lower || prevClose < lower ? basicLower : lower;
    if (!first) {
      if (dir === 1 && b.close < lower) dir = -1;
      else if (dir === -1 && b.close > upper) dir = 1;
    }
    out.push(dir === 1 ? { up: lower } : { down: upper });
  }
  return out;
}

export interface IchimokuRow {
  conversion?: number;
  base?: number;
  /** Leading span A at this bar, computed `displacement` bars earlier. */
  spanA?: number;
  spanB?: number;
  /** Close from `displacement` bars later, so it is empty for the newest bars. */
  lagging?: number;
  /** Span A and B as computed on this bar, before the forward shift. The draw callback reads these to extend the cloud past the last bar. */
  leadA?: number;
  leadB?: number;
}

/** Midpoint of the highest high and lowest low over `length` bars ending at each bar. */
function midpoints(bars: Bar[], length: number): Series {
  return donchian(bars, length).map((d) => d.middle);
}

/**
 * Ichimoku Kinko Hyo. Conversion and base lines are the midpoints of the high-low range over
 * their lengths. Leading span A is the average of the two, leading span B the midpoint over
 * `spanBLength`; both are plotted `displacement` bars ahead of the bar they were computed on.
 * The lagging span is the close plotted `displacement` bars back.
 */
export function ichimoku(bars: Bar[], conversionLength: number, baseLength: number, spanBLength: number, displacement: number): IchimokuRow[] {
  const conv = midpoints(bars, conversionLength);
  const base = midpoints(bars, baseLength);
  const leadB = midpoints(bars, spanBLength);
  const leadA: Series = conv.map((c, i) => {
    const b = base[i];
    return c === undefined || b === undefined ? undefined : (c + b) / 2;
  });
  const d = Math.max(0, displacement);
  return bars.map((_, i) => ({
    conversion: conv[i],
    base: base[i],
    spanA: i >= d ? leadA[i - d] : undefined,
    spanB: i >= d ? leadB[i - d] : undefined,
    lagging: i + d < bars.length ? bars[i + d].close : undefined,
    leadA: leadA[i],
    leadB: leadB[i],
  }));
}
