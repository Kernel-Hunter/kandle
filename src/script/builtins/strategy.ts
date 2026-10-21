/** strategy.* built-ins: orders, position and performance state. They talk to the runtime's broker. */
import type { Runtime } from '../runtime';
import type { Broker, OcaType, RiskAmountType, RiskDirection, RiskSettings, Side } from '../strategy';
import { BuiltinError, CONSTANTS, VARIABLES, fn, num } from './registry';

CONSTANTS.set('strategy.long', 'long');
CONSTANTS.set('strategy.short', 'short');
CONSTANTS.set('strategy.fixed', 'fixed');
CONSTANTS.set('strategy.cash', 'cash');
CONSTANTS.set('strategy.percent_of_equity', 'percent_of_equity');
CONSTANTS.set('strategy.commission.percent', 'percent');
CONSTANTS.set('strategy.commission.cash_per_contract', 'cash_per_contract');
CONSTANTS.set('strategy.commission.cash_per_order', 'cash_per_order');
for (const k of ['none', 'cancel', 'reduce']) CONSTANTS.set(`strategy.oca.${k}`, k);
for (const k of ['all', 'long', 'short']) CONSTANTS.set(`strategy.direction.${k}`, k);

function broker(rt: Runtime, name: string): Broker {
  if (!rt.strategy) throw new BuiltinError(`${name}() needs a script declared with strategy()`);
  return rt.strategy;
}

function id(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v) throw new BuiltinError(`${name}() needs an id string as its first argument`);
  return v;
}

function side(v: unknown, name: string): Side {
  if (v === 'long') return 1;
  if (v === 'short') return -1;
  throw new BuiltinError(`${name}() needs strategy.long or strategy.short as the direction`);
}

/** Optional number argument: NaN when missing or na. */
const opt = (v: unknown): number => (v === undefined ? NaN : num(v));
/** Optional string argument: null when missing or na. */
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);

const isNa = (v: unknown) => v === undefined || v === null || (typeof v === 'number' && v !== v);

function ocaName(v: unknown, name: string): string | null {
  if (isNa(v)) return null;
  if (typeof v !== 'string') throw new BuiltinError(`${name}() needs a string for oca_name`);
  return v || null;
}

function ocaType(v: unknown, name: string): OcaType {
  if (isNa(v)) return 'none';
  if (v === 'none' || v === 'cancel' || v === 'reduce') return v;
  throw new BuiltinError(`${name}() needs strategy.oca.none, strategy.oca.cancel or strategy.oca.reduce as oca_type`);
}

const ORDER_PARAMS = ['id', 'direction', 'qty', 'limit', 'stop', 'oca_name', 'oca_type', 'comment', 'alert_message', 'disable_alert'];

for (const kind of ['entry', 'order'] as const) {
  const name = `strategy.${kind}`;
  fn(name, ORDER_PARAMS, 2, ([i, d, qty, limit, stop, oName, oType, comment], _s, rt) => {
    broker(rt, name)[kind](id(i, name), side(d, name), opt(qty), opt(limit), opt(stop), text(comment), ocaName(oName, name), ocaType(oType, name));
    return NaN;
  });
}

fn(
  'strategy.exit',
  [
    'id',
    'from_entry',
    'qty',
    'qty_percent',
    'profit',
    'limit',
    'loss',
    'stop',
    'trail_price',
    'trail_points',
    'trail_offset',
    'oca_name',
    'comment',
    'comment_profit',
    'comment_loss',
    'comment_trailing',
    'alert_message',
    'alert_profit',
    'alert_loss',
    'alert_trailing',
    'disable_alert',
  ],
  1,
  ([i, fromEntry, qty, qtyPercent, profit, limit, loss, stop, trailPrice, trailPoints, trailOffset, , comment, cProfit, cLoss, cTrailing], _s, rt) => {
    broker(rt, 'strategy.exit').exit(id(i, 'strategy.exit'), {
      fromEntry: text(fromEntry) ?? '',
      qty: opt(qty),
      qtyPercent: opt(qtyPercent),
      profit: opt(profit),
      limit: opt(limit),
      loss: opt(loss),
      stop: opt(stop),
      trailPrice: opt(trailPrice),
      trailPoints: opt(trailPoints),
      trailOffset: opt(trailOffset),
      comment: text(comment),
      commentProfit: text(cProfit),
      commentLoss: text(cLoss),
      commentTrailing: text(cTrailing),
    });
    return NaN;
  },
);

fn('strategy.close', ['id', 'comment', 'qty', 'qty_percent', 'alert_message', 'immediately', 'disable_alert'], 1, ([i, comment, qty, qtyPercent, , immediately], _s, rt) => {
  broker(rt, 'strategy.close').close(id(i, 'strategy.close'), text(comment), opt(qty), opt(qtyPercent), immediately === true);
  return NaN;
});

fn('strategy.close_all', ['comment', 'alert_message', 'immediately', 'disable_alert'], 0, ([comment, , immediately], _s, rt) => {
  broker(rt, 'strategy.close_all').close(null, text(comment), NaN, NaN, immediately === true);
  return NaN;
});

fn('strategy.cancel', ['id'], 1, ([i], _s, rt) => {
  broker(rt, 'strategy.cancel').cancel(id(i, 'strategy.cancel'));
  return NaN;
});

fn('strategy.cancel_all', [], 0, (_a, _s, rt) => {
  broker(rt, 'strategy.cancel_all').cancelAll();
  return NaN;
});

// ------------------------------------------------------------------ risk rules

/** Checks one argument of a strategy.risk.* call and returns its value; throws on a wrong one. */
type RiskCheck = (v: unknown, name: string) => unknown;

/**
 * Argument checks of the strategy.risk.* functions, in parameter order (null: not checked).
 * The compiler runs them on constant arguments so mistakes show up before the script runs.
 */
export const RISK_CHECKS = new Map<string, Array<RiskCheck | null>>();

const direction: RiskCheck = (v, name): RiskDirection => {
  if (v === 'all' || v === 'long' || v === 'short') return v;
  throw new BuiltinError(`${name}() needs strategy.direction.all, strategy.direction.long or strategy.direction.short`);
};

const positive =
  (what: string): RiskCheck =>
  (v, name) => {
    if (typeof v === 'number' && v > 0 && Number.isFinite(v)) return v;
    throw new BuiltinError(`${name}() needs ${what} more than 0`);
  };

const count: RiskCheck = (v, name) => {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 1) return v;
  throw new BuiltinError(`${name}() needs a whole number of at least 1`);
};

const amountType: RiskCheck = (v, name): RiskAmountType => {
  if (isNa(v)) return 'percent_of_equity';
  if (v === 'percent_of_equity' || v === 'cash') return v;
  throw new BuiltinError(`${name}() needs strategy.percent_of_equity or strategy.cash as its type`);
};

function risk(rule: string, params: string[], required: number, checks: Array<RiskCheck | null>, apply: (vals: any[]) => Partial<RiskSettings>): void {
  const name = `strategy.risk.${rule}`;
  RISK_CHECKS.set(name, checks);
  fn(name, params, required, (args, _s, rt) => {
    const vals = checks.map((check, i) => (check ? check(args[i], name) : args[i]));
    broker(rt, name).setRisk(apply(vals));
    return NaN;
  });
}

risk('allow_entry_in', ['value'], 1, [direction], ([v]) => ({ allowEntryIn: v }));
risk('max_position_size', ['contracts'], 1, [positive('a number of contracts')], ([v]) => ({ maxPositionSize: v }));
risk('max_drawdown', ['value', 'type', 'alert_message'], 1, [positive('a value'), amountType, null], ([value, type]) => ({ maxDrawdown: { value, type } }));
risk('max_intraday_loss', ['value', 'type', 'alert_message'], 1, [positive('a value'), amountType, null], ([value, type]) => ({ maxIntradayLoss: { value, type } }));
risk('max_intraday_filled_orders', ['count', 'alert_message'], 1, [count, null], ([v]) => ({ maxIntradayFilledOrders: v }));
risk('max_cons_loss_days', ['count', 'alert_message'], 1, [count, null], ([v]) => ({ maxConsLossDays: v }));

// ------------------------------------------------------------------ state

const state = (name: string, get: (b: Broker) => number) => VARIABLES.set(`strategy.${name}`, (rt) => (rt.strategy ? get(rt.strategy) : NaN));
state('position_size', (b) => b.positionSize);
state('position_avg_price', (b) => b.positionAvgPrice);
state('equity', (b) => b.equity);
state('netprofit', (b) => b.netProfit);
state('openprofit', (b) => b.openProfit);
state('grossprofit', (b) => b.grossProfit);
state('grossloss', (b) => b.grossLoss);
state('max_drawdown', (b) => b.maxDrawdown);
state('closedtrades', (b) => b.closedCount);
state('opentrades', (b) => b.openCount);
state('wintrades', (b) => b.winCount);
state('losstrades', (b) => b.lossCount);
state('eventrades', (b) => b.evenCount);
state('initial_capital', (b) => b.config.initialCapital);

// strategy.closedtrades.profit(n) and friends: n counts from 0, the oldest trade.
const closedField: Record<string, (t: NonNullable<ReturnType<Broker['closedTrade']>>) => unknown> = {
  entry_price: (t) => t.entryPrice,
  exit_price: (t) => t.exitPrice,
  entry_bar_index: (t) => t.entryBar,
  exit_bar_index: (t) => t.exitBar,
  entry_time: (t) => t.entryTime,
  exit_time: (t) => t.exitTime,
  entry_id: (t) => t.entryId,
  exit_id: (t) => t.exitId,
  profit: (t) => t.pnl,
  commission: (t) => t.commission,
  size: (t) => (t.direction === 'long' ? t.qty : -t.qty),
  max_runup: (t) => t.runUp,
  max_drawdown: (t) => t.drawdown,
};
for (const [field, get] of Object.entries(closedField)) {
  fn(`strategy.closedtrades.${field}`, ['trade_num'], 1, ([n], _s, rt) => {
    const t = broker(rt, `strategy.closedtrades.${field}`).closedTrade(Math.trunc(num(n)));
    return t ? get(t) : field.endsWith('_id') ? null : NaN;
  });
}

const openField: Record<string, (t: NonNullable<ReturnType<Broker['openTrade']>>) => unknown> = {
  entry_price: (t) => t.entryPrice,
  entry_bar_index: (t) => t.entryBar,
  entry_time: (t) => t.entryTime,
  entry_id: (t) => t.entryId,
  profit: (t) => t.pnl,
  commission: (t) => t.commission,
  size: (t) => t.dir * t.qty,
};
for (const [field, get] of Object.entries(openField)) {
  fn(`strategy.opentrades.${field}`, ['trade_num'], 1, ([n], _s, rt) => {
    const t = broker(rt, `strategy.opentrades.${field}`).openTrade(Math.trunc(num(n)));
    return t ? get(t) : field === 'entry_id' ? null : NaN;
  });
}
