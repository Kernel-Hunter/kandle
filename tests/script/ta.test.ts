import { describe, expect, it } from 'vitest';
import * as ref from './reference';
import * as chartTa from '../../src/chart/ta';
import { CANDLES, expectSeriesClose, plotValues, run } from './fixtures';
import { taFunctionNames } from '../../src/script/builtins/ta';
import type { Candle } from '../../src/script/runtime';

const c = CANDLES;
const close = c.map((b) => b.close);
const high = c.map((b) => b.high);
const low = c.map((b) => b.low);
const open = c.map((b) => b.open);
const volume = c.map((b) => b.volume!);
const hl2 = c.map((b) => (b.high + b.low) / 2);
const hlc3 = c.map((b) => (b.high + b.low + b.close) / 3);
const bool = (xs: boolean[]) => xs.map((x) => (x ? 1 : 0));
const fromChart = (xs: Array<number | undefined>) => xs.map((x) => (x === undefined ? NaN : x));

/** Runs `plot(expr)` lines and returns each plot's values. */
function plots(...exprs: string[]): number[][] {
  const engine = run(`indicator("t")\n${exprs.map((e) => `plot(${e})`).join('\n')}`);
  return exprs.map((_, i) => plotValues(engine, i));
}

function check(expr: string, expected: Array<number | undefined>): void {
  expectSeriesClose(plots(expr)[0], expected);
}

describe('ta.* matches reference implementations (1e-9)', () => {
  it('moving averages', () => {
    check('ta.sma(close, 14)', ref.sma(close, 14));
    check('ta.ema(close, 20)', ref.ema(close, 20));
    check('ta.rma(close, 10)', ref.rma(close, 10));
    check('ta.wma(close, 9)', ref.wma(close, 9));
    check('ta.vwma(close, 12)', ref.vwma(close, volume, 12));
    check('ta.hma(close, 21)', ref.hma(close, 21));
    check('ta.alma(close, 9, 0.85, 6)', ref.alma(close, 9, 0.85, 6));
    check('ta.alma(close, 9, 0.85, 6, true)', ref.alma(close, 9, 0.85, 6, true));
    check('ta.alma(hl2, 20, 0.5, 4)', ref.alma(hl2, 20, 0.5, 4));
    check('ta.swma(close)', ref.swma(close));
  });

  it('agrees with the chart helpers in src/chart/ta.ts', () => {
    check('ta.wma(close, 20)', fromChart(chartTa.wma(close, 20)));
    check('ta.rsi(close, 14)', fromChart(chartTa.rsi(close, 14)));
    check('ta.atr(14)', fromChart(chartTa.atr(c, 14)));
    check('ta.vwap(hlc3)', fromChart(chartTa.vwap(c)));
    // The chart's HMA rounds sqrt(n); for n = 16 both conventions agree.
    check('ta.hma(close, 16)', fromChart(chartTa.hma(close, 16)));
  });

  it('oscillators', () => {
    check('ta.rsi(close, 14)', ref.rsi(close, 14));
    const engine = run(`indicator("m")\n[a, b, d] = ta.macd(close, 12, 26, 9)\nplot(a)\nplot(b)\nplot(d)`);
    const macd = ref.sub(ref.ema(close, 12), ref.ema(close, 26));
    const sig = ref.ema(macd, 9);
    expectSeriesClose(plotValues(engine, 0), macd);
    expectSeriesClose(plotValues(engine, 1), sig);
    expectSeriesClose(plotValues(engine, 2), ref.sub(macd, sig));
    check('ta.stoch(close, high, low, 14)', ref.stoch(close, high, low, 14));
    check('ta.cci(hlc3, 20)', ref.cci(hlc3, 20));
    check('ta.mfi(hlc3, 14)', ref.mfi(c, hlc3, 14));
    check('ta.mom(close, 10)', ref.change(close, 10));
    check('ta.roc(close, 9)', ref.roc(close, 9));
    check('ta.change(close)', ref.change(close));
    check('ta.change(close, 3)', ref.change(close, 3));
    check('ta.cmo(close, 9)', ref.cmo(close, 9));
    check('ta.cmo(hlc3, 14)', ref.cmo(hlc3, 14));
    check('ta.tsi(close, 13, 25)', ref.tsi(close, 13, 25));
    check('ta.tsi(close, 5, 10)', ref.tsi(close, 5, 10));
  });

  it('dmi', () => {
    const engine = run(`indicator("d")\n[p, m, a] = ta.dmi(14, 14)\nplot(p)\nplot(m)\nplot(a)`);
    const d = ref.dmi(c, 14, 14);
    expectSeriesClose(plotValues(engine, 0), d.plus);
    expectSeriesClose(plotValues(engine, 1), d.minus);
    expectSeriesClose(plotValues(engine, 2), d.adx);
  });

  it('volatility and bands', () => {
    check('ta.tr', ref.tr(c, false));
    check('ta.tr(true)', ref.tr(c, true));
    check('ta.atr(14)', ref.rma(ref.tr(c, true), 14));
    check('ta.stdev(close, 20)', ref.stdev(close, 20));
    check('ta.stdev(close, 20, false)', ref.stdev(close, 20, false));
    check('ta.variance(close, 20)', ref.variance(close, 20));
    check('ta.dev(close, 20)', ref.meanDev(close, 20));
    const engine = run(`indicator("b")\n[m, u, l] = ta.bb(close, 20, 2)\nplot(m)\nplot(u)\nplot(l)\nplot(ta.bbw(close, 20, 2))`);
    const mid = ref.sma(close, 20);
    const dev = ref.mul(ref.stdev(close, 20), 2);
    expectSeriesClose(plotValues(engine, 0), mid);
    expectSeriesClose(plotValues(engine, 1), ref.add(mid, dev));
    expectSeriesClose(plotValues(engine, 2), ref.sub(mid, dev));
    expectSeriesClose(plotValues(engine, 3), ref.div(ref.mul(dev, 2), mid));
    const kc = run(`indicator("k")\n[m, u, l] = ta.kc(close, 20, 1.5)\nplot(m)\nplot(u)\nplot(l)`);
    const kmid = ref.ema(close, 20);
    const krange = ref.mul(ref.ema(ref.tr(c, false), 20), 1.5);
    expectSeriesClose(plotValues(kc, 0), kmid);
    expectSeriesClose(plotValues(kc, 1), ref.add(kmid, krange));
    expectSeriesClose(plotValues(kc, 2), ref.sub(kmid, krange));
    check('ta.kcw(close, 20, 1.5)', ref.kcw(c, close, 20, 1.5));
    check('ta.kcw(hlc3, 10, 2)', ref.kcw(c, hlc3, 10, 2));
    check('ta.range(close, 14)', ref.range(close, 14));
    check('ta.range(high, 5)', ref.range(high, 5));
  });

  it('sar', () => {
    const r = ref.sar(c, 0.02, 0.02, 0.2);
    check('ta.sar(0.02, 0.02, 0.2)', r);
    check('ta.sar(0.01, 0.03, 0.15)', ref.sar(c, 0.01, 0.03, 0.15));
    // The stop flips sides many times on the fixture: below the low in uptrends, above the high in downtrends.
    const below = r.filter((v, i) => v <= low[i]).length;
    const above = r.filter((v, i) => v >= high[i]).length;
    expect(below).toBeGreaterThan(20);
    expect(above).toBeGreaterThan(20);
  });

  it('supertrend', () => {
    const engine = run(`indicator("s")\n[st, dir] = ta.supertrend(3, 10)\nplot(st)\nplot(dir)`);
    const r = ref.supertrend(c, 3, 10);
    expectSeriesClose(plotValues(engine, 0), r.line);
    expectSeriesClose(plotValues(engine, 1), r.dir);
    // Both directions occur on the fixture, so the test covers flips.
    expect(new Set(r.dir.filter((d) => !Number.isNaN(d)))).toEqual(new Set([1, -1]));
  });

  it('volume indicators', () => {
    check('ta.obv', ref.obv(c));
    check('ta.cum(volume)', ref.cum(volume));
    check('ta.vwap', ref.vwapDaily(c, hlc3).mid);
    check('ta.vwap(close)', ref.vwapDaily(c, close).mid);
    const engine = run(`indicator("v")\n[m, u, l] = ta.vwap(hlc3, timeframe.change("D"), 2)\nplot(m)\nplot(u)\nplot(l)`);
    const r = ref.vwapDaily(c, hlc3, 2);
    expectSeriesClose(plotValues(engine, 0), r.mid);
    expectSeriesClose(plotValues(engine, 1), r.upper);
    expectSeriesClose(plotValues(engine, 2), r.lower);
  });

  it('highest, lowest and their offsets', () => {
    check('ta.highest(high, 20)', ref.highest(high, 20));
    check('ta.highest(20)', ref.highest(high, 20));
    check('ta.lowest(low, 20)', ref.lowest(low, 20));
    check('ta.lowest(20)', ref.lowest(low, 20));
    check('ta.highestbars(high, 10)', ref.highestbars(high, 10));
    check('ta.lowestbars(low, 10)', ref.lowestbars(low, 10));
    check('ta.highestbars(10)', ref.highestbars(high, 10));
  });

  it('crosses and direction', () => {
    const fast = ref.sma(close, 5);
    const slow = ref.sma(close, 20);
    const over = ref.crossover(fast, slow);
    const under = ref.crossunder(fast, slow);
    check('ta.crossover(ta.sma(close, 5), ta.sma(close, 20))', bool(over));
    check('ta.crossunder(ta.sma(close, 5), ta.sma(close, 20))', bool(under));
    check('ta.cross(ta.sma(close, 5), ta.sma(close, 20))', bool(over.map((o, i) => o || under[i])));
    expect(over.filter(Boolean).length).toBeGreaterThan(3);
    check('ta.rising(close, 3)', bool(ref.rising(close, 3)));
    check('ta.falling(close, 3)', bool(ref.rising(close.map((v) => -v), 3)));
  });

  it('events', () => {
    const up = close.map((v, i) => v > open[i]);
    check('ta.barssince(close > open)', ref.barssince(up));
    check('ta.valuewhen(close > open, close, 0)', ref.valuewhen(up, close, 0));
    check('ta.valuewhen(close > open, high, 2)', ref.valuewhen(up, high, 2));
    check('ta.pivothigh(high, 5, 5)', ref.pivot(high, 5, 5, true));
    check('ta.pivothigh(3, 2)', ref.pivot(high, 3, 2, true));
    check('ta.pivotlow(low, 5, 5)', ref.pivot(low, 5, 5, false));
    check('ta.pivotlow(4, 4)', ref.pivot(low, 4, 4, false));
  });

  it('statistics', () => {
    check('ta.linreg(close, 20, 0)', ref.linreg(close, 20, 0));
    check('ta.linreg(close, 14, 2)', ref.linreg(close, 14, 2));
    check('ta.correlation(close, volume, 20)', ref.correlation(close, volume, 20));
    check('ta.percentrank(close, 20)', ref.percentrank(close, 20));
    check('ta.median(close, 15)', ref.median(close, 15));
    check('ta.median(close, 10)', ref.median(close, 10));
    check('math.sum(close, 7)', ref.rollingSum(close, 7));
  });

  it('covers every ta function the engine exposes', () => {
    const tested = new Set([
      'sma', 'ema', 'rma', 'wma', 'vwma', 'hma', 'rsi', 'macd', 'stoch', 'atr', 'tr', 'bb', 'bbw', 'kc', 'cci', 'mfi', 'obv', 'vwap',
      'supertrend', 'change', 'mom', 'roc', 'highest', 'lowest', 'highestbars', 'lowestbars', 'crossover', 'crossunder', 'cross',
      'rising', 'falling', 'stdev', 'variance', 'dev', 'cum', 'valuewhen', 'barssince', 'pivothigh', 'pivotlow', 'linreg',
      'correlation', 'percentrank', 'median', 'dmi', 'wpr', 'alma', 'swma', 'cmo', 'tsi', 'range', 'kcw', 'sar',
    ].map((n) => `ta.${n}`));
    expect(taFunctionNames().filter((n) => !tested.has(n))).toEqual([]);
  });

  it('wpr', () => {
    const hh = ref.highest(high, 14);
    const ll = ref.lowest(low, 14);
    check('ta.wpr(14)', close.map((v, i) => (100 * (v - hh[i])) / (hh[i] - ll[i])));
  });
});

/** Small candles with chosen highs, lows and closes, one hour apart. */
function bars(rows: Array<[number, number, number]>): Candle[] {
  return rows.map(([h, l, cl], i) => ({ timestamp: Date.UTC(2026, 0, 1) + i * 3_600_000, open: cl, high: h, low: l, close: cl, volume: 1 }));
}

function plotOn(candles: Candle[], expr: string): number[] {
  return plotValues(run(`indicator("t")\nplot(${expr})`, candles), 0);
}

describe('new ta functions against hand-computed values', () => {
  const line = bars(Array.from({ length: 30 }, (_, i) => [i + 1, i - 1, i]));
  const idx = line.map((_, i) => i);
  const warm = (n: number, f: (i: number) => number) => idx.map((i) => (i < n ? NaN : f(i)));
  const allNa = idx.map(() => NaN);

  it('alma', () => {
    // Weights centred on the middle of the window are symmetric, so on a straight line the average is the middle value.
    expectSeriesClose(plotOn(line, 'ta.alma(bar_index, 5, 0.5, 6)'), warm(4, (i) => i - 2));
    expectSeriesClose(plotOn(line, 'ta.alma(7.5, 9, 0.85, 6)'), warm(8, () => 7.5));
    // na inside the window gives na until the window is clear of it again.
    expectSeriesClose(plotOn(line, 'ta.alma(bar_index == 10 ? na : bar_index, 5, 0.5, 6)'), warm(4, (i) => (i >= 10 && i <= 14 ? NaN : i - 2)));
    // Bad arguments give na instead of an error.
    expectSeriesClose(plotOn(line, 'ta.alma(close, 5, 0.85, 0)'), allNa);
  });

  it('swma', () => {
    // (x - 3 + 2(x - 2) + 2(x - 1) + x) / 6 = x - 1.5
    expectSeriesClose(plotOn(line, 'ta.swma(bar_index)'), warm(3, (i) => i - 1.5));
  });

  it('range', () => {
    expectSeriesClose(plotOn(line, 'ta.range(bar_index, 5)'), warm(4, () => 4));
    expectSeriesClose(plotOn(line, 'ta.range(high, 3)'), warm(2, () => 2));
  });

  it('cmo', () => {
    expectSeriesClose(plotOn(line, 'ta.cmo(close, 5)'), warm(5, () => 100));
    expectSeriesClose(plotOn(line, 'ta.cmo(-close, 5)'), warm(5, () => -100));
    // Flat input has no up or down moves: 0 / 0 is na.
    expectSeriesClose(plotOn(line, 'ta.cmo(3.0, 5)'), allNa);
    // Changes from bar 1 on: +1, +1, -1, +1, -1, +1. Over 3 changes, two up and one down give 100 * (2 - 1) / 3.
    const zig = bars([10, 11, 12, 11, 12, 11, 12].map((v) => [v, v, v]));
    expectSeriesClose(plotOn(zig, 'ta.cmo(close, 3)'), [NaN, NaN, NaN, 100 / 3, 100 / 3, -100 / 3, 100 / 3]);
  });

  it('tsi', () => {
    // A constant change of +1 gives a ratio of exactly 1 once both averages are seeded (bar long + short - 1).
    expectSeriesClose(plotOn(line, 'ta.tsi(close, 3, 5)'), warm(7, () => 1));
    expectSeriesClose(plotOn(line, 'ta.tsi(-close, 3, 5)'), warm(7, () => -1));
    expectSeriesClose(plotOn(line, 'ta.tsi(3.0, 3, 5)'), allNa);
  });

  it('kcw', () => {
    // Every bar has a range of 2 and true range 2, so the band width is 2 * 2 * mult around an EMA of the close.
    expectSeriesClose(plotOn(line, 'ta.kcw(close, 4, 1)'), warm(4, (i) => 4 / (i - 1.5)));
  });

  it('sar', () => {
    const c2 = bars([
      [10, 8, 9],
      [11, 9, 10.5],
      [12, 10, 11.5],
      [13, 11, 12.5],
      [12.5, 10, 10.5],
      [11, 9, 9.5],
      [10, 8, 8.5],
    ]);
    // Bar 1 starts an uptrend: stop 8 (lowest low), EP 11. Bar 2: 8.3 capped at the low of bar 0, 8; EP 12, AF 0.2.
    // Bar 3: 8 + 0.2 * 4 = 8.8; EP 13, AF 0.3. Bar 4: 8.8 + 0.3 * 4.2 = 10.06, capped at the low of bar 2, 10.
    // The low of bar 4 touches 10 without crossing it. Bar 5: 10.9 capped at 10, the low of 9 crosses it, so the
    // stop flips to the EP, 13, with EP 9 and AF 0.1. Bar 6: 13 + 0.1 * (9 - 13) = 12.6.
    expectSeriesClose(plotOn(c2, 'ta.sar(0.1, 0.1, 0.3)'), [NaN, 8, 8, 8.8, 10, 13, 12.6]);
    expectSeriesClose(plotOn(c2, 'ta.sar(na, 0.1, 0.3)'), c2.map(() => NaN));
  });
});

describe('ta state is per call site', () => {
  it('keeps separate state for each call of the same function', () => {
    const engine = run(`indicator("x")
f(src, n) => ta.ema(src, n)
plot(f(close, 10))
plot(f(open, 20))`);
    expectSeriesClose(plotValues(engine, 0), ref.ema(close, 10));
    expectSeriesClose(plotValues(engine, 1), ref.ema(open, 20));
  });

  it('accepts named arguments', () => {
    check('ta.sma(length = 10, source = close)', ref.sma(close, 10));
    check('ta.ema(source = hl2, length = 7)', ref.ema(hl2, 7));
  });
});
