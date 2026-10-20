import { describe, expect, it, vi } from 'vitest';
import type { Chart, KLineData } from 'klinecharts';
import { ScriptManager, scriptApi, type ScriptHost } from '../../src/script/manager';
import { sanitizeScripts, type ScriptRecord } from '../../src/script/persist';
import { symbolContext } from '../../src/script/render';
import { applyStrategyPatch, parseStrategyPatch, sanitizeStrategyOverrides } from '../../src/script/strategySettings';
import { DEFAULT_STRATEGY } from '../../src/script/strategy';
import { LayoutStore, MemoryStorage } from '../../src/store/layout';
import { CANDLES, compile } from './fixtures';

// The chart engine touches `window` on import; the script manager only registers its indicator.
vi.mock('klinecharts', () => ({ registerIndicator: vi.fn() }));

/** Long on an EMA cross up, short on a cross down: always in the market after the first signal. */
const EMA_CROSS = `strategy("EMA cross", overlay = true, initial_capital = 10000, default_qty_type = strategy.fixed, default_qty_value = 2)
fast = ta.ema(close, input.int(5, "Fast"))
slow = ta.ema(close, input.int(20, "Slow"))
if ta.crossover(fast, slow)
    strategy.entry("Long", strategy.long)
if ta.crossunder(fast, slow)
    strategy.entry("Short", strategy.short)
plot(strategy.initial_capital, "capital")`;

describe('strategy setting changes', () => {
  it('accept the backtest settings keys and the strategy() argument names', () => {
    const res = parseStrategyPatch({
      initialCapital: 5000,
      default_qty_type: 'strategy.percent_of_equity',
      default_qty_value: 50,
      commission_type: 'strategy.commission.cash_per_order',
      commissionValue: 0,
      slippage: 2,
      pyramiding: 0,
      process_orders_on_close: true,
    });
    expect(res).toEqual({
      ok: true,
      patch: {
        initialCapital: 5000,
        defaultQtyType: 'percent_of_equity',
        defaultQtyValue: 50,
        commissionType: 'cash_per_order',
        commissionValue: 0,
        slippage: 2,
        pyramiding: 0,
        processOrdersOnClose: true,
      },
    });
    expect(parseStrategyPatch({ initial_capital: null })).toEqual({ ok: true, patch: { initialCapital: null } });
  });

  it('reject values the strategy() call would reject, naming the key', () => {
    const error = (raw: unknown) => {
      const res = parseStrategyPatch(raw);
      return res.ok ? null : res.error;
    };
    expect(error({ initial_capital: 0 })).toBe('initial_capital must be a number more than 0');
    expect(error({ initialCapital: -5 })).toBe('initialCapital must be a number more than 0');
    expect(error({ default_qty_value: 0 })).toMatch(/more than 0/);
    expect(error({ commission_value: -0.1 })).toBe('commission_value must be a number of at least 0');
    expect(error({ slippage: 1.5 })).toBe('slippage must be a whole number of at least 0');
    expect(error({ pyramiding: -1 })).toMatch(/whole number/);
    expect(error({ initial_capital: Number.NaN })).toMatch(/more than 0/);
    expect(error({ initial_capital: '1000' })).toMatch(/more than 0/);
    expect(error({ default_qty_type: 'shares' })).toBe('default_qty_type must be one of fixed, cash, percent_of_equity');
    expect(error({ commission_type: 'flat' })).toMatch(/percent, cash_per_contract, cash_per_order/);
    expect(error({ process_orders_on_close: 'yes' })).toBe('process_orders_on_close must be true or false');
    expect(error({ capital: 5 })).toMatch(/^Unknown strategy setting capital\. Use initial_capital, /);
    expect(error([1])).toMatch(/must be an object/);
    expect(error('x')).toMatch(/must be an object/);
  });

  it('keep only overrides that differ from the script and drop them on null', () => {
    const defaults = { ...DEFAULT_STRATEGY, initialCapital: 10_000 };
    let o = applyStrategyPatch(defaults, {}, { initialCapital: 5000, commissionValue: 0 });
    expect(o).toEqual({ initialCapital: 5000 });
    o = applyStrategyPatch(defaults, o, { slippage: 1 });
    expect(o).toEqual({ initialCapital: 5000, slippage: 1 });
    o = applyStrategyPatch(defaults, o, { initialCapital: null, slippage: 0 });
    expect(o).toEqual({});
  });

  it('come back from storage without bad values', () => {
    expect(sanitizeStrategyOverrides({ initialCapital: 5000, slippage: 1.5, pyramiding: 2, commissionType: 'flat', junk: 1, defaultQtyType: 'cash' })).toEqual({
      initialCapital: 5000,
      pyramiding: 2,
      defaultQtyType: 'cash',
    });
    expect(sanitizeStrategyOverrides('nope')).toEqual({});
  });
});

describe('strategy settings in the engine', () => {
  it('replace the strategy() values and change the backtest the way the costs predict', () => {
    const e = compile(EMA_CROSS);
    e.run(CANDLES);
    const base = e.strategy!;
    expect(base.trades.length).toBeGreaterThan(3);
    expect(base.summary.commissionPaid).toBe(0);

    e.setStrategySettings({ commissionType: 'percent', commissionValue: 0.1 });
    expect(e.strategySettings).toMatchObject({ initialCapital: 10_000, commissionValue: 0.1 });
    expect(e.strategyDefaults).toMatchObject({ commissionValue: 0 });
    e.run(CANDLES);
    const withFees = e.strategy!;
    expect(withFees.config.commissionValue).toBe(0.1);
    expect(withFees.trades).toHaveLength(base.trades.length);
    // Same fills; each trade pays 0.1% of its entry value and of its exit value.
    withFees.trades.forEach((t, i) => {
      const b = base.trades[i];
      expect(t.entryPrice).toBe(b.entryPrice);
      expect(t.exitPrice).toBe(b.exitPrice);
      const fee = (t.entryPrice * t.qty + t.exitPrice * t.qty) * 0.001;
      expect(t.pnl).toBeCloseTo(b.pnl - fee, 9);
    });
  });

  it('size orders from the changed capital and expose it to the script', () => {
    const e = compile(EMA_CROSS);
    e.setStrategySettings({ initialCapital: 50_000, defaultQtyType: 'percent_of_equity', defaultQtyValue: 10 });
    e.run(CANDLES);
    const r = e.strategy!;
    const first = r.trades[0];
    // 10% of 50,000 at the first fill price.
    expect(first.qty).toBeCloseTo(5000 / first.entryPrice, 9);
    expect(r.summary.initialCapital).toBe(50_000);
    const capital = e.outputs.plots[0].values;
    expect(capital[capital.length - 1]).toBe(50_000);
  });

  it('go back to the script values on null and do nothing for indicators', () => {
    const e = compile(EMA_CROSS);
    e.setStrategySettings({ initialCapital: 1, slippage: 4 });
    e.setStrategySettings({ initialCapital: null });
    expect(e.strategyOverrides()).toEqual({ slippage: 4 });
    expect(e.strategySettings?.initialCapital).toBe(10_000);
    const ind = compile('indicator("i")\nplot(close)');
    ind.setStrategySettings({ initialCapital: 5 });
    expect(ind.strategyOverrides()).toEqual({});
    expect(ind.strategySettings).toBeNull();
    expect(ind.strategyDefaults).toBeNull();
  });
});

describe('saved strategy settings', () => {
  it('are kept in script records and in the layout, and junk is dropped', () => {
    const records = sanitizeScripts([
      { id: 'a', source: EMA_CROSS, inputs: {}, strategy: { initialCapital: 2500, commissionValue: -1, slippage: 2 } },
      { id: 'b', source: EMA_CROSS, inputs: {}, strategy: { junk: true } },
    ]);
    expect(records).toEqual([
      { id: 'a', source: EMA_CROSS, inputs: {}, strategy: { initialCapital: 2500, slippage: 2 } },
      { id: 'b', source: EMA_CROSS, inputs: {} },
    ]);
    const store = new LayoutStore(new MemoryStorage(), 'test');
    const layout = store.loadLayout();
    store.saveLayout({ ...layout, scripts: records });
    expect(store.loadLayout().scripts).toEqual(records);
  });
});

/** A stand-in for the chart: keeps indicators and runs their calc on create and on calcParams changes. */
function fakeChart(candles: KLineData[]) {
  const indicators = new Map<string, { calc: (data: KLineData[]) => unknown; paneId: string; calcParams: unknown[] }>();
  let panes = 0;
  const chart = {
    getDataList: () => candles,
    createIndicator: (create: { id: string; calc: (data: KLineData[]) => unknown; paneId?: string }) => {
      const ind = { calc: create.calc, paneId: create.paneId ?? `pane${++panes}`, calcParams: [] as unknown[] };
      indicators.set(create.id, ind);
      ind.calc(candles);
      return create.id;
    },
    getIndicators: ({ id }: { id: string }) => {
      const ind = indicators.get(id);
      return ind ? [{ id, paneId: ind.paneId }] : [];
    },
    setPaneOptions: () => undefined,
    overrideIndicator: ({ id, calcParams }: { id: string; calcParams: unknown[] }) => {
      const ind = indicators.get(id);
      if (!ind || JSON.stringify(ind.calcParams) === JSON.stringify(calcParams)) return;
      ind.calcParams = calcParams;
      ind.calc(candles);
    },
    removeIndicator: ({ id }: { id: string }) => indicators.delete(id),
  };
  return { chart: chart as unknown as Chart, indicators };
}

function setup(records: ScriptRecord[] = []) {
  const { chart, indicators } = fakeChart(CANDLES as KLineData[]);
  const persist = vi.fn<(r: ScriptRecord[]) => void>();
  const host: ScriptHost = {
    chart: () => chart,
    candlePaneId: 'candle_pane',
    symbol: () => symbolContext('BTCUSDT', 3_600_000, 2, 'binance'),
    persist,
    toast: () => undefined,
  };
  const manager = new ScriptManager(host);
  manager.restore(records);
  const runs: string[] = [];
  manager.onStrategyRun((id) => runs.push(id));
  return { manager, api: scriptApi(manager), persist, indicators, runs };
}

describe('strategy settings on the chart', () => {
  it('rerun the backtest, report the settings and save them with the script', () => {
    const { manager, api, persist, runs } = setup();
    const added = api.setStrategySettings('nope', {});
    expect(added).toEqual({ ok: false, error: '1:1 No script with id nope' });
    const { id } = manager.add(EMA_CROSS);
    const before = api.getBacktest(id)!;
    expect(before.settings.commissionValue).toBe(0);
    expect(before.changedSettings).toEqual([]);

    runs.length = 0;
    expect(api.setStrategySettings(id!, { commission_value: 0.1, initial_capital: 20_000 })).toEqual({ ok: true, id });
    expect(runs).toEqual([id]);
    const after = api.getBacktest(id)!;
    expect(after.settings).toMatchObject({ initialCapital: 20_000, commissionValue: 0.1, commissionType: 'percent' });
    expect(after.changedSettings).toEqual(['initialCapital', 'commissionValue']);
    expect(after.summary.commissionPaid).toBeGreaterThan(0);
    expect(after.summary.netProfit).toBeLessThan(before.summary.netProfit!);

    const info = api.listScripts().find((s) => s.id === id)!;
    expect(info.strategyDefaults).toMatchObject({ initialCapital: 10_000, commissionValue: 0 });
    expect(info.strategySettings).toMatchObject({ initialCapital: 20_000, commissionValue: 0.1 });
    expect(persist.mock.lastCall![0]).toEqual([{ id, source: EMA_CROSS, inputs: { Fast: 5, Slow: 20 }, strategy: { initialCapital: 20_000, commissionValue: 0.1 } }]);
  });

  it('reject bad values and scripts that are not strategies without changing anything', () => {
    const { manager, api } = setup();
    const { id } = manager.add(EMA_CROSS);
    expect(api.setStrategySettings(id!, { slippage: -1 })).toEqual({ ok: false, error: '1:1 slippage must be a whole number of at least 0' });
    expect(api.getBacktest(id)!.changedSettings).toEqual([]);
    const ind = manager.add('indicator("i")\nplot(close)');
    expect(api.setStrategySettings(ind.id!, { slippage: 1 }).error).toBe('1:1 Strategy settings only apply to scripts declared with strategy()');
  });

  it('go back to the script values with null', () => {
    const { manager, api } = setup();
    const { id } = manager.add(EMA_CROSS);
    api.setStrategySettings(id!, { initialCapital: 500, slippage: 3 });
    api.setStrategySettings(id!, { slippage: null });
    expect(api.getBacktest(id)!.changedSettings).toEqual(['initialCapital']);
    api.setStrategySettings(id!, null);
    expect(api.getBacktest(id)!.changedSettings).toEqual([]);
    expect(manager.records()[0].strategy).toBeUndefined();
  });

  it('survive a reload and an edit of the script', () => {
    const first = setup();
    const { id } = first.manager.add(EMA_CROSS);
    first.api.setStrategySettings(id!, { initialCapital: 30_000, pyramiding: 2 });
    const saved = first.persist.mock.lastCall![0];
    const expected = first.api.getBacktest(id)!;

    const second = setup(sanitizeScripts(JSON.parse(JSON.stringify(saved))));
    const restored = second.api.getBacktest(id)!;
    expect(restored.settings).toEqual(expected.settings);
    expect(restored.summary).toEqual(expected.summary);

    // Editing the source keeps the settings while it is a strategy, and drops them when it is not.
    expect(second.manager.update(id!, EMA_CROSS.replace('"EMA cross"', '"EMA cross 2"')).ok).toBe(true);
    expect(second.api.getBacktest(id)!.settings).toMatchObject({ initialCapital: 30_000, pyramiding: 2 });
    expect(second.manager.update(id!, 'indicator("i")\nplot(close)').ok).toBe(true);
    expect(second.manager.records()[0].strategy).toBeUndefined();
  });

  it('can be given to runScript', async () => {
    const { api } = setup();
    const res = (await api.runScript(EMA_CROSS, { strategy: { initial_capital: 1000, commission_value: 0.05 } })) as Awaited<ReturnType<typeof api.runScript>> & {
      backtest?: { settings: Record<string, unknown>; changedSettings: string[] };
    };
    expect(res.ok).toBe(true);
    expect(res.backtest!.settings).toMatchObject({ initialCapital: 1000, commissionValue: 0.05 });
    expect(res.backtest!.changedSettings).toEqual(['initialCapital', 'commissionValue']);

    // Replacing the script keeps earlier changes and applies new ones.
    const again = (await api.runScript(EMA_CROSS, { id: res.id, strategy: { slippage: 2 } })) as typeof res;
    expect(again.backtest!.settings).toMatchObject({ initialCapital: 1000, commissionValue: 0.05, slippage: 2 });

    expect(await api.runScript(EMA_CROSS, { strategy: { initial_capital: 0 } })).toEqual({ ok: false, error: '1:1 initial_capital must be a number more than 0' });
    expect(await api.runScript('indicator("i")\nplot(close)', { strategy: { slippage: 1 } })).toEqual({
      ok: false,
      error: '1:1 Strategy settings only apply to scripts declared with strategy()',
    });
    expect(api.listScripts()).toHaveLength(1);
  });
});
