import { describe, expect, it } from 'vitest';
import { compileScript, validateInput } from '../../src/script/engine';
import { CANDLES, compile, expectSeriesClose, makeCandles, plotValues, run } from './fixtures';
import * as ref from './reference';

const close = CANDLES.map((b) => b.close);
const open = CANDLES.map((b) => b.open);
const n = CANDLES.length;

/** Runs a script body under indicator() and returns plot values. */
function values(src: string, plot = 0): number[] {
  return plotValues(run(`indicator("t")\n${src}`), plot);
}

describe('series and history', () => {
  it('reads past values of built-in series and variables', () => {
    expectSeriesClose(values('plot(close[1])'), close.map((_, i) => (i >= 1 ? close[i - 1] : NaN)));
    expectSeriesClose(values('x = close * 2\nplot(x[3])'), close.map((_, i) => (i >= 3 ? close[i - 3] * 2 : NaN)));
    expectSeriesClose(values('plot((close - open)[2])'), close.map((_, i) => (i >= 2 ? close[i - 2] - open[i - 2] : NaN)));
    expectSeriesClose(values('plot(bar_index[5])'), close.map((_, i) => (i >= 5 ? i - 5 : NaN)));
    expectSeriesClose(values('len = 2\nplot(close[len])'), close.map((_, i) => (i >= 2 ? close[i - 2] : NaN)));
  });

  it('exposes bar data and derived prices', () => {
    const c = CANDLES;
    expectSeriesClose(values('plot(hl2)'), c.map((b) => (b.high + b.low) / 2));
    expectSeriesClose(values('plot(hlc3)'), c.map((b) => (b.high + b.low + b.close) / 3));
    expectSeriesClose(values('plot(ohlc4)'), c.map((b) => (b.open + b.high + b.low + b.close) / 4));
    expectSeriesClose(values('plot(time)'), c.map((b) => b.timestamp));
    expectSeriesClose(values('plot(volume)'), c.map((b) => b.volume!));
    expectSeriesClose(values('plot(last_bar_index)'), c.map(() => n - 1));
    expectSeriesClose(values('plot(barstate.islast ? 1 : 0)'), c.map((_, i) => (i === n - 1 ? 1 : 0)));
  });

  it('keeps var values across bars and resets plain ones', () => {
    expectSeriesClose(values('var total = 0\ntotal += 1\nplot(total)'), close.map((_, i) => i + 1));
    expectSeriesClose(values('total = 0\ntotal += 1\nplot(total)'), close.map(() => 1));
    expectSeriesClose(values('var float hi = na\nhi := na(hi) ? high : math.max(hi, high)\nplot(hi)'), CANDLES.map((_, i) => Math.max(...CANDLES.slice(0, i + 1).map((b) => b.high))));
    // var inside a branch keeps its value on bars where the branch does not run
    const up = close.map((v, i) => v > open[i]);
    let count = 0;
    const expected = up.map((u) => (u ? ++count : count));
    expectSeriesClose(values('var ups = 0\nif close > open\n    ups += 1\nplot(ups)'), expected);
  });

  it('handles na, nz and na()', () => {
    expectSeriesClose(values('plot(nz(close[1]))'), close.map((_, i) => (i >= 1 ? close[i - 1] : 0)));
    expectSeriesClose(values('plot(nz(close[1], -1))'), close.map((_, i) => (i >= 1 ? close[i - 1] : -1)));
    expectSeriesClose(values('plot(na(close[1]) ? 1 : 0)'), close.map((_, i) => (i === 0 ? 1 : 0)));
    expectSeriesClose(values('x = na\nplot(x + 1)'), close.map(() => NaN));
    expectSeriesClose(values('plot(close[1] > 0 ? 1 : 0)'), close.map((_, i) => (i === 0 ? 0 : 1)));
    expectSeriesClose(values('plot(fixnan(bar_index % 3 == 0 ? close : na))'), close.map((_, i) => close[i - (i % 3)]));
  });

  it('coerces declared types', () => {
    expectSeriesClose(values('int x = 7.9\nplot(x)'), close.map(() => 7));
    expectSeriesClose(values('plot(int(-2.5))'), close.map(() => -2));
    expectSeriesClose(values('bool b = 1\nplot(b ? 1 : 0)'), close.map(() => 1));
    expectSeriesClose(values('plot(math.round(2.5) + math.round(-2.5) * 10 + math.round(1.23456, 2))'), close.map(() => 3 - 30 + 1.23));
    expectSeriesClose(values('plot(5 / 2)'), close.map(() => 2.5));
    expectSeriesClose(values('plot(1 / 0)'), close.map(() => NaN));
  });
});

describe('control flow', () => {
  it('evaluates if, else if and else as statements and expressions', () => {
    const exp = close.map((v, i) => (v > open[i] ? 1 : v < open[i] ? -1 : 0));
    expectSeriesClose(
      values(`d = 0
if close > open
    d := 1
else if close < open
    d := -1
plot(d)`),
      exp,
    );
    expectSeriesClose(
      values(`d = if close > open
    1
else if close < open
    -1
else
    0
plot(d)`),
      exp,
    );
    expectSeriesClose(values('x = if close > 1e9\n    1\nplot(x)'), close.map(() => NaN));
  });

  it('runs for loops up, down and with a step', () => {
    expectSeriesClose(values('s = 0\nfor i = 1 to 10\n    s += i\nplot(s)'), close.map(() => 55));
    expectSeriesClose(values('s = 0\nfor i = 10 to 1\n    s += i\nplot(s)'), close.map(() => 55));
    expectSeriesClose(values('s = 0\nfor i = 0 to 10 by 5\n    s += i\nplot(s)'), close.map(() => 15));
    expectSeriesClose(
      values('s = 0.0\nfor i = 0 to 4\n    s += close[i]\nplot(s / 5)'),
      ref.sma(close, 5),
    );
  });

  it('supports break, continue and while', () => {
    expectSeriesClose(values('s = 0\nfor i = 1 to 100\n    if i > 4\n        break\n    s += i\nplot(s)'), close.map(() => 10));
    expectSeriesClose(values('s = 0\nfor i = 1 to 6\n    if i % 2 == 0\n        continue\n    s += i\nplot(s)'), close.map(() => 9));
    expectSeriesClose(values('i = 0\nwhile i < 7\n    i += 2\nplot(i)'), close.map(() => 8));
  });

  it('evaluates switch with and without a subject', () => {
    expectSeriesClose(
      values(`mode = input.string("b", "Mode", options = ["a", "b", "c"])
x = switch mode
    "a" => 1
    "b" => 2
    => 3
plot(x)`),
      close.map(() => 2),
    );
    expectSeriesClose(
      values(`x = switch
    close > open => 1
    close < open => -1
    => 0
plot(x)`),
      close.map((v, i) => (v > open[i] ? 1 : v < open[i] ? -1 : 0)),
    );
  });

  it('iterates arrays with for ... in', () => {
    expectSeriesClose(
      values(`a = array.from(1, 2, 3, 4)
s = 0
for [i, v] in a
    s += v * i
for v in a
    s += v
plot(s + a.size())`),
      close.map(() => 20 + 10 + 4),
    );
  });

  it('stops runaway loops with an error', () => {
    const e = compile('indicator("x")\ni = 0\nwhile true\n    i += 1\nplot(i)');
    const r = e.run(CANDLES.slice(0, 3));
    expect(r.error?.message).toMatch(/Loop ran too many times/);
    expect(r.error?.bar).toBe(0);
  });
});

describe('functions', () => {
  it('calls single-line and multi-line functions with defaults and named args', () => {
    expectSeriesClose(
      values(`twice(x) => x * 2
avg2(a, b = 0) =>
    s = a + b
    s / 2
plot(twice(close) + avg2(4) + avg2(b = 2, a = 6))`),
      close.map((v) => v * 2 + 2 + 4),
    );
  });

  it('gives each call site its own history and var state', () => {
    expectSeriesClose(
      values(`counter() =>
    var c = 0
    c += 1
    c
a = counter()
b = counter()
plot(a + b)`),
      close.map((_, i) => 2 * (i + 1)),
    );
    expectSeriesClose(values('prev(x) => x[1]\nplot(prev(close) + prev(open))'), close.map((_, i) => (i > 0 ? close[i - 1] + open[i - 1] : NaN)));
  });

  it('returns tuples', () => {
    const engine = run(`indicator("t")
minmax(a, b) =>
    [math.min(a, b), math.max(a, b)]
[lo, hi] = minmax(open, close)
[_, h2] = minmax(1, 2)
plot(lo)
plot(hi)
plot(h2)`);
    expectSeriesClose(plotValues(engine, 0), close.map((v, i) => Math.min(v, open[i])));
    expectSeriesClose(plotValues(engine, 1), close.map((v, i) => Math.max(v, open[i])));
    expectSeriesClose(plotValues(engine, 2), close.map(() => 2));
  });

  it('supports user methods and method syntax on arrays', () => {
    expectSeriesClose(
      values(`method scale(float x, float k) => x * k
a = array.new_float(0)
a.push(close)
a.push(1.0)
plot(close.scale(2) + a.get(1) + a.sum())`),
      close.map((v) => v * 2 + 1 + v + 1),
    );
  });

  it('reads global variables inside functions', () => {
    expectSeriesClose(values('k = 3\nf(x) => x * k\nplot(f(close))'), close.map((v) => v * 3));
  });
});

describe('strings, colors and math', () => {
  it('formats strings', () => {
    const engine = run('indicator("s")\nplotshape(true, text = str.tostring(1.5) + "/" + str.tostring(2, "#.00") + str.format(" {0}", 7))');
    expect(engine.outputs.shapes[0].text).toBe('1.5/2.00 7');
  });

  it('builds colors', () => {
    const engine = run(`indicator("c")
plot(close, color = color.new(color.red, 50))
plot(close, color = color.rgb(10, 20, 30))
plot(close, color = #11223380)
plot(close, color = close > open ? color.green : na)`);
    const [a, b, c, d] = engine.outputs.plots;
    expect(a.colors[0]).toBe('rgba(255,82,82,0.5)');
    expect(b.colors[0]).toBe('rgb(10,20,30)');
    expect(c.colors[0]).toBe('rgba(17,34,51,0.502)');
    expect(d.colors.slice(0, 20)).toEqual(close.slice(0, 20).map((v, i) => (v > open[i] ? 'rgb(76,175,80)' : null)));
  });

  it('computes math functions', () => {
    expectSeriesClose(values('plot(math.abs(-2) + math.max(1, 5, 3) + math.min(4, 2) + math.sqrt(16) + math.pow(2, 3))'), close.map(() => 2 + 5 + 2 + 4 + 8));
    expectSeriesClose(values('plot(math.avg(1, 2, 3, 6) + math.sign(-4) + math.floor(2.7) + math.ceil(2.1))'), close.map(() => 3 - 1 + 2 + 3));
    expectSeriesClose(values('plot(math.log(math.exp(2)) + math.log10(1000))'), close.map(() => 5));
  });
});

describe('inputs', () => {
  const src = `indicator("Inputs")
len = input.int(14, "Length", minval = 2, maxval = 50)
mult = input.float(2.0, "Mult", step = 0.5)
show = input.bool(true, "Show")
mode = input.string("EMA", "Mode", options = ["SMA", "EMA"])
src = input.source(close, "Source")
col = input.color(color.red, "Color")
plot(show ? (mode == "EMA" ? ta.ema(src, len) : ta.sma(src, len)) * mult : na, color = col)`;

  it('lists inputs with their settings', () => {
    const e = compile(src);
    expect(e.inputs.map((i) => [i.key, i.type, i.defval])).toEqual([
      ['Length', 'int', 14],
      ['Mult', 'float', 2],
      ['Show', 'bool', true],
      ['Mode', 'string', 'EMA'],
      ['Source', 'source', 'close'],
      ['Color', 'color', '#ff5252'],
    ]);
    expect(e.inputs[0]).toMatchObject({ minval: 2, maxval: 50 });
    expect(e.inputs[3].options).toEqual(['SMA', 'EMA']);
  });

  it('uses edited values and validates them', () => {
    const e = compile(src);
    e.setInputValues({ Length: 10, Mult: 1, Mode: 'SMA', Source: 'open', Color: '#00ff00', Bogus: 3 });
    e.run(CANDLES);
    expectSeriesClose(plotValues(e), ref.sma(open, 10));
    expect(e.outputs.plots[0].colors[50]).toBe('rgb(0,255,0)');
    expect(e.inputValues()).toMatchObject({ Length: 10, Mode: 'SMA', Source: 'open' });
    e.setInputValues({ Length: 500, Mode: 'WMA', Show: 'yes' });
    expect(e.inputValues()).toMatchObject({ Length: 50, Mode: 'EMA', Show: true });
    expect(validateInput(e.inputs[0], 1)).toBe(2);
    expect(validateInput(e.inputs[0], '7')).toBe(7);
  });

  it('reads the script title and overlay flag', () => {
    const r = compileScript('indicator("My Script", shorttitle = "MS", overlay = true, precision = 3)\nplot(close)');
    expect(r.ok && r.engine.meta).toMatchObject({ title: 'My Script', shortTitle: 'MS', overlay: true, precision: 3 });
  });
});

describe('outputs', () => {
  it('records plots, shapes, levels, fills and colors', () => {
    const e = run(`indicator("o")
p1 = plot(close, "C", color.blue, 2, plot.style_stepline, offset = 1)
p2 = plot(open, "O")
h1 = hline(70, "Upper", color.gray, hline.style_dashed)
h2 = hline(30)
fill(p1, p2, color = color.new(color.blue, 90))
fill(h1, h2)
plotshape(ta.crossover(close, open), "X", shape.triangleup, location.belowbar, color.green, size = size.small)
plotchar(close > open, char = "*")
bgcolor(close > open ? color.new(color.green, 80) : na)
barcolor(close < open ? color.orange : na)`);
    const o = e.outputs;
    expect(o.plots[0]).toMatchObject({ title: 'C', linewidth: 2, style: 'stepline', offset: 1 });
    expect(o.plots[1].title).toBe('O');
    expect(o.hlines.map((h) => [h.title, h.price, h.lineStyle])).toEqual([
      ['Upper', 70, 'dashed'],
      ['Level 2', 30, 'solid'],
    ]);
    expect(o.fills.map((f) => [f.from?.kind, f.to?.index])).toEqual([
      ['plot', 1],
      ['hline', 1],
    ]);
    expect(o.shapes[0]).toMatchObject({ style: 'triangleup', location: 'belowbar' });
    expect(o.shapes[1].char).toBe('*');
    expect(o.shapes[1].values.slice(0, 30).map((v) => !Number.isNaN(v))).toEqual(close.slice(0, 30).map((v, i) => v > open[i]));
    expect(o.backgrounds[0].colors.filter(Boolean).length).toBe(close.filter((v, i) => v > open[i]).length);
    expect(o.barColors[0].colors.filter(Boolean).length).toBe(close.filter((v, i) => v < open[i]).length);
  });
});

describe('runtime errors', () => {
  it('reports the line and the bar', () => {
    const e = compile('indicator("e")\na = array.new_float(2)\nx = bar_index == 5 ? a.get(3) : 0.0\nplot(x)');
    const r = e.run(CANDLES);
    expect(r.error?.format()).toBe('3:22 Index 3 is out of bounds; the array has 2 elements (on bar 5)');
  });

  it('rejects negative history offsets', () => {
    const r = compile('indicator("e")\nplot(close[-1])').run(CANDLES);
    expect(r.error?.message).toBe('History offsets cannot be negative');
  });
});

describe('incremental updates', () => {
  const script = `indicator("i")
var count = 0
count += 1
f(x) =>
    var s = 0.0
    s += x
    s
[m, s, h] = ta.macd(close, 12, 26, 9)
[st, d] = ta.supertrend(3, 10)
plot(st)
plot(ta.ema(close, 20))
plot(count)
plot(f(close))
plot(h)
plot(ta.valuewhen(ta.crossover(close, ta.sma(close, 10)), close, 1))
plot(ta.barssince(close > open))
plot(ta.vwap(hlc3))`;

  it('matches a full run after the last bar changes several times and new bars arrive', () => {
    const all = makeCandles(300, 7);
    const live = compile(script);
    expect(live.run(all.slice(0, 250)).error).toBeNull();
    // The last candle ticks a few times before closing.
    for (const close of [101, 99, 100.5]) {
      const bars = all.slice(0, 250);
      bars[249] = { ...bars[249], close, high: Math.max(bars[249].high, close), low: Math.min(bars[249].low, close) };
      const r = live.run(bars);
      expect(r.incremental).toBe(true);
      expect(r.barsRun).toBe(1);
    }
    // Final value of bar 249 and then new bars.
    expect(live.run(all.slice(0, 250)).incremental).toBe(true);
    expect(live.run(all.slice(0, 252)).barsRun).toBe(3);
    for (let k = 253; k <= 300; k++) live.run(all.slice(0, k));

    const full = compile(script);
    full.run(all);
    for (let p = 0; p < full.outputs.plots.length; p++) {
      expectSeriesClose(plotValues(live, p), plotValues(full, p));
    }
  });

  it('recomputes from scratch when history is prepended', () => {
    const all = makeCandles(200, 3);
    const e = compile(script);
    e.run(all.slice(100));
    const r = e.run(all);
    expect(r.incremental).toBe(false);
    const full = compile(script);
    full.run(all);
    expectSeriesClose(plotValues(e, 0), plotValues(full, 0));
  });

  it('falls back to full runs for scripts with arrays', () => {
    const e = compile('indicator("a")\nvar a = array.new_float()\na.push(close)\nplot(a.size())');
    e.run(CANDLES.slice(0, 50));
    const r = e.run(CANDLES.slice(0, 50));
    expect(r.incremental).toBe(false);
    expect(plotValues(e)[49]).toBe(50);
  });
});

describe('performance', () => {
  it('runs a typical script on 1,500 bars well under 50 ms', () => {
    const bars = makeCandles(1500, 11);
    const src = `indicator("perf", overlay = true)
fast = ta.ema(close, input.int(12))
slow = ta.ema(close, input.int(26))
[mid, up, lo] = ta.bb(close, 20, 2)
r = ta.rsi(close, 14)
[st, dir] = ta.supertrend(3, 10)
plot(fast, color = fast > slow ? color.green : color.red)
plot(slow)
plot(mid)
plot(up)
plot(lo)
plot(st)
plotshape(ta.crossover(fast, slow), style = shape.triangleup, location = location.belowbar)
bgcolor(r > 70 ? color.new(color.red, 90) : na)`;
    const e = compile(src);
    e.run(bars); // warm up the JIT
    const times: number[] = [];
    for (let k = 0; k < 5; k++) {
      const fresh = compile(src);
      const t = performance.now();
      fresh.run(bars);
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    expect(times[2]).toBeLessThan(50);
    // A live tick re-runs only the last bar.
    const t = performance.now();
    const r = e.run(bars);
    expect(r.incremental).toBe(true);
    expect(performance.now() - t).toBeLessThan(5);
  });
});
