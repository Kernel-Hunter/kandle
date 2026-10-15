import { describe, expect, it } from 'vitest';
import { backtestSummary } from '../../src/script/backtestJson';
import { compileScript } from '../../src/script/engine';
import { Broker, barPath, sharpeRatio, summarize, type ClosedTrade, type ExitParams, type StrategyConfig, type StrategyReport } from '../../src/script/strategy';
import { CANDLES, compile, plotValues, run } from './fixtures';

const H = 3_600_000;
type Bar = [open: number, high: number, low: number, close: number];

/**
 * Runs the broker over `bars` the way the engine does: fills at the start of each bar,
 * then `onBar` plays the script (placing orders), then the bar closes.
 */
function simulate(bars: Bar[], onBar: (i: number, b: Broker) => void, config: Partial<StrategyConfig> = {}, mintick = 1) {
  const broker = new Broker(config);
  broker.reset(mintick);
  const positions: number[] = [];
  bars.forEach(([o, h, l, c], i) => {
    broker.beginBar(i, i * H, o, h, l, c);
    positions.push(broker.positionSize);
    onBar(i, broker);
    broker.endBar(i, c);
  });
  const report = broker.report(
    bars.map((_, i) => i * H),
    bars.map((b) => b[3]),
    3600,
  );
  return { broker, report, positions };
}

const at = (bar: number, fn: (b: Broker) => void) => (i: number, b: Broker) => {
  if (i === bar) fn(b);
};
const all =
  (...steps: Array<(i: number, b: Broker) => void>) =>
  (i: number, b: Broker) => {
    for (const s of steps) s(i, b);
  };

const exitParams = (p: Partial<ExitParams>): ExitParams => ({
  fromEntry: '',
  qty: NaN,
  qtyPercent: NaN,
  profit: NaN,
  limit: NaN,
  loss: NaN,
  stop: NaN,
  trailPrice: NaN,
  trailPoints: NaN,
  trailOffset: NaN,
  comment: null,
  commentProfit: null,
  commentLoss: null,
  commentTrailing: null,
  ...p,
});

const long = (b: Broker, id = 'L', qty = NaN, limit = NaN, stop = NaN) => b.entry(id, 1, qty, limit, stop, null);
const short = (b: Broker, id = 'S', qty = NaN, limit = NaN, stop = NaN) => b.entry(id, -1, qty, limit, stop, null);

function only(report: StrategyReport): ClosedTrade {
  expect(report.trades).toHaveLength(1);
  return report.trades[0];
}

describe('intrabar path', () => {
  it('visits the extreme nearer the open first, high on a tie', () => {
    expect(barPath(100, 103, 90, 95)).toEqual([100, 103, 90, 95]);
    expect(barPath(100, 110, 98, 105)).toEqual([100, 98, 110, 105]);
    expect(barPath(100, 105, 95, 100)).toEqual([100, 105, 95, 100]);
  });
});

describe('market orders', () => {
  const bars: Bar[] = [
    [100, 105, 95, 102],
    [103, 110, 101, 108],
    [108, 112, 104, 110],
    [111, 113, 109, 112],
  ];

  it('fill at the next open and track position_size', () => {
    const { report, positions } = simulate(bars, all(at(0, (b) => long(b, 'L', 2)), at(1, (b) => b.close('L', null, NaN, NaN, false))));
    expect(positions).toEqual([0, 2, 0, 0]);
    const t = only(report);
    expect(t).toMatchObject({ direction: 'long', qty: 2, entryBar: 1, entryPrice: 103, exitBar: 2, exitPrice: 108, entryId: 'L', exitId: 'Close' });
    expect(t.pnl).toBeCloseTo(10);
    expect(t.pnlPercent).toBeCloseTo((10 / 206) * 100);
    expect(report.summary.netProfit).toBeCloseTo(10);
  });

  it('fill at the close of the same bar with process_orders_on_close', () => {
    const { report, positions } = simulate(bars, all(at(0, (b) => long(b, 'L', 2)), at(1, (b) => b.close('L', null, NaN, NaN, false))), { processOrdersOnClose: true });
    expect(positions).toEqual([0, 2, 0, 0]);
    const t = only(report);
    expect(t).toMatchObject({ entryBar: 0, entryPrice: 102, exitBar: 1, exitPrice: 108 });
    expect(t.pnl).toBeCloseTo(12);
  });

  it('closes immediately at the current close when asked', () => {
    const { report } = simulate(bars, all(at(0, (b) => long(b, 'L', 1)), at(2, (b) => b.close('L', 'now', NaN, NaN, true))));
    expect(only(report)).toMatchObject({ entryPrice: 103, exitBar: 2, exitPrice: 110, exitSignal: 'now' });
  });

  it('ignores a close for an entry that is not open, and stays pending on the last bar', () => {
    const { report, broker } = simulate(bars, all(at(0, (b) => b.close('L', null, NaN, NaN, false)), at(3, (b) => long(b))));
    expect(report.trades).toHaveLength(0);
    expect(broker.positionSize).toBe(0);
    expect(report.openTrades).toHaveLength(0);
  });

  it('marks open trades to the last close', () => {
    const { report, broker } = simulate(bars, at(1, (b) => long(b, 'L', 3)));
    expect(report.openTrades).toHaveLength(1);
    expect(report.openTrades[0]).toMatchObject({ entryPrice: 108, qty: 3 });
    expect(report.openTrades[0].pnl).toBeCloseTo(12);
    expect(broker.openProfit).toBeCloseTo(12);
    expect(broker.equity).toBeCloseTo(100_012);
    expect(report.summary.openProfit).toBeCloseTo(12);
    expect(report.equity).toEqual([100_000, 100_000, 100_006, 100_012]);
  });
});

describe('limit and stop entries', () => {
  it('fills a buy limit when the path comes down to it, at the limit price', () => {
    const bars: Bar[] = [
      [100, 101, 99, 100],
      [103, 110, 101, 108],
      [100, 101, 97, 99],
    ];
    const { report, positions } = simulate(bars, at(0, (b) => long(b, 'L', 1, 98)));
    expect(positions).toEqual([0, 0, 1]);
    expect(report.openTrades[0]).toMatchObject({ entryBar: 2, entryPrice: 98 });
  });

  it('fills a buy limit at the open when the bar gaps below it', () => {
    const bars: Bar[] = [
      [100, 101, 99, 100],
      [97, 98, 95, 96],
    ];
    const { report } = simulate(bars, at(0, (b) => long(b, 'L', 1, 99)));
    expect(report.openTrades[0].entryPrice).toBe(97);
  });

  it('fills a buy stop on the way up, and at the open on a gap', () => {
    const bars: Bar[] = [
      [100, 101, 99, 100],
      [103, 110, 101, 108],
    ];
    expect(simulate(bars, at(0, (b) => long(b, 'L', 1, NaN, 106))).report.openTrades[0].entryPrice).toBe(106);
    expect(simulate(bars, at(0, (b) => long(b, 'L', 1, NaN, 102))).report.openTrades[0].entryPrice).toBe(103);
  });

  it('fills a sell stop on the way down', () => {
    const bars: Bar[] = [
      [100, 101, 99, 100],
      [100, 104, 90, 92],
    ];
    const { report } = simulate(bars, at(0, (b) => short(b, 'S', 1, NaN, 95)));
    expect(report.openTrades[0]).toMatchObject({ direction: 'short', entryPrice: 95 });
  });

  it('turns a stop-limit into a limit once the stop triggers', () => {
    // Stop 105 triggers on the way up to 110; the 104 limit then fills on the way down to 101.
    const bars: Bar[] = [
      [100, 101, 99, 100],
      [102, 110, 101, 103],
    ];
    const { report } = simulate(bars, at(0, (b) => long(b, 'L', 1, 104, 105)));
    expect(report.openTrades[0].entryPrice).toBe(104);
  });

  it('keeps a pending limit order across bars and replaces it by id', () => {
    const bars: Bar[] = [
      [100, 101, 99, 100],
      [100, 101, 96, 100],
      [100, 101, 94, 100],
    ];
    const { report } = simulate(bars, all(at(0, (b) => long(b, 'L', 1, 97)), at(0, (b) => long(b, 'L', 1, 95))));
    expect(report.openTrades[0]).toMatchObject({ entryBar: 2, entryPrice: 95 });
  });

  it('cancels pending orders', () => {
    const bars: Bar[] = [
      [100, 101, 99, 100],
      [100, 101, 99, 100],
      [100, 101, 90, 100],
    ];
    expect(simulate(bars, all(at(0, (b) => long(b, 'L', 1, 95)), at(1, (b) => b.cancel('L')))).report.openTrades).toHaveLength(0);
    expect(simulate(bars, all(at(0, (b) => long(b, 'L', 1, 95)), at(1, (b) => b.cancelAll()))).report.openTrades).toHaveLength(0);
    expect(simulate(bars, at(0, (b) => long(b, 'L', 1, 95))).report.openTrades).toHaveLength(1);
  });
});

describe('exits', () => {
  // Bar 1 opens at 100, where the long fills.
  const entryBars: Bar[] = [
    [99, 100, 98, 99],
    [100, 101, 99, 100],
  ];
  const bracket = (b: Broker) => b.exit('X', exitParams({ fromEntry: 'L', profit: 5, loss: 5 }));

  it('takes profit and stops out at prices in ticks from the entry', () => {
    const win = simulate([...entryBars, [101, 106, 100, 104]], at(0, (b) => (long(b), bracket(b))));
    expect(only(win.report)).toMatchObject({ exitPrice: 105, exitBar: 2, exitId: 'X', exitSignal: 'X' });
    const loss = simulate([...entryBars, [99, 100, 94, 96]], at(0, (b) => (long(b), bracket(b))));
    expect(only(loss.report).exitPrice).toBe(95);
    expect(only(loss.report).pnl).toBeCloseTo(-5);
  });

  it('can fill on the entry bar', () => {
    const { report } = simulate([entryBars[0], [100, 106, 98, 104]], at(0, (b) => (long(b), bracket(b))));
    expect(only(report)).toMatchObject({ entryBar: 1, exitBar: 1, entryPrice: 100, exitPrice: 105 });
  });

  it('fills the level nearer the open first when one bar touches both', () => {
    // open 101: high 106 is 5 away, low 94 is 7 away, so the path goes up first.
    const up = simulate([...entryBars, [101, 106, 94, 100]], at(0, (b) => (long(b), bracket(b))));
    expect(only(up.report).exitPrice).toBe(105);
    // open 99: low 94 is 5 away, high 106 is 7 away, so the stop fills first.
    const down = simulate([...entryBars, [99, 106, 94, 100]], at(0, (b) => (long(b), bracket(b))));
    expect(only(down.report).exitPrice).toBe(95);
  });

  it('fills a stop at the open when the bar gaps through it', () => {
    const { report } = simulate([...entryBars, [90, 92, 88, 91]], at(0, (b) => (long(b), b.exit('X', exitParams({ stop: 95, limit: 120 })))));
    expect(only(report).exitPrice).toBe(90);
    expect(only(report).pnl).toBeCloseTo(-10);
  });

  it('uses the nearer of limit and profit, and of stop and loss', () => {
    const p = exitParams({ fromEntry: 'L', profit: 10, limit: 104, loss: 10, stop: 97 });
    expect(only(simulate([...entryBars, [101, 106, 100, 104]], at(0, (b) => (long(b), b.exit('X', p)))).report).exitPrice).toBe(104);
    expect(only(simulate([...entryBars, [99, 100, 95, 96]], at(0, (b) => (long(b), b.exit('X', p)))).report).exitPrice).toBe(97);
  });

  it('works for shorts', () => {
    const { report } = simulate([...entryBars, [99, 100, 94, 96]], at(0, (b) => (short(b), b.exit('X', exitParams({ fromEntry: 'S', profit: 5, loss: 5 })))));
    expect(only(report)).toMatchObject({ direction: 'short', entryPrice: 100, exitPrice: 95 });
    expect(only(report).pnl).toBeCloseTo(5);
  });

  it('closes part of a trade with qty_percent and keeps the rest open', () => {
    const { report, broker } = simulate([...entryBars, [101, 106, 100, 104]], at(0, (b) => (long(b, 'L', 4), b.exit('TP1', exitParams({ fromEntry: 'L', qtyPercent: 50, profit: 5 })))));
    expect(only(report)).toMatchObject({ qty: 2, exitPrice: 105 });
    expect(broker.positionSize).toBe(2);
    expect(report.openTrades[0].qty).toBe(2);
  });

  it('trails the best price after activation', () => {
    // Activation at 105 (5 ticks), offset 2 ticks. Path 100 -> 99 -> 108 -> 101: best 108, stop 106.
    const { report } = simulate([entryBars[0], [100, 108, 99, 101]], at(0, (b) => (long(b), b.exit('T', exitParams({ trailPoints: 5, trailOffset: 2, commentTrailing: 'trail' })))));
    expect(only(report)).toMatchObject({ exitPrice: 106, exitSignal: 'trail' });
  });

  it('drops an exit when its trade has closed', () => {
    const bars: Bar[] = [...entryBars, [101, 106, 100, 104], [104, 105, 103, 104], [104, 120, 80, 100]];
    // Re-entering after the take profit: the old bracket must not close the new trade.
    const { report } = simulate(bars, all(at(0, (b) => (long(b), bracket(b))), at(3, (b) => long(b))));
    expect(report.trades).toHaveLength(1);
    expect(report.openTrades).toHaveLength(1);
  });

  it('records run-up and drawdown', () => {
    const { report } = simulate(
      [entryBars[0], [100, 103, 97, 101], [101, 102, 100, 101]],
      all(at(0, (b) => long(b, 'L', 2)), at(1, (b) => b.close('L', null, NaN, NaN, false))),
    );
    expect(only(report)).toMatchObject({ runUp: 6, drawdown: 6, exitPrice: 101 });
  });
});

describe('positions', () => {
  const flat: Bar[] = Array.from({ length: 6 }, (_, i): Bar => [100 + i, 100 + i, 100 + i, 100 + i]);

  it('reverses an open position on an opposite entry', () => {
    const { report, positions } = simulate(flat, all(at(0, (b) => long(b, 'L', 1)), at(2, (b) => short(b, 'S', 3))));
    expect(positions).toEqual([0, 1, 1, -3, -3, -3]);
    const t = only(report);
    expect(t).toMatchObject({ entryPrice: 101, exitPrice: 103, exitId: 'S', exitSignal: 'S' });
    expect(t.pnl).toBeCloseTo(2);
    expect(report.openTrades[0]).toMatchObject({ direction: 'short', qty: 3, entryPrice: 103 });
    expect(report.fills.map((f) => [f.bar, f.side, f.kind])).toEqual([
      [1, 1, 'entry'],
      [3, -1, 'exit'],
      [3, -1, 'entry'],
    ]);
  });

  it('allows one entry per direction unless pyramiding is set', () => {
    const entries = (i: number, b: Broker) => {
      if (i < 3) long(b, `L${i}`, 1);
    };
    expect(simulate(flat, entries).positions).toEqual([0, 1, 1, 1, 1, 1]);
    const { positions, broker } = simulate(flat, entries, { pyramiding: 2 });
    expect(positions).toEqual([0, 1, 2, 2, 2, 2]);
    expect(broker.positionAvgPrice).toBeCloseTo(101.5);
  });

  it('closes every trade with close_all', () => {
    const steps = all(
      at(0, (b) => long(b, 'A', 1)),
      at(1, (b) => long(b, 'B', 2)),
      at(2, (b) => b.close(null, null, NaN, NaN, false)),
    );
    const { report, positions } = simulate(flat, steps, { pyramiding: 3 });
    expect(positions).toEqual([0, 1, 3, 0, 0, 0]);
    expect(report.trades.map((t) => [t.entryId, t.qty, t.entryPrice, t.exitPrice, t.exitId])).toEqual([
      ['A', 1, 101, 103, 'Close all'],
      ['B', 2, 102, 103, 'Close all'],
    ]);
    expect(report.summary.netProfit).toBeCloseTo(2 + 2);
  });

  it('closes only the named entry with strategy.close, oldest first for partial quantities', () => {
    const steps = all(
      at(0, (b) => long(b, 'A', 1)),
      at(1, (b) => long(b, 'B', 2)),
      at(2, (b) => b.close('B', null, 1, NaN, false)),
    );
    const { positions, report } = simulate(flat, steps, { pyramiding: 3 });
    expect(positions).toEqual([0, 1, 3, 2, 2, 2]);
    expect(only(report)).toMatchObject({ entryId: 'B', qty: 1 });
  });

  it('nets strategy.order against the open position', () => {
    const { positions, report } = simulate(flat, all(at(0, (b) => b.order('buy', 1, 2, NaN, NaN, null)), at(2, (b) => b.order('sell', -1, 5, NaN, NaN, null))));
    expect(positions).toEqual([0, 2, 2, -3, -3, -3]);
    expect(only(report)).toMatchObject({ qty: 2, entryPrice: 101, exitPrice: 103, exitId: 'sell' });
  });

  it('sizes orders from the default quantity settings', () => {
    const one: Bar[] = [
      [100, 100, 100, 100],
      [100, 100, 100, 100],
    ];
    expect(simulate(one, at(0, (b) => long(b)), { defaultQtyValue: 3 }).broker.positionSize).toBe(3);
    expect(simulate(one, at(0, (b) => long(b)), { defaultQtyType: 'cash', defaultQtyValue: 1000 }).broker.positionSize).toBeCloseTo(10);
    expect(simulate(one, at(0, (b) => long(b)), { defaultQtyType: 'percent_of_equity', defaultQtyValue: 50, initialCapital: 10_000 }).broker.positionSize).toBeCloseTo(50);
    // An explicit qty wins over the default.
    expect(simulate(one, at(0, (b) => long(b, 'L', 7)), { defaultQtyType: 'cash', defaultQtyValue: 1000 }).broker.positionSize).toBe(7);
  });
});

describe('costs', () => {
  const bars: Bar[] = [
    [100, 100, 100, 100],
    [100, 100, 100, 100],
    [110, 110, 110, 110],
  ];
  const trip = all(at(0, (b) => long(b, 'L', 10)), at(1, (b) => b.close('L', null, NaN, NaN, false)));

  it('charges percent, per contract and per order commission on both fills', () => {
    // Entry value 1000, exit value 1100, gross profit 100.
    const pct = only(simulate(bars, trip, { commissionType: 'percent', commissionValue: 0.1 }).report);
    expect(pct.commission).toBeCloseTo(1 + 1.1);
    expect(pct.pnl).toBeCloseTo(97.9);
    expect(only(simulate(bars, trip, { commissionType: 'cash_per_contract', commissionValue: 0.5 }).report).pnl).toBeCloseTo(90);
    expect(only(simulate(bars, trip, { commissionType: 'cash_per_order', commissionValue: 3 }).report).pnl).toBeCloseTo(94);
    const r = simulate(bars, trip, { commissionType: 'cash_per_order', commissionValue: 3 }).report;
    expect(r.summary.commissionPaid).toBeCloseTo(6);
    expect(r.summary.netProfit).toBeCloseTo(94);
  });

  it('counts the entry commission in open profit and equity', () => {
    const { broker } = simulate(bars, at(0, (b) => long(b, 'L', 10)), { commissionType: 'cash_per_order', commissionValue: 3 });
    expect(broker.openProfit).toBeCloseTo(97);
    expect(broker.equity).toBeCloseTo(100_097);
  });

  it('applies slippage to market and stop fills but not to limits', () => {
    // mintick 0.5, 2 ticks: buys fill 1 higher, sells 1 lower.
    const market = only(simulate(bars, trip, { slippage: 2 }, 0.5).report);
    expect([market.entryPrice, market.exitPrice]).toEqual([101, 109]);
    expect(market.pnl).toBeCloseTo(80);
    const path: Bar[] = [
      [100, 100, 100, 100],
      [100, 106, 99, 105],
      [105, 105, 90, 92],
    ];
    const stopped = only(simulate(path, at(0, (b) => (long(b, 'L', 1, NaN, 104), b.exit('X', exitParams({ stop: 95 })))), { slippage: 2 }, 0.5).report);
    expect([stopped.entryPrice, stopped.exitPrice]).toEqual([105, 94]);
    const limited = simulate(path, at(0, (b) => long(b, 'L', 1, 99.5)), { slippage: 2 }, 0.5).report;
    expect(limited.openTrades[0].entryPrice).toBe(99.5);
  });
});

describe('statistics', () => {
  const trade = (pnl: number, pnlPercent = pnl / 10): ClosedTrade => ({
    entryId: 'L',
    entrySignal: 'L',
    direction: 'long',
    qty: 1,
    entryBar: 0,
    entryTime: 0,
    entryPrice: 100,
    exitId: 'X',
    exitSignal: 'X',
    exitBar: 1,
    exitTime: H,
    exitPrice: 100 + pnl,
    pnl,
    pnlPercent,
    commission: 0,
    runUp: 0,
    drawdown: 0,
  });
  const config = { ...new Broker().config, initialCapital: 1000 };

  it('computes profit, ratios, extremes, drawdown and buy and hold', () => {
    const s = summarize({
      config,
      trades: [trade(10), trade(-5), trade(20), trade(-5), trade(0)],
      equity: [1000, 1010, 1005, 990, 1020, 1015],
      times: [0, H, 2 * H, 3 * H, 4 * H, 5 * H],
      closes: [100, 104, 103, 99, 118, 120],
      periodSeconds: 3600,
      openProfit: 0,
      openTrades: 0,
      commissionPaid: 0,
      positionSize: 0,
    });
    expect(s.netProfit).toBeCloseTo(20);
    expect(s.netProfitPercent).toBeCloseTo(2);
    expect(s.grossProfit).toBeCloseTo(30);
    expect(s.grossLoss).toBeCloseTo(10);
    expect(s.profitFactor).toBeCloseTo(3);
    expect([s.totalClosedTrades, s.winningTrades, s.losingTrades, s.evenTrades]).toEqual([5, 2, 2, 1]);
    expect(s.percentProfitable).toBeCloseTo(40);
    expect(s.avgTrade).toBeCloseTo(4);
    expect(s.avgTradePercent).toBeCloseTo(0.4);
    expect(s.avgWin).toBeCloseTo(15);
    expect(s.avgLoss).toBeCloseTo(-5);
    expect(s.ratioAvgWinLoss).toBeCloseTo(3);
    expect(s.largestWin).toBe(20);
    expect(s.largestLoss).toBe(-5);
    // Peak 1010, trough 990.
    expect(s.maxDrawdown).toBeCloseTo(20);
    expect(s.maxDrawdownPercent).toBeCloseTo((20 / 1010) * 100);
    expect(s.buyAndHoldPercent).toBeCloseTo(20);
    expect(s.buyAndHold).toBeCloseTo(200);
    expect(s.finalEquity).toBe(1015);
  });

  it('handles no trades without dividing by zero', () => {
    const s = summarize({ config, trades: [], equity: [1000], times: [0], closes: [100], periodSeconds: 3600, openProfit: 0, openTrades: 0, commissionPaid: 0, positionSize: 0 });
    expect(s.profitFactor).toBeNull();
    expect(s.percentProfitable).toBeNull();
    expect(s.avgTrade).toBeNull();
    expect(s.sharpe).toBeNull();
    expect(s.maxDrawdown).toBe(0);
  });

  it('computes an annualized Sharpe ratio from daily equity', () => {
    const D = 86_400_000;
    // Daily bars: returns 10% then -5%.
    const r = [0.1, -0.05];
    const mean = (r[0] + r[1]) / 2;
    const sd = Math.sqrt(((r[0] - mean) ** 2 + (r[1] - mean) ** 2) / 1);
    expect(sharpeRatio([1100, 1045], [0, D], 1000, 86_400)).toBeCloseTo((mean / sd) * Math.sqrt(365));
    // Hourly bars are grouped by UTC day; the last equity of each day counts.
    expect(sharpeRatio([1050, 1100, 1060, 1045], [0, H, D, D + H], 1000, 3600)).toBeCloseTo((mean / sd) * Math.sqrt(365));
    // Weekly bars: 52.14 periods a year.
    expect(sharpeRatio([1100, 1045], [0, 7 * D], 1000, 7 * 86_400)).toBeCloseTo((mean / sd) * Math.sqrt(365 / 7));
    expect(sharpeRatio([1010, 1020.1], [0, D], 1000, 86_400)).toBeNull();
  });
});

describe('strategy scripts', () => {
  const bars = [
    { timestamp: 0, open: 100, high: 101, low: 99, close: 100 },
    { timestamp: H, open: 100, high: 102, low: 99, close: 101 },
    { timestamp: 2 * H, open: 102, high: 104, low: 101, close: 103 },
    { timestamp: 3 * H, open: 103, high: 106, low: 102, close: 105 },
    { timestamp: 4 * H, open: 106, high: 107, low: 104, close: 104 },
  ];

  it('fills orders from a script and exposes the position to it', () => {
    const e = run(
      `strategy("t", overlay = true, initial_capital = 1000)
if bar_index == 1
    strategy.entry("Long", strategy.long, qty = 2)
if bar_index == 3
    strategy.close("Long", comment = "done")
plot(strategy.position_size, "size")
plot(strategy.equity, "equity")
plot(strategy.closedtrades, "closed")`,
      bars,
    );
    expect(plotValues(e, 0)).toEqual([0, 0, 2, 2, 0]);
    // Long 2 from 102 (bar 2 open), closed at 106 (bar 4 open).
    expect(plotValues(e, 1)).toEqual([1000, 1000, 1002, 1006, 1008]);
    expect(plotValues(e, 2)).toEqual([0, 0, 0, 0, 1]);
    const r = e.strategy!;
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]).toMatchObject({ entryPrice: 102, exitPrice: 106, exitSignal: 'done', qty: 2, pnl: 8 });
    expect(r.summary.netProfit).toBe(8);
    expect(r.config.initialCapital).toBe(1000);
  });

  it('reads the declaration settings', () => {
    const e = compile(`strategy("Settings", "S", true, pyramiding = 3, default_qty_type = strategy.percent_of_equity, default_qty_value = 10, initial_capital = 5000, commission_type = strategy.commission.cash_per_order, commission_value = 2, slippage = 3, process_orders_on_close = true, currency = "USD", calc_on_every_tick = true)
plot(close)`);
    expect(e.meta).toMatchObject({ title: 'Settings', shortTitle: 'S', overlay: true });
    expect(e.meta.strategy).toEqual({
      initialCapital: 5000,
      defaultQtyType: 'percent_of_equity',
      defaultQtyValue: 10,
      commissionType: 'cash_per_order',
      commissionValue: 2,
      slippage: 3,
      pyramiding: 3,
      processOrdersOnClose: true,
    });
    expect(e.isStrategy).toBe(true);
    expect(compile('indicator("i")\nplot(close)').strategy).toBeNull();
  });

  it('gives clear errors', () => {
    const err = (src: string) => {
      const r = compileScript(src);
      return r.ok ? null : r.error.message;
    };
    expect(err('indicator("i")\nstrategy.entry("L", strategy.long)')).toMatch(/strategy\.entry' can only be used in a script declared with strategy\(\)/);
    expect(err('indicator("i")\nplot(strategy.position_size)')).toMatch(/declared with strategy/);
    expect(err('strategy("s")\nstrategy("t")')).toMatch(/only once/);
    expect(err('strategy("s", default_qty_type = "lots")')).toMatch(/default_qty_type must be one of strategy.fixed/);
    expect(err('strategy("s", initial_capital = 0)')).toMatch(/initial_capital/);
    expect(err('strategy("s")\nstrategy.risk.max_drawdown(10, strategy.percent_of_equity)')).toMatch(/not supported yet/);
    const r = compile('strategy("s")\nstrategy.entry("L", "up")').run(bars);
    expect(r.error?.message).toMatch(/strategy.long or strategy.short/);
  });

  it('recomputes the whole run on live updates without doubling trades', () => {
    const src = `strategy("x", overlay = true)
if ta.crossover(ta.sma(close, 5), ta.sma(close, 20))
    strategy.entry("L", strategy.long)
if ta.crossunder(ta.sma(close, 5), ta.sma(close, 20))
    strategy.entry("S", strategy.short)`;
    const e = compile(src);
    e.run(CANDLES);
    const first = e.strategy!;
    expect(first.trades.length).toBeGreaterThan(3);
    const updated = CANDLES.map((c, i) => (i === CANDLES.length - 1 ? { ...c, close: c.close + 0.01 } : c));
    const res = e.run(updated);
    expect(res.incremental).toBe(false);
    expect(e.strategy!.trades.length).toBe(first.trades.length);
    expect(e.strategy!.summary.netProfit).toBeCloseTo(first.summary.netProfit, 6);
  });

  it('keeps the report consistent on a longer run', () => {
    const e = run(`strategy("RSI", overlay = true, pyramiding = 2, default_qty_type = strategy.percent_of_equity, default_qty_value = 50, commission_value = 0.05, slippage = 2)
r = ta.rsi(close, 14)
if ta.crossover(r, 45)
    strategy.entry("L", strategy.long)
    strategy.exit("X", "L", profit = 300, loss = 200)
if ta.crossunder(r, 60)
    strategy.close_all()
plot(strategy.position_size)`);
    const r = e.strategy!;
    expect(r.trades.length).toBeGreaterThan(2);
    const sum = r.trades.reduce((s, t) => s + t.pnl, 0);
    expect(r.summary.netProfit).toBeCloseTo(sum, 6);
    expect(r.summary.finalEquity).toBeCloseTo(r.summary.initialCapital + r.summary.netProfit + r.summary.openProfit, 6);
    expect(r.equity).toHaveLength(CANDLES.length);
    // The plotted position matches the fills.
    const size = plotValues(e, 0);
    let pos = 0;
    const byBar = new Map<number, number>();
    for (const f of r.fills) byBar.set(f.bar, (byBar.get(f.bar) ?? 0) + f.side * f.qty);
    size.forEach((v, i) => {
      pos += byBar.get(i) ?? 0;
      expect(v).toBeCloseTo(pos, 6);
    });
    for (const t of r.trades) {
      expect(t.exitBar).toBeGreaterThanOrEqual(t.entryBar);
      expect(t.commission).toBeGreaterThan(0);
    }
  });

  it('summarizes a backtest as JSON for automation', () => {
    const e = run(`strategy("x", overlay = true, initial_capital = 1000)
if ta.crossover(ta.sma(close, 5), ta.sma(close, 20))
    strategy.entry("L", strategy.long)
if ta.crossunder(ta.sma(close, 5), ta.sma(close, 20))
    strategy.entry("S", strategy.short)`);
    const r = e.strategy!;
    const json = backtestSummary(r, 3);
    expect(json.totalTrades).toBe(r.trades.length);
    expect(json.trades).toHaveLength(3);
    expect(json.trades[2].n).toBe(r.trades.length);
    const last = r.trades[r.trades.length - 1];
    expect(json.trades[2]).toMatchObject({
      direction: last.direction,
      entryTime: new Date(last.entryTime).toISOString(),
      exitTime: new Date(last.exitTime).toISOString(),
      entrySignal: last.entrySignal,
      exitSignal: last.exitSignal,
      pnl: Math.round(last.pnl * 100) / 100,
    });
    expect(json.openTrades).toHaveLength(r.openTrades.length);
    expect(json.summary.netProfit).toBe(Math.round(r.summary.netProfit * 100) / 100);
    expect(json.settings.initialCapital).toBe(1000);
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
    expect(backtestSummary(r, 0).trades).toEqual([]);
  });
});
