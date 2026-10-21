import { describe, expect, it } from 'vitest';
import { backtestSummary } from '../../src/script/backtestJson';
import { compileScript } from '../../src/script/engine';
import { Broker, type ExitParams, type OcaType, type RiskSettings, type StrategyConfig } from '../../src/script/strategy';
import { compile } from './fixtures';

const H = 3_600_000;
type Bar = [open: number, high: number, low: number, close: number];

/**
 * Runs the broker over `bars` the way the engine does: fills at the start of each bar, then
 * `onBar` plays the script, then the bar closes. Bars are `step` apart from midnight UTC.
 */
function simulate(bars: Bar[], onBar: (i: number, b: Broker) => void, config: Partial<StrategyConfig> = {}, risk: Partial<RiskSettings> = {}, step = H) {
  const broker = new Broker(config);
  broker.reset(1);
  const positions: number[] = [];
  bars.forEach(([o, h, l, c], i) => {
    broker.beginBar(i, i * step, o, h, l, c);
    positions.push(broker.positionSize);
    broker.setRisk(risk);
    onBar(i, broker);
    broker.endBar(i, c);
  });
  const report = broker.report(
    bars.map((_, i) => i * step),
    bars.map((b) => b[3]),
    step / 1000,
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

type Oca = [name: string | null, type: OcaType];
const entry = (b: Broker, id: string, side: 1 | -1, qty = NaN, limit = NaN, stop = NaN, oca: Oca = [null, 'none']) => b.entry(id, side, qty, limit, stop, null, ...oca);
const order = (b: Broker, id: string, side: 1 | -1, qty = NaN, limit = NaN, stop = NaN, oca: Oca = [null, 'none']) => b.order(id, side, qty, limit, stop, null, ...oca);

describe('order groups (OCA)', () => {
  // A bracket around 100: buy stop at 105, sell stop at 95.
  const bracket = (type: OcaType) => (b: Broker) => {
    entry(b, 'Up', 1, 1, NaN, 105, ['B', type]);
    entry(b, 'Down', -1, 1, NaN, 95, ['B', type]);
  };

  it('cancel: the first fill removes the other side of a bracket', () => {
    const bars: Bar[] = [
      [100, 101, 99, 100],
      [100, 106, 99, 104], // low first, then up through 105
      [104, 104, 90, 92], // would reach the sell stop at 95
    ];
    const { report, positions } = simulate(bars, at(0, bracket('cancel')));
    expect(positions).toEqual([0, 1, 1]);
    expect(report.trades).toHaveLength(0);
    expect(report.openTrades[0]).toMatchObject({ entryId: 'Up', entryPrice: 105, entryBar: 1 });

    // Without the group the sell stop reverses the position on bar 2.
    const plain = simulate(bars, at(0, bracket('none')));
    expect(plain.positions).toEqual([0, 1, -1]);
    expect(plain.report.trades[0]).toMatchObject({ entryPrice: 105, exitPrice: 95, exitBar: 2, exitId: 'Down' });
    expect(plain.broker.positionSize).toBe(-1);
  });

  it('cancel: works inside one bar, following the order the price path reaches the levels', () => {
    // High and low equally far from the open: the path goes up first, so the buy stop fills
    // and the sell stop cannot fill later in the same bar.
    const bars: Bar[] = [
      [100, 101, 99, 100],
      [100, 106, 94, 100],
    ];
    const { report, broker } = simulate(bars, at(0, bracket('cancel')));
    expect(report.trades).toHaveLength(0);
    expect(broker.positionSize).toBe(1);
    expect(report.fills).toHaveLength(1);

    const plain = simulate(bars, at(0, bracket('none')));
    expect(plain.report.trades[0]).toMatchObject({ entryPrice: 105, exitPrice: 95, exitBar: 1 });
    expect(plain.broker.positionSize).toBe(-1);
  });

  it('cancel: the filled entry keeps its strategy.exit bracket', () => {
    const bars: Bar[] = [
      [100, 101, 99, 100],
      [100, 106, 99, 104],
      [104, 104, 90, 92], // high first (it is the open), then down through the stop at 101
    ];
    const { report, broker } = simulate(
      bars,
      at(0, (b) => {
        bracket('cancel')(b);
        b.exit('X', exitParams({ fromEntry: 'Up', stop: 101, limit: 120 }));
      }),
    );
    expect(report.trades).toHaveLength(1);
    expect(report.trades[0]).toMatchObject({ entryPrice: 105, exitPrice: 101, exitId: 'X', exitBar: 2, pnl: -4 });
    expect(broker.positionSize).toBe(0);
  });

  it('reduce: lowers the other orders by the filled quantity and cancels them at zero', () => {
    const bars: Bar[] = [
      [100, 101, 99, 100],
      [100, 100, 97, 99], // A (3 at 98) fills; B 5 -> 2, C 4 -> 1
      [99, 99, 95, 96], // B (2 at 96) fills; C 1 - 2 -> cancelled
      [96, 96, 93, 95], // C at 94 would fill here
    ];
    const { report, positions } = simulate(
      bars,
      at(0, (b) => {
        entry(b, 'A', 1, 3, 98, NaN, ['R', 'reduce']);
        entry(b, 'B', 1, 5, 96, NaN, ['R', 'reduce']);
        entry(b, 'C', 1, 4, 94, NaN, ['R', 'reduce']);
      }),
      { pyramiding: 3 },
    );
    expect(positions).toEqual([0, 3, 5, 5]);
    expect(report.openTrades.map((t) => [t.entryId, t.qty, t.entryPrice])).toEqual([
      ['A', 3, 98],
      ['B', 2, 96],
    ]);
  });

  it('reduce: an order without qty uses its default size', () => {
    const bars: Bar[] = [
      [100, 101, 99, 100],
      [100, 100, 97, 99],
      [99, 99, 95, 96],
    ];
    const { positions } = simulate(
      bars,
      at(0, (b) => {
        entry(b, 'A', 1, NaN, 98, NaN, ['R', 'reduce']);
        entry(b, 'B', 1, NaN, 96, NaN, ['R', 'reduce']);
      }),
      { pyramiding: 2, defaultQtyValue: 2 },
    );
    // A fills 2 contracts; B's default of 2 drops to 0 and B is cancelled.
    expect(positions).toEqual([0, 2, 2]);
  });

  it('none: a group name alone changes nothing', () => {
    const bars: Bar[] = [
      [100, 101, 99, 100],
      [100, 100, 97, 99],
      [99, 99, 95, 96],
    ];
    const { positions } = simulate(
      bars,
      at(0, (b) => {
        entry(b, 'A', 1, 1, 98, NaN, ['N', 'none']);
        entry(b, 'B', 1, 1, 96, NaN, ['N', 'none']);
      }),
      { pyramiding: 2 },
    );
    expect(positions).toEqual([0, 1, 2]);
  });

  it('only affects orders with the same group name, entries and plain orders alike', () => {
    const bars: Bar[] = [
      [100, 101, 99, 100],
      [100, 100, 97, 99],
      [99, 99, 95, 96],
    ];
    const { positions, report } = simulate(
      bars,
      at(0, (b) => {
        entry(b, 'A', 1, 1, 98, NaN, ['G', 'cancel']);
        order(b, 'B', 1, 1, 96, NaN, ['G', 'cancel']);
        order(b, 'C', 1, 1, 96, NaN, ['Other', 'cancel']);
      }),
      { pyramiding: 3 },
    );
    expect(positions).toEqual([0, 1, 2]);
    expect(report.openTrades.map((t) => t.entryId)).toEqual(['A', 'C']);
  });

  it('applies to market orders, at the next open or on the close with process_orders_on_close', () => {
    const bars: Bar[] = [
      [100, 101, 99, 100],
      [102, 103, 101, 102],
    ];
    const place = at(0, (b) => {
      entry(b, 'A', 1, 1, NaN, NaN, ['M', 'cancel']);
      entry(b, 'B', 1, 1, NaN, NaN, ['M', 'cancel']);
    });
    const next = simulate(bars, place, { pyramiding: 2 });
    expect(next.report.openTrades.map((t) => [t.entryId, t.entryPrice])).toEqual([['A', 102]]);
    const onClose = simulate(bars, place, { pyramiding: 2, processOrdersOnClose: true });
    expect(onClose.report.openTrades.map((t) => [t.entryId, t.entryPrice])).toEqual([['A', 100]]);
  });

  it('is not triggered by an entry that does not fill because of pyramiding', () => {
    const bars: Bar[] = [
      [100, 101, 99, 100],
      [100, 101, 99, 100],
      [100, 100, 97, 99],
      [99, 99, 95, 96],
    ];
    const { positions } = simulate(
      bars,
      all(
        at(0, (b) => entry(b, 'L', 1, 1)),
        at(1, (b) => {
          // Pyramiding 1: this entry is ignored when its limit is reached, so B stays.
          entry(b, 'A', 1, 1, 98, NaN, ['G', 'cancel']);
          order(b, 'B', -1, 1, NaN, 96, ['G', 'cancel']);
        }),
      ),
    );
    expect(positions).toEqual([0, 1, 1, 0]);
  });
});

describe('strategy.risk.allow_entry_in', () => {
  const bars: Bar[] = [
    [100, 101, 99, 100],
    [102, 103, 101, 102],
    [104, 105, 103, 104],
    [106, 107, 105, 106],
  ];

  it('turns an entry in the other direction into a close, and ignores it when flat', () => {
    const { report, positions } = simulate(
      bars,
      all(
        at(0, (b) => entry(b, 'L', 1, 1)),
        at(1, (b) => entry(b, 'S', -1, 1)),
        at(2, (b) => entry(b, 'S', -1, 1)),
      ),
      {},
      { allowEntryIn: 'long' },
    );
    expect(positions).toEqual([0, 1, 0, 0]);
    expect(report.trades).toHaveLength(1);
    expect(report.trades[0]).toMatchObject({ entryPrice: 102, exitPrice: 104, exitId: 'S', pnl: 2 });
    expect(report.fills).toHaveLength(2);
  });

  it('lets plain orders reduce but not open in the other direction', () => {
    const { report, positions } = simulate(
      bars,
      all(
        at(0, (b) => order(b, 'B', 1, 1)),
        at(1, (b) => order(b, 'S', -1, 3)),
      ),
      {},
      { allowEntryIn: 'long' },
    );
    expect(positions).toEqual([0, 1, 0, 0]);
    expect(report.trades[0]).toMatchObject({ qty: 1, exitPrice: 104 });
  });

  it('allows both directions with strategy.direction.all, and short only', () => {
    const script = all(
      at(0, (b) => entry(b, 'L', 1, 1)),
      at(1, (b) => entry(b, 'S', -1, 1)),
    );
    expect(simulate(bars, script, {}, { allowEntryIn: 'all' }).positions).toEqual([0, 1, -1, -1]);
    expect(simulate(bars, script, {}, { allowEntryIn: 'short' }).positions).toEqual([0, 0, -1, -1]);
  });
});

describe('strategy.risk.max_position_size', () => {
  const bars: Bar[] = [
    [100, 101, 99, 100],
    [100, 101, 99, 100],
    [100, 101, 99, 100],
    [100, 101, 99, 100],
    [100, 101, 99, 100],
  ];

  it('cuts entries down to the room left and ignores them when there is none', () => {
    const { report, positions } = simulate(
      bars,
      all(
        at(0, (b) => entry(b, 'A', 1, 1.5)),
        at(1, (b) => entry(b, 'B', 1, 1.5)),
        at(2, (b) => entry(b, 'C', 1, 1)),
        at(3, (b) => entry(b, 'S', -1, 5)),
      ),
      { pyramiding: 3 },
      { maxPositionSize: 2 },
    );
    expect(positions).toEqual([0, 1.5, 2, 2, -2]);
    // The reversal closes 2 long and opens 2 short, not 5.
    expect(report.trades.map((t) => [t.entryId, t.qty])).toEqual([
      ['A', 1.5],
      ['B', 0.5],
    ]);
    expect(report.openTrades.map((t) => [t.entryId, t.qty])).toEqual([['S', 2]]);
  });

  it('caps the part of a plain order that opens a position', () => {
    const { positions } = simulate(
      bars,
      all(
        at(0, (b) => order(b, 'B', 1, 1)),
        at(1, (b) => order(b, 'S', -1, 4)),
      ),
      {},
      { maxPositionSize: 2 },
    );
    expect(positions).toEqual([0, 1, -2, -2, -2]);
  });
});

describe('strategy.risk.max_drawdown', () => {
  // Long 10 from 100 on bar 1; bar 2 closes at 95: equity 950, a 5% drawdown.
  const bars: Bar[] = [
    [100, 100, 100, 100],
    [100, 101, 99, 100],
    [100, 100, 95, 95],
    [94, 96, 93, 96],
    [96, 98, 91, 97],
    [97, 99, 96, 98],
  ];
  const script = all(
    at(0, (b) => entry(b, 'L', 1, 10)),
    at(1, (b) => {
      entry(b, 'Add', 1, 5, 92); // a pending limit that bar 4 would reach
      b.exit('X', exitParams({ stop: 80 }));
    }),
    at(4, (b) => entry(b, 'Again', 1, 10)),
  );
  const config = { initialCapital: 1000, pyramiding: 2 };

  it('closes at the next open, cancels pending orders and stops trading', () => {
    const { report, positions } = simulate(bars, script, config, { maxDrawdown: { value: 5, type: 'percent_of_equity' } });
    expect(positions).toEqual([0, 10, 10, 0, 0, 0]);
    expect(report.trades).toHaveLength(1);
    expect(report.trades[0]).toMatchObject({ entryPrice: 100, exitPrice: 94, exitBar: 3, exitId: 'Max drawdown', pnl: -60 });
    expect(report.equity).toEqual([1000, 1000, 950, 940, 940, 940]);
    expect(report.stoppedBy).toMatchObject({ rule: 'max_drawdown', bar: 2, final: true });
    expect(report.stoppedBy!.detail).toBe('Drawdown of 50.00 (5.00%) from the peak of 1000.00 reached the limit of 5% of equity');
    expect(report.riskEvents).toHaveLength(1);
  });

  it('closes on the same close with process_orders_on_close', () => {
    const { report } = simulate(bars, script, { ...config, processOrdersOnClose: true }, { maxDrawdown: { value: 5, type: 'percent_of_equity' } });
    // The entry fills at the close of bar 0 (100) and the risk close at the close of bar 2 (95).
    expect(report.trades[0]).toMatchObject({ entryBar: 0, exitBar: 2, exitPrice: 95, pnl: -50 });
    expect(report.equity).toEqual([1000, 1000, 950, 950, 950, 950]);
    expect(report.openTrades).toHaveLength(0);
  });

  it('takes a cash amount, and does nothing before the limit', () => {
    expect(simulate(bars, script, config, { maxDrawdown: { value: 50, type: 'cash' } }).report.stoppedBy?.bar).toBe(2);
    const under = simulate(bars, script, config, { maxDrawdown: { value: 5.1, type: 'percent_of_equity' } });
    expect(under.report.stoppedBy).toBeNull();
    // The pending limit at 92 fills on bar 4.
    expect(under.positions).toEqual([0, 10, 10, 10, 15, 15]);
  });

  it('measures from the highest equity so far', () => {
    const up: Bar[] = [
      [100, 100, 100, 100],
      [100, 101, 99, 100],
      [100, 110, 100, 110], // equity 1100, the new peak
      [110, 110, 104, 104], // 1040: 60 below the peak, 5.45%
      [104, 105, 103, 104],
    ];
    const { report } = simulate(up, at(0, (b) => entry(b, 'L', 1, 10)), config, { maxDrawdown: { value: 5, type: 'percent_of_equity' } });
    expect(report.stoppedBy).toMatchObject({ bar: 3 });
    expect(report.trades[0]).toMatchObject({ exitPrice: 104, exitBar: 4, pnl: 40 });
  });
});

describe('intraday rules', () => {
  // Eight-hour bars: three per UTC day.
  const step = 8 * H;

  it('max_intraday_loss flattens, blocks entries for the rest of the day and resumes the next day', () => {
    const bars: Bar[] = [
      [100, 100, 100, 100], // day 0
      [100, 100, 96, 97], //   long 10 from 100, equity 970: down 3% on the day
      [97, 98, 96, 98], //     flattened at 97; a new entry is ignored
      [98, 99, 97, 99], // day 1: trading again
      [99, 101, 99, 100],
      [100, 101, 99, 100],
    ];
    const { report, positions } = simulate(
      bars,
      (i, b) => {
        if (i === 0 || i === 2 || i === 3) entry(b, 'L', 1, 10);
      },
      { initialCapital: 1000 },
      { maxIntradayLoss: { value: 3, type: 'percent_of_equity' } },
      step,
    );
    expect(positions).toEqual([0, 10, 0, 0, 10, 10]);
    expect(report.trades).toHaveLength(1);
    expect(report.trades[0]).toMatchObject({ entryPrice: 100, exitPrice: 97, exitBar: 2, exitId: 'Max intraday loss', pnl: -30 });
    expect(report.openTrades[0]).toMatchObject({ entryPrice: 99, entryBar: 4 });
    expect(report.riskEvents).toEqual([
      { rule: 'max_intraday_loss', bar: 1, time: step, final: false, detail: 'Loss of 30.00 (3.00%) since the start of the UTC day reached the limit of 3% of equity' },
    ]);
    expect(report.stoppedBy).toBeNull();
  });

  it('max_intraday_loss measures from the equity at the start of the day, in cash', () => {
    const bars: Bar[] = [
      [100, 100, 100, 100], // day 0
      [100, 100, 90, 90], //   long 10 from 100: equity 900
      [90, 91, 89, 90],
      [90, 91, 87, 88], // day 1 starts from 900: 880 is a loss of 20
      [88, 89, 87, 88],
      [88, 89, 87, 88],
    ];
    const run = (value: number) =>
      simulate(bars, at(0, (b) => entry(b, 'L', 1, 10)), { initialCapital: 1000 }, { maxIntradayLoss: { value, type: 'cash' } }, step).report.riskEvents.map((e) => e.bar);
    expect(run(100)).toEqual([1]);
    expect(run(150)).toEqual([]);
  });

  it('max_intraday_filled_orders stops new orders after the count and resumes the next day', () => {
    const bars: Bar[] = [
      [100, 101, 99, 100], // day 0
      [101, 102, 100, 101], // entry fills (1)
      [102, 103, 101, 102], // close fills (2): limit reached; the new entry is ignored
      [103, 104, 102, 103], // day 1
      [104, 105, 103, 104],
      [105, 106, 104, 105],
    ];
    const { report, positions } = simulate(
      bars,
      (i, b) => {
        if (i === 0 || i === 2 || i === 3) entry(b, 'L', 1, 1);
        if (i === 1) b.close('L', null, NaN, NaN, false);
      },
      {},
      { maxIntradayFilledOrders: 2 },
      step,
    );
    expect(positions).toEqual([0, 1, 0, 0, 1, 1]);
    expect(report.riskEvents.map((e) => [e.rule, e.bar])).toEqual([['max_intraday_filled_orders', 2]]);
    expect(report.trades).toHaveLength(1);
  });

  it('max_intraday_filled_orders flattens an open position, on the close with process_orders_on_close', () => {
    const bars: Bar[] = [
      [100, 101, 99, 100],
      [101, 102, 100, 101],
      [102, 103, 101, 102],
    ];
    const script = at(0, (b) => {
      entry(b, 'A', 1, 1);
      entry(b, 'B', 1, 1);
    });
    const next = simulate(bars, script, { pyramiding: 2 }, { maxIntradayFilledOrders: 2 }, step);
    expect(next.report.trades.map((t) => [t.entryId, t.entryPrice, t.exitPrice, t.exitId])).toEqual([
      ['A', 101, 102, 'Max intraday filled orders'],
      ['B', 101, 102, 'Max intraday filled orders'],
    ]);
    const onClose = simulate(bars, script, { pyramiding: 2, processOrdersOnClose: true }, { maxIntradayFilledOrders: 2 }, step);
    expect(onClose.report.trades.map((t) => [t.entryPrice, t.exitPrice, t.exitBar])).toEqual([
      [100, 100, 0],
      [100, 100, 0],
    ]);
  });

  it('counts a reversal as one order and an exit leg as one order', () => {
    const bars: Bar[] = [
      [100, 101, 99, 100],
      [100, 101, 99, 100], // L fills (1)
      [100, 101, 99, 100], // S reverses (2)
      [100, 101, 90, 95], //  the exit's stop at 95 fills (3)
    ];
    const { report } = simulate(
      bars,
      all(
        at(0, (b) => entry(b, 'L', 1, 1)),
        at(1, (b) => {
          entry(b, 'S', -1, 1);
        }),
        at(2, (b) => b.exit('X', exitParams({ limit: 95 }))),
      ),
      {},
      { maxIntradayFilledOrders: 3 },
      H,
    );
    // L, the reversal S and the exit X are three orders: the limit is reached at the exit,
    // which could not fill if the reversal counted twice.
    expect(report.trades.map((t) => t.exitId)).toEqual(['S', 'X']);
    expect(report.riskEvents.map((e) => e.bar)).toEqual([3]);
    const tighter = simulate(
      bars,
      all(
        at(0, (b) => entry(b, 'L', 1, 1)),
        at(1, (b) => entry(b, 'S', -1, 1)),
      ),
      {},
      { maxIntradayFilledOrders: 2 },
      H,
    );
    expect(tighter.report.riskEvents.map((e) => e.bar)).toEqual([2]);
    expect(tighter.report.trades.map((t) => [t.exitId, t.exitBar])).toEqual([
      ['S', 2],
      ['Max intraday filled orders', 3],
    ]);
  });
});

describe('strategy.risk.max_cons_loss_days', () => {
  const step = 8 * H;

  it('stops trading at the start of the day after the last losing day', () => {
    const bars: Bar[] = [
      [100, 100, 100, 100], // day 0: long 10 from 100 on bar 1
      [100, 100, 99, 99],
      [99, 99, 98, 98], //     day 0 ends at 980: a loss
      [98, 98, 97, 97], // day 1
      [97, 99, 97, 99],
      [99, 99, 96, 96], //     day 1 ends at 960: a second loss
      [95, 96, 94, 95], // day 2: flattened at the open, 95
      [95, 96, 94, 95],
      [95, 96, 94, 95],
    ];
    const { report, positions } = simulate(
      bars,
      (i, b) => {
        if (i === 0 || i === 7) entry(b, 'L', 1, 10);
      },
      { initialCapital: 1000 },
      { maxConsLossDays: 2 },
      step,
    );
    expect(positions).toEqual([0, 10, 10, 10, 10, 10, 0, 0, 0]);
    expect(report.trades[0]).toMatchObject({ exitPrice: 95, exitBar: 6, exitId: 'Max losing days', pnl: -50 });
    expect(report.stoppedBy).toMatchObject({ rule: 'max_cons_loss_days', bar: 6, final: true, detail: '2 losing days in a row, the limit is 2' });
  });

  it('skips days without a change and starts over after a winning day', () => {
    // Day 0 loses and the trade is closed on its last close; day 1 has no position; day 2 loses.
    const loseFlatLose: Bar[] = [
      [100, 100, 100, 100],
      [100, 100, 99, 99],
      [99, 99, 98, 98],
      [98, 98, 98, 98], // day 1: flat
      [98, 98, 98, 98],
      [98, 98, 98, 98],
      [98, 98, 97, 97], // day 2: long 10 from 98, ends at 96
      [97, 97, 96, 96],
      [96, 96, 96, 96],
      [96, 96, 96, 96], // day 3: stopped at the open
    ];
    const script = (i: number, b: Broker) => {
      if (i === 0 || i === 5) entry(b, 'L', 1, 10);
      if (i === 2) b.close('L', null, NaN, NaN, true);
    };
    const r1 = simulate(loseFlatLose, script, { initialCapital: 1000 }, { maxConsLossDays: 2 }, step).report;
    expect(r1.stoppedBy).toMatchObject({ bar: 9 });

    // Same as above but day 1 holds a long that gains.
    const script2 = (i: number, b: Broker) => {
      if (i === 0 || i === 2 || i === 5) entry(b, 'L', 1, 10);
      if (i === 2) b.close('L', null, NaN, NaN, true);
      if (i === 4) b.close('L', null, NaN, NaN, true);
    };
    const gain = loseFlatLose.map((b, i): Bar => (i === 3 ? [98, 99, 98, 99] : i === 4 ? [99, 99, 99, 99] : b));
    const r2 = simulate(gain, script2, { initialCapital: 1000 }, { maxConsLossDays: 2 }, step).report;
    // Day 1: long from 98 (bar 3 open), closed at 99 on bar 4: a winning day.
    expect(r2.trades.map((t) => t.pnl)).toEqual([-20, 10]);
    expect(r2.stoppedBy).toBeNull();
  });
});

describe('risk rules and order groups in scripts', () => {
  const bars = [
    { timestamp: 0, open: 100, high: 100, low: 100, close: 100 },
    { timestamp: H, open: 100, high: 101, low: 99, close: 100 },
    { timestamp: 2 * H, open: 100, high: 100, low: 95, close: 95 },
    { timestamp: 3 * H, open: 94, high: 96, low: 93, close: 96 },
    { timestamp: 4 * H, open: 96, high: 98, low: 91, close: 97 },
  ];

  it('reads the risk settings and reports the rule that stopped trading', () => {
    const e = compile(`strategy("t", initial_capital = 1000)
strategy.risk.allow_entry_in(strategy.direction.long)
strategy.risk.max_position_size(20)
strategy.risk.max_drawdown(5, strategy.percent_of_equity)
strategy.risk.max_intraday_loss(400, strategy.cash)
strategy.risk.max_intraday_filled_orders(10)
strategy.risk.max_cons_loss_days(3)
if bar_index == 0 or bar_index == 3
    strategy.entry("L", strategy.long, qty = 10)
plot(strategy.position_size)`);
    expect(e.run(bars).error).toBeNull();
    const r = e.strategy!;
    expect(r.risk).toEqual({
      allowEntryIn: 'long',
      maxPositionSize: 20,
      maxDrawdown: { value: 5, type: 'percent_of_equity' },
      maxIntradayLoss: { value: 400, type: 'cash' },
      maxIntradayFilledOrders: 10,
      maxConsLossDays: 3,
    });
    expect(r.stoppedBy).toMatchObject({ rule: 'max_drawdown', bar: 2 });
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0]).toMatchObject({ exitPrice: 94, exitId: 'Max drawdown' });
    expect(r.openTrades).toHaveLength(0);

    const json = backtestSummary(r, 10);
    expect(json.settings.risk).toEqual({
      allowEntryIn: 'long',
      maxPositionSize: 20,
      maxDrawdown: { value: 5, type: 'percent_of_equity' },
      maxIntradayLoss: { value: 400, type: 'cash' },
      maxIntradayFilledOrders: 10,
      maxConsLossDays: 3,
    });
    expect(json.riskStop).toEqual({ rule: 'max_drawdown', time: new Date(2 * H).toISOString(), detail: r.stoppedBy!.detail });
    expect(json.riskHalts).toBe(0);
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  it('defaults the type to percent of equity and leaves risk out of the JSON when unused', () => {
    const e = compile('strategy("t")\nstrategy.risk.max_drawdown(10)\nplot(close)');
    e.run(bars);
    expect(e.strategy!.risk.maxDrawdown).toEqual({ value: 10, type: 'percent_of_equity' });
    const plain = compile('strategy("t")\nplot(close)');
    plain.run(bars);
    const json = backtestSummary(plain.strategy!, 5);
    expect('risk' in json.settings).toBe(false);
    expect(json.riskStop).toBeNull();
  });

  it('places entries in an order group', () => {
    const e = compile(`strategy("t")
if bar_index == 0
    strategy.entry("Up", strategy.long, 1, stop = 101, oca_name = "B", oca_type = strategy.oca.cancel)
    strategy.entry("Down", strategy.short, 1, stop = 96, oca_name = "B", oca_type = strategy.oca.cancel)
plot(strategy.position_size)`);
    expect(e.run(bars).error).toBeNull();
    // Bar 1 goes up first (high and low are equally far from the open) and fills the buy stop;
    // the sell stop is cancelled, so bar 2 dropping to 95 does not reverse the position.
    expect(e.strategy!.openTrades.map((t) => [t.entryId, t.entryPrice])).toEqual([['Up', 101]]);
    expect(e.strategy!.trades).toHaveLength(0);
  });

  it('gives errors with line and column for wrong arguments', () => {
    const err = (src: string) => {
      const r = compileScript(src);
      return r.ok ? null : r.error.format();
    };
    expect(err('strategy("s")\nstrategy.risk.allow_entry_in("up")')).toBe(
      '2:30 strategy.risk.allow_entry_in() needs strategy.direction.all, strategy.direction.long or strategy.direction.short',
    );
    expect(err('strategy("s")\nstrategy.risk.max_drawdown(10, strategy.fixed)')).toBe(
      '2:32 strategy.risk.max_drawdown() needs strategy.percent_of_equity or strategy.cash as its type',
    );
    expect(err('strategy("s")\nstrategy.risk.max_drawdown(0)')).toBe('2:28 strategy.risk.max_drawdown() needs a value more than 0');
    expect(err('strategy("s")\nstrategy.risk.max_position_size("2")')).toBe('2:33 strategy.risk.max_position_size() needs a number of contracts more than 0');
    expect(err('strategy("s")\nstrategy.risk.max_intraday_filled_orders(1.5)')).toBe('2:42 strategy.risk.max_intraday_filled_orders() needs a whole number of at least 1');
    expect(err('strategy("s")\nstrategy.risk.max_cons_loss_days(true)')).toBe('2:34 strategy.risk.max_cons_loss_days() needs a whole number of at least 1');
    expect(err('strategy("s")\nif close > open\n    strategy.risk.max_position_size(2)')).toBe('3:5 strategy.risk.max_position_size() must be called at the top level');
    expect(err('strategy("s")\nstrategy.risk.max_drawdown()')).toBe("2:1 'strategy.risk.max_drawdown' needs the 'value' argument");
    expect(err('indicator("i")\nstrategy.risk.max_drawdown(5)')).toMatch(/^2:1 'strategy.risk.max_drawdown' can only be used in a script declared with strategy\(\)/);

    // Values only known when the script runs are checked then, with the same position.
    const runErr = (src: string) => compile(src).run(bars).error?.format();
    expect(runErr('strategy("s")\nstrategy.risk.max_position_size(input.float(0, "Size"))')).toBe('2:1 strategy.risk.max_position_size() needs a number of contracts more than 0 (on bar 0)');
    expect(runErr('strategy("s")\nstrategy.entry("L", strategy.long, oca_name = "G", oca_type = "both")')).toBe(
      '2:1 strategy.entry() needs strategy.oca.none, strategy.oca.cancel or strategy.oca.reduce as oca_type (on bar 0)',
    );
    expect(runErr('strategy("s")\nstrategy.order("L", strategy.long, oca_name = 5)')).toBe('2:1 strategy.order() needs a string for oca_name (on bar 0)');
  });
});
