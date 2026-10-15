import { describe, expect, it } from 'vitest';
import { EXAMPLES, NEW_SCRIPT } from '../../src/script/examples';
import { sanitizeScripts } from '../../src/script/persist';
import { sanitizeLayout } from '../../src/store/layout';
import { CANDLES, compile } from './fixtures';

describe('example scripts', () => {
  it('ships ten indicators and three strategies', () => {
    expect(EXAMPLES).toHaveLength(13);
    expect(EXAMPLES.filter((ex) => compile(ex.source).isStrategy)).toHaveLength(3);
  });

  for (const ex of [...EXAMPLES, { name: 'New script', source: NEW_SCRIPT }]) {
    it(`${ex.name} compiles, runs and draws something`, () => {
      const e = compile(ex.source);
      const r = e.run(CANDLES);
      expect(r.error).toBeNull();
      const o = e.outputs;
      const drawn = o.plots.some((p) => p.values.some((v) => !Number.isNaN(v)));
      expect(drawn).toBe(true);
      expect(e.inputs.length).toBeGreaterThan(0);
      if (e.isStrategy) {
        const r = e.strategy!;
        expect(r.trades.length).toBeGreaterThan(0);
        expect(r.summary.netProfit).toBeCloseTo(r.trades.reduce((s, t) => s + t.pnl, 0), 6);
      }
    });
  }
});

describe('saved scripts', () => {
  it('keeps valid script records in the layout and drops junk', () => {
    const layout = sanitizeLayout({
      scripts: [
        { id: 'a', source: 'indicator("x")\nplot(close)', inputs: { Length: 5, Bad: { x: 1 } } },
        { id: '', source: 'x' },
        { id: 'b', source: 5 },
        'nope',
      ],
    });
    expect(layout.scripts).toEqual([{ id: 'a', source: 'indicator("x")\nplot(close)', inputs: { Length: 5 } }]);
    expect(sanitizeScripts(null)).toEqual([]);
    expect(sanitizeLayout({}).scripts).toBeUndefined();
  });
});
