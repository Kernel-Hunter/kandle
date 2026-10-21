import { describe, expect, it } from 'vitest';
import { EXAMPLES } from '../../src/script/examples';
import { LOOP_LIMIT, RUN_BUDGET, type SymbolContext } from '../../src/script/runtime';
import { CANDLES, compile, makeCandles } from './fixtures';

const BTC_1H: SymbolContext = { ticker: 'BTCUSDT', period: '60', periodSeconds: 3600, mintick: 0.01, source: 'binance' };

// 300 x 300 = 90,000 iterations a bar: under the per-bar limit, but 400 bars of it is 36 million.
const HEAVY = `indicator("Heavy")
len = input.int(300, "Length")
s = 0.0
for i = 0 to len - 1
    for j = 0 to len - 1
        s += i * j
plot(s)`;

describe('script run budget', () => {
  it('stops a script that uses more than the budget across bars', () => {
    const e = compile(HEAVY);
    const r = e.run(CANDLES);
    expect(r.error?.message).toMatch(/^Script stopped: it used more than 10,000,000 operations \(about [\d.]+ seconds\)\. Simplify loops\.$/);
    expect(r.error?.line).toBe(5);
    // Each bar costs one operation plus 300 outer and 90,000 inner iterations.
    expect(r.error?.bar).toBe(Math.floor(RUN_BUDGET / 90_301));
    expect(e.budget.used).toBe(RUN_BUDGET + 1);
  });

  it('does not spend the budget again on every update until something changes', () => {
    const e = compile(HEAVY);
    const first = e.run(CANDLES);
    const again = e.run([...CANDLES, { ...CANDLES[CANDLES.length - 1], timestamp: CANDLES[CANDLES.length - 1].timestamp + 3_600_000 }]);
    expect(again.error).toBe(first.error);
    expect(again.barsRun).toBe(0);
    expect(e.lastError).toBe(first.error);

    e.setInputValues({ Length: 3 });
    const fixed = e.run(CANDLES);
    expect(fixed.error).toBeNull();
    expect(e.budget.used).toBe(CANDLES.length * (1 + 3 + 9));
  });

  it('counts loops inside request.security against the same budget', () => {
    const e = compile(`indicator("x")
f() =>
    s = 0.0
    for i = 0 to 299
        for j = 0 to 299
            s += i * j
    s
plot(request.security(syminfo.tickerid, "60", f()))`);
    e.setSymbol(BTC_1H);
    const r = e.run(CANDLES);
    expect(r.error?.message).toMatch(/^Script stopped: it used more than/);
  });

  it('also stops a run that takes too long, for work that is slow per operation', () => {
    const e = compile('indicator("x")\na = array.new_float(1000, 1.0)\nplot(a.size())');
    e.budget.timeLimitMs = -1;
    const r = e.run(CANDLES);
    expect(r.error?.message).toBe('Script stopped: it ran for more than -0.001 seconds. Simplify loops and large arrays.');
    expect(r.error?.bar).toBe(0);
  });

  it('keeps the per-bar loop limit for loops that never end', () => {
    const e = compile('indicator("x")\ni = 0\nwhile true\n    i += 1\nplot(i)');
    const r = e.run(CANDLES.slice(0, 3));
    expect(r.error?.message).toMatch(/Loop ran too many times/);
    expect(e.budget.used).toBe(1 + LOOP_LIMIT);
  });

  it('leaves the example scripts far below the budget on 5,000 bars', () => {
    const bars = makeCandles(5000);
    for (const ex of EXAMPLES) {
      const e = compile(ex.source);
      const r = e.run(bars);
      expect(r.error, ex.name).toBeNull();
      expect(e.budget.used, ex.name).toBeLessThan(RUN_BUDGET / 1000);
    }
  });
});
