import { describe, expect, it } from 'vitest';
import * as ref from './reference';
import * as chartTa from '../../src/chart/ta';
import { CANDLES, expectSeriesClose, plotValues, run } from './fixtures';
import { taFunctionNames } from '../../src/script/builtins/ta';

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
      'correlation', 'percentrank', 'median', 'dmi', 'wpr',
    ].map((n) => `ta.${n}`));
    expect(taFunctionNames().filter((n) => !tested.has(n))).toEqual([]);
  });

  it('wpr', () => {
    const hh = ref.highest(high, 14);
    const ll = ref.lowest(low, 14);
    check('ta.wpr(14)', close.map((v, i) => (100 * (v - hh[i])) / (hh[i] - ll[i])));
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
