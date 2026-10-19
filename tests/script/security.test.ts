import { describe, expect, it } from 'vitest';
import { compileScript, type ScriptEngine } from '../../src/script/engine';
import { alignBars, requestKey, requestTimeframe, resampleBars, type RequestFeeds, type ResolvedRequest } from '../../src/script/security';
import type { Candle, SymbolContext } from '../../src/script/runtime';
import { CANDLES, compile, expectSeriesClose, makeCandles, plotValues } from './fixtures';

const HOUR = 3_600_000;
const BTC_1H: SymbolContext = { ticker: 'BTCUSDT', period: '60', periodSeconds: 3600, mintick: 0.01, source: 'binance' };
const close = CANDLES.map((b) => b.close);
const n = CANDLES.length;

/** A feed that serves fixed series by request key and records what was asked for. */
function fakeFeeds(series: Record<string, Candle[]>, errors: Record<string, string> = {}) {
  const needs: Array<{ key: string; from: number }> = [];
  const feeds: RequestFeeds = {
    hasSource: (id) => id === 'binance' || id === 'csv',
    series: (req: ResolvedRequest) => {
      const key = requestKey(req);
      if (errors[key]) return { bars: [], version: 1, error: errors[key] };
      return series[key] ? { bars: series[key], version: 1 } : null;
    },
    need: (req, from) => needs.push({ key: requestKey(req), from }),
  };
  return { feeds, needs };
}

function engineFor(src: string, ctx: SymbolContext = BTC_1H, feeds: RequestFeeds | null = null): ScriptEngine {
  const e = compile(`indicator("t")\n${src}`);
  e.setSymbol(ctx);
  if (feeds) e.setFeeds(feeds);
  return e;
}

function values(src: string, candles: Candle[] = CANDLES, ctx: SymbolContext = BTC_1H, feeds: RequestFeeds | null = null, plot = 0): number[] {
  const e = engineFor(src, ctx, feeds);
  const r = e.run(candles);
  if (r.error) throw new Error(r.error.format());
  return plotValues(e, plot);
}

/** Daily close for day d of the hourly fixture: the close of its last hour (or of the last loaded hour). */
const dailyClose = (d: number) => close[Math.min(n - 1, d * 24 + 23)];

describe('request.security timeframes', () => {
  it('maps timeframe strings to bar sizes', () => {
    expect(requestTimeframe('60')).toBe('1h');
    expect(requestTimeframe('240')).toBe('4h');
    expect(requestTimeframe('D')).toBe('1D');
    expect(requestTimeframe('1D')).toBe('1D');
    expect(requestTimeframe('W')).toBe('1W');
    expect(requestTimeframe('5')).toBe('5m');
    expect(requestTimeframe('15m')).toBe('15m');
    expect(requestTimeframe('1M')).toBeNull();
    expect(requestTimeframe('30')).toBeNull();
  });
});

describe('request.security without lookahead', () => {
  it('shows a daily value from the chart bar where the day closed', () => {
    const got = values('plot(request.security(syminfo.tickerid, "D", close))');
    // Hour b closes at (b + 1) h; day j closes at (j + 1) * 24 h.
    const expected = close.map((_, b) => {
      const j = Math.floor((b + 1) / 24) - 1;
      return j >= 0 ? dailyClose(j) : NaN;
    });
    // The last bar sees the developing day (bars 384..399).
    expected[n - 1] = close[n - 1];
    expectSeriesClose(got, expected);
    expect(got[23]).toBe(close[23]);
    expect(got[22]).toBeNaN();
    expect(got[47]).toBe(close[47]);
    expect(got[46]).toBe(close[23]);
  });

  it('never lets a historical bar see later data', () => {
    const src = 'plot(request.security(syminfo.tickerid, "D", ta.sma(close, 3)))';
    const base = values(src);
    for (const t of [10, 23, 24, 100, 200, 300]) {
      // Different prices after bar t must not change anything up to bar t.
      const altered = CANDLES.map((c, i) => (i <= t ? c : { ...c, open: c.open * 3, high: c.high * 3, low: c.low * 3, close: c.close * 3 }));
      const got = values(src, altered);
      expectSeriesClose(got.slice(0, t + 1), base.slice(0, t + 1));
    }
  });

  it('computes the expression on daily bars, with variables and functions recomputed there', () => {
    const daily = resampleBars(CANDLES, '1D');
    const sma3 = daily.map((_, d) => (d >= 2 ? (daily[d].close + daily[d - 1].close + daily[d - 2].close) / 3 : NaN));
    const expected = close.map((_, b) => {
      const j = Math.floor((b + 1) / 24) - 1;
      return j >= 0 ? sma3[j] : NaN;
    });
    expected[n - 1] = sma3[sma3.length - 1];
    expectSeriesClose(values('plot(request.security(syminfo.tickerid, "D", ta.sma(close, 3)))'), expected);
    expectSeriesClose(values('s = ta.sma(close, 3)\nplot(request.security(syminfo.tickerid, "D", s))'), expected);
    expectSeriesClose(values('f() => ta.sma(close, 3)\nplot(request.security(syminfo.tickerid, "D", f()))'), expected);
    expectSeriesClose(values('len = input.int(3, "Length")\nplot(request.security(syminfo.tickerid, "1D", ta.sma(close, len)))'), expected);
    // The input is not added twice.
    expect(engineFor('len = input.int(3, "Length")\nplot(request.security(syminfo.tickerid, "D", ta.sma(close, len)))').inputs).toHaveLength(1);
  });

  it('keeps the chart script on chart bars', () => {
    const got = values('d = request.security(syminfo.tickerid, "D", close)\nplot(close - nz(d))');
    expect(got[0]).toBe(close[0]);
    expect(got[30]).toBeCloseTo(close[30] - close[23], 9);
  });

  it('returns tuples', () => {
    const e = engineFor('[o, c] = request.security(syminfo.tickerid, "D", [open, close])\nplot(o)\nplot(c)');
    expect(e.run(CANDLES).error).toBeNull();
    expect(plotValues(e, 0)[47]).toBe(CANDLES[24].open);
    expect(plotValues(e, 1)[47]).toBe(close[47]);
    expect(plotValues(e, 0)[10]).toBeNaN();
  });

  it('gives the same values after a live update as after a full run', () => {
    const src = 'plot(request.security(syminfo.tickerid, "D", ta.ema(close, 2)))';
    const e = engineFor(src);
    e.run(CANDLES.slice(0, n - 1));
    const live = [...CANDLES.slice(0, n - 1), { ...CANDLES[n - 1], close: CANDLES[n - 1].close + 5 }];
    const r = e.run(live);
    expect(r.incremental).toBe(true);
    expectSeriesClose(plotValues(e), values(src, live));
  });
});

describe('request.security options', () => {
  it('lookahead_on reads the day that contains the bar', () => {
    const got = values('plot(request.security(syminfo.tickerid, "D", close, lookahead = barmerge.lookahead_on))');
    expectSeriesClose(got, close.map((_, b) => dailyClose(Math.floor(b / 24))));
  });

  it('gaps_on shows a value only where a day closes', () => {
    const got = values('plot(request.security(syminfo.tickerid, "D", close, barmerge.gaps_on))');
    expectSeriesClose(got, close.map((c, b) => ((b + 1) % 24 === 0 ? c : NaN)));
  });

  it('gaps_on with lookahead_on shows the value on the first bar of each day', () => {
    const got = values('plot(request.security(syminfo.tickerid, "D", close, gaps = barmerge.gaps_on, lookahead = barmerge.lookahead_on))');
    expectSeriesClose(got, close.map((_, b) => (b % 24 === 0 ? dailyClose(b / 24) : NaN)));
  });

  it('aligns bars by close time', () => {
    // Chart bars of 1 h at 0..5 h, requested 2 h bars at 0, 2, 4 h.
    const chart = [0, 1, 2, 3, 4, 5].map((h) => h * HOUR);
    const req = [0, 2, 4].map((h) => h * HOUR);
    expect([...alignBars(chart, 6, HOUR, req, 3, 2 * HOUR, { lookahead: false, gaps: false })]).toEqual([-1, 0, 0, 1, 1, 2]);
    expect([...alignBars(chart, 5, HOUR, req, 3, 2 * HOUR, { lookahead: false, gaps: false })]).toEqual([-1, 0, 0, 1, 2]);
    expect([...alignBars(chart, 6, HOUR, req, 3, 2 * HOUR, { lookahead: true, gaps: false })]).toEqual([0, 0, 1, 1, 2, 2]);
    expect([...alignBars(chart, 6, HOUR, req, 3, 2 * HOUR, { lookahead: false, gaps: true })]).toEqual([-1, 0, -1, 1, -1, 2]);
  });
});

describe('request.security with other series', () => {
  const eth = makeCandles(n, 7);
  const ethClose = eth.map((b) => b.close);

  it('reads another symbol on the same source', () => {
    const { feeds, needs } = fakeFeeds({ 'binance|ETHUSDT|1h': eth });
    expectSeriesClose(values('plot(request.security("ETHUSDT", "60", close))', CANDLES, BTC_1H, feeds), ethClose);
    expectSeriesClose(values('plot(request.security("BINANCE:ETHUSDT", timeframe.period, close))', CANDLES, BTC_1H, feeds), ethClose);
    expect(needs[0]).toEqual({ key: 'binance|ETHUSDT|1h', from: CANDLES[0].timestamp });
  });

  it('lists the series a script needs', () => {
    const e = engineFor('a = request.security("ETHUSDT", "D", close)\nb = request.security(syminfo.tickerid, "D", close)\nc = request.security(syminfo.tickerid, "60", close)\nplot(a + b + c)');
    expect(e.requests().map(requestKey)).toEqual(['binance|ETHUSDT|1D', 'binance|BTCUSDT|1D']);
  });

  it('shows na while a series loads and reports a failed load', () => {
    const { feeds } = fakeFeeds({});
    const got = values('plot(request.security("ETHUSDT", "D", close))', CANDLES, BTC_1H, feeds);
    expect(got.every((v) => Number.isNaN(v))).toBe(true);
    const failing = fakeFeeds({}, { 'binance|NOPE|1D': 'Binance responded 400' }).feeds;
    const e = engineFor('plot(request.security("NOPE", "D", close))', BTC_1H, failing);
    expect(e.run(CANDLES).error?.message).toBe('Could not load NOPE 1D: Binance responded 400');
  });

  it('takes the last lower-timeframe bar that closed inside each chart bar', () => {
    const fourHour = resampleBars(CANDLES, '4h');
    const ctx: SymbolContext = { ...BTC_1H, period: '240', periodSeconds: 4 * 3600 };
    const { feeds } = fakeFeeds({ 'binance|BTCUSDT|1h': CANDLES });
    const got = values('plot(request.security(syminfo.tickerid, "60", close))', fourHour, ctx, feeds);
    expectSeriesClose(got, fourHour.map((_, i) => close[Math.min(n - 1, i * 4 + 3)]));
    // Lookahead has no effect on lower timeframes.
    const ahead = values('plot(request.security(syminfo.tickerid, "60", close, lookahead = barmerge.lookahead_on))', fourHour, ctx, feeds);
    expectSeriesClose(ahead, got);
  });

  it('works in strategies', () => {
    const src = `strategy("s", overlay = true)
d = request.security(syminfo.tickerid, "D", ta.sma(close, 2))
if close > d
    strategy.entry("L", strategy.long)
if close < d
    strategy.close("L")
plot(d)`;
    const r = compileScript(src);
    if (!r.ok) throw new Error(r.error.format());
    r.engine.setSymbol(BTC_1H);
    expect(r.engine.run(CANDLES).error).toBeNull();
    expect(r.engine.strategy!.trades.length).toBeGreaterThan(0);
  });
});

describe('request.security errors', () => {
  const error = (src: string) => {
    const r = compileScript(`indicator("t")\n${src}`);
    return r.ok ? null : r.error.message;
  };

  it('needs constant symbol and timeframe', () => {
    expect(error('plot(request.security(close > open ? "A" : "B", "D", close))')).toBe('request.security needs constant symbol and timeframe');
    expect(error('tf = input.string("D")\nplot(request.security(syminfo.tickerid, tf, close))')).toBe('request.security needs constant symbol and timeframe');
    expect(error('sym = "ETHUSDT"\nplot(request.security(sym, "D", close))')).toBeNull();
    expect(error('plot(request.security(syminfo.tickerid, "30", close))')).toBe('Timeframe "30" is not available; use 1, 5, 15, 60, 240, D or W');
  });

  it('allows at most five different requests', () => {
    const calls = ['A', 'B', 'C', 'D', 'E'].map((s) => `request.security("${s}", "D", close)`).join(' + ');
    expect(error(`plot(${calls})`)).toBeNull();
    expect(error(`plot(${calls} + request.security("F", "D", close))`)).toBe('A script can request at most 5 different symbol and timeframe pairs');
    // The same pair twice counts once.
    expect(error(`plot(${calls} + request.security("A", "D", open))`)).toBeNull();
  });

  it('rejects variables that cannot be recomputed on requested bars', () => {
    expect(error('var x = 0.0\nx += 1\nplot(request.security(syminfo.tickerid, "D", x))')).toMatch(/cannot use 'x' because it is declared with var/);
    expect(error('x = close\nplot(request.security(syminfo.tickerid, "D", x))\nx := open')).toMatch(/cannot use 'x' because it is changed with :=/);
    expect(error('f(src) => request.security(syminfo.tickerid, "D", src)\nplot(f(close))')).toMatch(/because it is a function parameter/);
    expect(error('plot(request.security(syminfo.tickerid, "D", request.security(syminfo.tickerid, "W", close)))')).toBe(
      'request.security cannot be used inside another request.security expression',
    );
    expect(error('plot(request.security(syminfo.tickerid, "D", close, foo = 1))')).toBe("'request.security' has no parameter named 'foo'");
  });

  it('keeps other request functions unsupported', () => {
    expect(error('plot(request.financial("A", "B", "FQ"))')).toBe("'request.financial' is not supported yet");
  });
});
