/**
 * Broker emulator for strategy scripts. It keeps the orders a script places, fills them
 * against bar prices, tracks open and closed trades, and builds the backtest report.
 *
 * Fill model. Everything is bar by bar and deterministic:
 * - The script runs at the close of each bar. Orders placed on bar N are filled from bar
 *   N+1 on: market orders at the open of N+1, limit and stop orders once the price path of
 *   a bar reaches their price. With `process_orders_on_close = true`, market orders fill
 *   at the close of the bar that placed them instead.
 * - Inside a bar, price is assumed to move open, then to the extreme nearer the open, then
 *   to the other extreme, then to the close (high first when both are equally far). Orders
 *   fill in the order that path reaches them, so when one bar touches both the stop and the
 *   target of an exit, the level nearer the open fills and the other is cancelled.
 * - A limit or stop order whose price is already passed at the open (a gap) fills at the open.
 * - Limit orders fill at their price, or at the open when it is better. Market and stop
 *   orders fill `slippage` ticks worse than the trigger price.
 * - Commission is charged on every fill: on entries when the trade opens and on exits when
 *   it closes. A reversal is two fills (the close and the new entry).
 * - There are no margin calls; quantities are not rounded.
 *
 * Order groups. Entries and plain orders can share an `oca_name`. When one of them fills, its
 * `oca_type` decides what happens to the other pending orders of the group: `cancel` removes
 * them, `reduce` lowers their quantity by the filled quantity (removing those that reach 0),
 * `none` leaves them alone. This happens at the fill, so a cancelled order cannot fill later
 * in the same bar.
 *
 * Risk rules (strategy.risk.*), set by the script and applied from the next fill on:
 * - allow_entry_in: an entry in a direction that is not allowed only closes an opposite
 *   position, and does nothing when there is none. Plain orders only reduce.
 * - max_position_size: an entry or order that would make the position larger is cut down to
 *   the room left, and does nothing when there is none.
 * - max_drawdown and max_intraday_loss are checked on bar-close equity; max_intraday_filled_orders
 *   after every fill; max_cons_loss_days when a new UTC day starts. A rule that triggers cancels
 *   every pending order and exit, closes the position with a market order at the next fill
 *   opportunity and ignores new orders: for the rest of the run (max_drawdown,
 *   max_cons_loss_days) or for the rest of the UTC day (the intraday rules).
 */

export type Side = 1 | -1;
export type QtyType = 'fixed' | 'cash' | 'percent_of_equity';
export type CommissionType = 'percent' | 'cash_per_contract' | 'cash_per_order';

export interface StrategyConfig {
  initialCapital: number;
  defaultQtyType: QtyType;
  defaultQtyValue: number;
  commissionType: CommissionType;
  commissionValue: number;
  /** In ticks (multiples of the symbol's minimum price step). */
  slippage: number;
  /** Most entries allowed in one direction; 0 means one. */
  pyramiding: number;
  processOrdersOnClose: boolean;
}

export const DEFAULT_STRATEGY: Readonly<StrategyConfig> = {
  initialCapital: 100_000,
  defaultQtyType: 'fixed',
  defaultQtyValue: 1,
  commissionType: 'percent',
  commissionValue: 0,
  slippage: 0,
  pyramiding: 0,
  processOrdersOnClose: false,
};

/** One order fill, for chart markers. A reversal produces an exit fill and an entry fill. */
export interface Fill {
  bar: number;
  time: number;
  /** 1 buy, -1 sell. */
  side: Side;
  price: number;
  qty: number;
  kind: 'entry' | 'exit';
  label: string;
}

export interface TradeBase {
  entryId: string;
  /** The entry's comment, or its id. */
  entrySignal: string;
  direction: 'long' | 'short';
  qty: number;
  entryBar: number;
  entryTime: number;
  entryPrice: number;
  /** Largest favorable move while open, in money (0 or more). */
  runUp: number;
  /** Largest adverse move while open, in money (0 or more). */
  drawdown: number;
}

export interface ClosedTrade extends TradeBase {
  exitId: string;
  exitSignal: string;
  exitBar: number;
  exitTime: number;
  exitPrice: number;
  /** Net of commission. */
  pnl: number;
  /** pnl relative to the entry value (entry price times quantity). */
  pnlPercent: number;
  commission: number;
}

export interface OpenTradeReport extends TradeBase {
  /** Unrealized profit at the last close, net of the entry commission. */
  pnl: number;
  pnlPercent: number;
  commission: number;
}

export interface StrategySummary {
  initialCapital: number;
  /** Equity at the last close: initial capital plus net profit plus open profit. */
  finalEquity: number;
  netProfit: number;
  netProfitPercent: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number | null;
  totalClosedTrades: number;
  winningTrades: number;
  losingTrades: number;
  evenTrades: number;
  percentProfitable: number | null;
  avgTrade: number | null;
  avgTradePercent: number | null;
  avgWin: number | null;
  /** Negative. */
  avgLoss: number | null;
  ratioAvgWinLoss: number | null;
  largestWin: number | null;
  /** Negative. */
  largestLoss: number | null;
  /** Peak to trough on bar-close equity. */
  maxDrawdown: number;
  maxDrawdownPercent: number;
  /** Holding the symbol from the first close to the last close with the initial capital. */
  buyAndHold: number;
  buyAndHoldPercent: number;
  /** Annualized, from daily equity returns, risk-free rate 0. Null with too little data. */
  sharpe: number | null;
  openProfit: number;
  openTrades: number;
  commissionPaid: number;
  positionSize: number;
}

export type OcaType = 'none' | 'cancel' | 'reduce';
export type RiskDirection = 'all' | 'long' | 'short';
export type RiskAmountType = 'percent_of_equity' | 'cash';
export type RiskRule = 'max_drawdown' | 'max_intraday_loss' | 'max_intraday_filled_orders' | 'max_cons_loss_days';

/** strategy.risk.* settings; null means the rule is not used. */
export interface RiskSettings {
  allowEntryIn: RiskDirection | null;
  maxPositionSize: number | null;
  maxDrawdown: { value: number; type: RiskAmountType } | null;
  maxIntradayLoss: { value: number; type: RiskAmountType } | null;
  maxIntradayFilledOrders: number | null;
  maxConsLossDays: number | null;
}

/** A risk rule that triggered. */
export interface RiskEvent {
  rule: RiskRule;
  bar: number;
  time: number;
  /** True when trading stopped for the rest of the run, false for a halt until the next UTC day. */
  final: boolean;
  /** What was measured, in words. */
  detail: string;
}

export const RISK_RULE_LABELS: Readonly<Record<RiskRule, string>> = {
  max_drawdown: 'Max drawdown',
  max_intraday_loss: 'Max intraday loss',
  max_intraday_filled_orders: 'Max intraday filled orders',
  max_cons_loss_days: 'Max losing days',
};

export const noRisk = (): RiskSettings => ({
  allowEntryIn: null,
  maxPositionSize: null,
  maxDrawdown: null,
  maxIntradayLoss: null,
  maxIntradayFilledOrders: null,
  maxConsLossDays: null,
});

export interface StrategyReport {
  config: StrategyConfig;
  /** strategy.risk.* settings the script set. */
  risk: RiskSettings;
  /** Every time a risk rule triggered, oldest first. */
  riskEvents: RiskEvent[];
  /** The rule that stopped trading for good, or null. */
  stoppedBy: RiskEvent | null;
  summary: StrategySummary;
  trades: ClosedTrade[];
  openTrades: OpenTradeReport[];
  fills: Fill[];
  /** Equity at the close of each bar. */
  equity: number[];
  /** Bar times, aligned with equity. */
  times: number[];
  /** Bar closes, aligned with equity, for the buy and hold line. */
  closes: number[];
}

interface Trade extends TradeBase {
  uid: number;
  dir: Side;
  /** Entry commission still attributed to the open quantity. */
  commission: number;
  high: number;
  low: number;
}

interface PriceOrder {
  kind: 'entry' | 'order';
  id: string;
  side: Side;
  /** NaN means the default quantity. */
  qty: number;
  limit: number;
  /** Cleared once a stop-limit order's stop has triggered. */
  stop: number;
  comment: string | null;
  seq: number;
  ocaName: string | null;
  ocaType: OcaType;
}

interface CloseOrder {
  kind: 'close';
  /** null closes the whole position. */
  id: string | null;
  qty: number;
  qtyPercent: number;
  comment: string | null;
  seq: number;
  /** Set on the order a risk rule places to flatten the position; such fills are not counted. */
  risk?: RiskRule;
}

export interface ExitParams {
  fromEntry: string;
  qty: number;
  qtyPercent: number;
  /** Ticks from the entry price. */
  profit: number;
  limit: number;
  loss: number;
  stop: number;
  trailPrice: number;
  trailPoints: number;
  trailOffset: number;
  comment: string | null;
  commentProfit: string | null;
  commentLoss: string | null;
  commentTrailing: string | null;
}

interface ExitOrder extends ExitParams {
  id: string;
  seq: number;
  /** Trades this exit already closed (part of); it does not fire for them again. */
  done: Set<number>;
  /** Trailing stop state per trade: the best price since activation. */
  trail: Map<number, number>;
}

type Hit = { dist: number; price: number; seq: number; run: () => void };

const EPS = 1e-9;
const isSet = (v: number) => v === v;

/** Price path inside a bar: open, nearer extreme, other extreme, close. */
export function barPath(o: number, h: number, l: number, c: number): number[] {
  return h - o <= o - l ? [o, h, l, c] : [o, l, h, c];
}

export class Broker {
  config: StrategyConfig;
  mintick = 0.01;
  private trades: Trade[] = [];
  private closed: ClosedTrade[] = [];
  private fills: Fill[] = [];
  private orders: Array<PriceOrder | CloseOrder> = [];
  private exits: ExitOrder[] = [];
  private equityCurve: number[] = [];
  private seq = 0;
  private uid = 0;
  private bar = -1;
  private time = 0;
  /** Close of the current bar; open profit is marked at this price. */
  private mark = NaN;
  netProfit = 0;
  grossProfit = 0;
  grossLoss = 0;
  private commissionPaid = 0;
  private maxDd = 0;
  private peak = 0;
  private risk: RiskSettings = noRisk();
  private riskEvents: RiskEvent[] = [];
  /** The rule that stopped trading for the rest of the run. */
  private stopped: RiskEvent | null = null;
  /** UTC day number of the current bar. */
  private day = NaN;
  /** UTC day on which an intraday rule halted trading. */
  private haltDay = NaN;
  /** Equity at the last close of the previous UTC day. */
  private dayStartEquity = 0;
  /** Orders filled on the current UTC day, not counting risk closes. */
  private dayFills = 0;
  /** Losing UTC days in a row. */
  private lossDays = 0;
  /** Equity at the last bar close. */
  private lastEquity = 0;

  constructor(config: Partial<StrategyConfig> = {}) {
    this.config = { ...DEFAULT_STRATEGY, ...config };
    this.reset();
  }

  reset(mintick = this.mintick): void {
    this.mintick = mintick > 0 ? mintick : 0.01;
    this.trades = [];
    this.closed = [];
    this.fills = [];
    this.orders = [];
    this.exits = [];
    this.equityCurve = [];
    this.seq = 0;
    this.uid = 0;
    this.bar = -1;
    this.time = 0;
    this.mark = NaN;
    this.netProfit = 0;
    this.grossProfit = 0;
    this.grossLoss = 0;
    this.commissionPaid = 0;
    this.maxDd = 0;
    this.peak = this.config.initialCapital;
    this.risk = noRisk();
    this.riskEvents = [];
    this.stopped = null;
    this.day = NaN;
    this.haltDay = NaN;
    this.dayStartEquity = this.config.initialCapital;
    this.dayFills = 0;
    this.lossDays = 0;
    this.lastEquity = this.config.initialCapital;
  }

  // ------------------------------------------------------------------ risk rules

  /** Changes strategy.risk.* settings; the script calls these on every bar, the latest call wins. */
  setRisk(patch: Partial<RiskSettings>): void {
    Object.assign(this.risk, patch);
  }

  /** New orders are ignored: trading stopped, or an intraday rule halted the current UTC day. */
  get blocked(): boolean {
    return this.stopped !== null || this.haltDay === this.day;
  }

  private allows(side: Side): boolean {
    const a = this.risk.allowEntryIn;
    return a === null || a === 'all' || a === (side > 0 ? 'long' : 'short');
  }

  /** `qty` cut down so the position in direction `side` stays within max_position_size. */
  private capQty(qty: number, side: Side): number {
    const max = this.risk.maxPositionSize;
    if (max === null || !(qty > 0)) return qty;
    return Math.min(qty, Math.max(0, max - Math.max(0, this.positionSize * side)));
  }

  /** Cancels pending orders and exits, flattens at the next fill opportunity and blocks new orders. */
  private halt(rule: RiskRule, final: boolean, detail: string): void {
    const event: RiskEvent = { rule, bar: this.bar, time: this.time, final, detail };
    this.riskEvents.push(event);
    if (final) this.stopped = event;
    else this.haltDay = this.day;
    this.orders = [];
    this.exits = [];
    if (this.trades.length > 0) {
      this.orders.push({ kind: 'close', id: null, qty: NaN, qtyPercent: NaN, comment: null, seq: this.seq++, risk: rule });
    }
  }

  /** Called once per order that fills; enforces max_intraday_filled_orders. */
  private countFill(): void {
    this.dayFills++;
    const max = this.risk.maxIntradayFilledOrders;
    if (max !== null && this.dayFills >= max && !this.blocked) {
      this.halt('max_intraday_filled_orders', false, `${this.dayFills} orders filled on this UTC day, the limit is ${max}`);
    }
  }

  /** A new UTC day starts: score the day that ended and reset the intraday counters. */
  private newDay(day: number): void {
    if (this.day === this.day) {
      const result = this.lastEquity - this.dayStartEquity;
      if (result < -EPS) this.lossDays++;
      else if (result > EPS) this.lossDays = 0;
      this.dayStartEquity = this.lastEquity;
    }
    this.day = day;
    this.dayFills = 0;
    const max = this.risk.maxConsLossDays;
    if (max !== null && this.lossDays >= max && !this.stopped) {
      this.halt('max_cons_loss_days', true, `${this.lossDays} losing days in a row, the limit is ${max}`);
    }
  }

  /** Checks the rules measured on bar-close equity; true when one of them triggered. */
  private checkClose(eq: number): boolean {
    if (this.stopped) return false;
    const dd = this.risk.maxDrawdown;
    if (dd) {
      const peak = Math.max(this.peak, eq);
      const loss = peak - eq;
      const pct = peak > 0 ? (loss / peak) * 100 : 0;
      if (dd.type === 'cash' ? loss >= dd.value - EPS : pct >= dd.value - EPS) {
        const limit = dd.type === 'cash' ? `${dd.value}` : `${dd.value}% of equity`;
        this.halt('max_drawdown', true, `Drawdown of ${loss.toFixed(2)} (${pct.toFixed(2)}%) from the peak of ${peak.toFixed(2)} reached the limit of ${limit}`);
        return true;
      }
    }
    const il = this.risk.maxIntradayLoss;
    if (il && this.haltDay !== this.day) {
      const start = this.dayStartEquity;
      const loss = start - eq;
      const pct = start > 0 ? (loss / start) * 100 : 0;
      if (il.type === 'cash' ? loss >= il.value - EPS : pct >= il.value - EPS) {
        const limit = il.type === 'cash' ? `${il.value}` : `${il.value}% of equity`;
        this.halt('max_intraday_loss', false, `Loss of ${loss.toFixed(2)} (${pct.toFixed(2)}%) since the start of the UTC day reached the limit of ${limit}`);
        return true;
      }
    }
    return false;
  }

  // ------------------------------------------------------------------ state the script can read

  get positionSize(): number {
    let s = 0;
    for (const t of this.trades) s += t.dir * t.qty;
    return Math.abs(s) < EPS ? 0 : s;
  }

  get positionAvgPrice(): number {
    let q = 0;
    let v = 0;
    for (const t of this.trades) {
      q += t.qty;
      v += t.qty * t.entryPrice;
    }
    return q > 0 ? v / q : NaN;
  }

  openProfitAt(price: number): number {
    let p = 0;
    for (const t of this.trades) p += (price - t.entryPrice) * t.qty * t.dir - t.commission;
    return p;
  }

  get openProfit(): number {
    return this.mark === this.mark ? this.openProfitAt(this.mark) : 0;
  }

  get equity(): number {
    return this.config.initialCapital + this.netProfit + this.openProfit;
  }

  get openCount(): number {
    return this.trades.length;
  }

  get closedCount(): number {
    return this.closed.length;
  }

  get winCount(): number {
    return this.closed.filter((t) => t.pnl > 0).length;
  }

  get lossCount(): number {
    return this.closed.filter((t) => t.pnl < 0).length;
  }

  get evenCount(): number {
    return this.closed.filter((t) => t.pnl === 0).length;
  }

  get maxDrawdown(): number {
    return this.maxDd;
  }

  closedTrade(n: number): ClosedTrade | undefined {
    return this.closed[n];
  }

  openTrade(n: number): (Trade & { pnl: number }) | undefined {
    const t = this.trades[n];
    return t ? { ...t, pnl: (this.mark - t.entryPrice) * t.qty * t.dir - t.commission } : undefined;
  }

  // ------------------------------------------------------------------ orders placed by the script

  /** strategy.entry: opens a position, reversing an opposite one; limited by pyramiding. */
  entry(id: string, side: Side, qty: number, limit: number, stop: number, comment: string | null, ocaName: string | null = null, ocaType: OcaType = 'none'): void {
    this.placePriceOrder('entry', id, side, qty, limit, stop, comment, ocaName, ocaType);
  }

  /** strategy.order: a plain buy or sell that reduces an opposite position before opening one. */
  order(id: string, side: Side, qty: number, limit: number, stop: number, comment: string | null, ocaName: string | null = null, ocaType: OcaType = 'none'): void {
    this.placePriceOrder('order', id, side, qty, limit, stop, comment, ocaName, ocaType);
  }

  private placePriceOrder(
    kind: PriceOrder['kind'],
    id: string,
    side: Side,
    qty: number,
    limit: number,
    stop: number,
    comment: string | null,
    ocaName: string | null,
    ocaType: OcaType,
  ): void {
    if (isSet(qty) && !(qty > 0)) return;
    if (this.blocked) return;
    const order: PriceOrder = { kind, id, side, qty, limit, stop, comment, seq: this.seq++, ocaName: ocaName || null, ocaType };
    // Placing an order with the id of a pending one replaces it.
    const i = this.orders.findIndex((o) => o.kind === kind && o.id === id);
    if (i >= 0) this.orders[i] = order;
    else this.orders.push(order);
  }

  /** strategy.exit: a take-profit, stop-loss and/or trailing stop bracket for open entries. */
  exit(id: string, params: ExitParams): void {
    const hasLevel = [params.profit, params.limit, params.loss, params.stop, params.trailPrice, params.trailPoints].some(isSet);
    if (!hasLevel || this.blocked) return;
    const existing = this.exits.find((e) => e.id === id);
    if (existing) Object.assign(existing, params);
    else this.exits.push({ ...params, id, seq: this.seq++, done: new Set(), trail: new Map() });
  }

  /** strategy.close and strategy.close_all (id null): a market order that exits matching trades. */
  close(id: string | null, comment: string | null, qty: number, qtyPercent: number, immediately: boolean): void {
    if (!this.trades.some((t) => id === null || t.entryId === id)) return;
    const order: CloseOrder = { kind: 'close', id, qty, qtyPercent, comment, seq: this.seq++ };
    if (immediately && this.mark === this.mark) {
      this.fillClose(order, this.mark);
      return;
    }
    const i = this.orders.findIndex((o) => o.kind === 'close' && o.id === id);
    if (i >= 0) this.orders[i] = order;
    else this.orders.push(order);
  }

  /** strategy.cancel: drops pending entries, orders and exits with this id. */
  cancel(id: string): void {
    this.orders = this.orders.filter((o) => o.kind === 'close' || o.id !== id);
    this.exits = this.exits.filter((e) => e.id !== id);
  }

  cancelAll(): void {
    this.orders = this.orders.filter((o) => o.kind === 'close');
    this.exits = [];
  }

  // ------------------------------------------------------------------ bar processing

  /** Fills pending orders against bar `i`. Called before the script runs on that bar. */
  beginBar(i: number, time: number, o: number, h: number, l: number, c: number): void {
    this.bar = i;
    this.time = time;
    this.mark = c;
    const day = Math.floor(time / DAY_MS);
    if (day !== this.day) this.newDay(day);
    if (!(o === o && h === h && l === l && c === c)) return;
    // Market orders first, in the order they were placed.
    this.fillMarketOrders(o);
    const path = barPath(o, h, l, c);
    let guard = 0;
    for (let k = 0; k + 1 < path.length; k++) {
      let cur = path[k];
      const to = path[k + 1];
      for (;;) {
        if (++guard > 10_000) break;
        const hit = this.nextHit(cur, to);
        if (!hit) break;
        cur = hit.price;
        hit.run();
        this.pruneExits();
      }
      this.touch(to);
    }
  }

  /** Fills market orders on the close when asked to, then records equity for bar `i`. */
  endBar(i: number, c: number): void {
    const onClose = this.config.processOrdersOnClose && c === c;
    const events = this.riskEvents.length;
    if (onClose) this.fillMarketOrders(c);
    let eq = this.equity;
    const triggered = c === c && this.checkClose(eq);
    // With fills on the close, a rule that triggered on this bar flattens at this close.
    if (onClose && (triggered || this.riskEvents.length > events)) {
      this.fillMarketOrders(c);
      eq = this.equity;
    }
    this.equityCurve[i] = eq;
    this.lastEquity = eq;
    if (eq > this.peak) this.peak = eq;
    if (this.peak - eq > this.maxDd) this.maxDd = this.peak - eq;
  }

  /** Fills pending market orders at `price`, in the order they were placed. */
  private fillMarketOrders(price: number): void {
    for (const order of this.orders.filter(isMarket)) {
      if (!this.orders.includes(order)) continue;
      this.fillMarket(order, price);
    }
    this.pruneExits();
  }

  /** Updates the price extremes of open trades and trailing stops at a point of the bar path. */
  private touch(price: number): void {
    for (const t of this.trades) {
      if (price > t.high) t.high = price;
      if (price < t.low) t.low = price;
    }
    for (const e of this.exits) {
      for (const [uid, best] of e.trail) {
        const t = this.trades.find((x) => x.uid === uid);
        if (!t) continue;
        e.trail.set(uid, t.dir > 0 ? Math.max(best, price) : Math.min(best, price));
      }
    }
  }

  /** The first order the path from `cur` to `to` reaches, or null. */
  private nextHit(cur: number, to: number): Hit | null {
    let best: Hit | null = null;
    const consider = (dist: number, price: number, seq: number, run: () => void) => {
      if (!best || dist < best.dist - EPS || (Math.abs(dist - best.dist) <= EPS && seq < best.seq)) best = { dist, price, seq, run };
    };
    const slip = this.config.slippage * this.mintick;

    for (const o of this.orders) {
      if (o.kind === 'close' || (!isSet(o.limit) && !isSet(o.stop))) continue;
      if (isSet(o.stop)) {
        const hit = o.side > 0 ? reachUp(cur, to, o.stop) : reachDown(cur, to, o.stop);
        if (hit) {
          consider(hit.dist, hit.price, o.seq, () => {
            if (isSet(o.limit)) o.stop = NaN; // a stop-limit becomes a limit order
            else this.fillPrice(o, hit.price + o.side * slip);
          });
        }
        continue;
      }
      const hit = o.side > 0 ? reachDown(cur, to, o.limit) : reachUp(cur, to, o.limit);
      if (hit) consider(hit.dist, hit.price, o.seq, () => this.fillPrice(o, hit.price));
    }

    for (const e of this.exits) {
      for (const t of this.trades) {
        if (e.done.has(t.uid) || !covers(e.fromEntry, t.entryId)) continue;
        const d = t.dir;
        const tick = this.mintick;
        // Take profit: the nearer of `limit` and `profit` ticks.
        let tp = NaN;
        if (isSet(e.limit)) tp = e.limit;
        if (isSet(e.profit)) {
          const p = t.entryPrice + d * e.profit * tick;
          tp = isSet(tp) ? (d > 0 ? Math.min(tp, p) : Math.max(tp, p)) : p;
        }
        if (isSet(tp)) {
          const hit = d > 0 ? reachUp(cur, to, tp) : reachDown(cur, to, tp);
          if (hit) consider(hit.dist, hit.price, e.seq, () => this.fillExit(e, t, hit.price, e.commentProfit));
        }
        // Stop loss: the nearer of `stop` and `loss` ticks.
        let sl = NaN;
        if (isSet(e.stop)) sl = e.stop;
        if (isSet(e.loss)) {
          const p = t.entryPrice - d * e.loss * tick;
          sl = isSet(sl) ? (d > 0 ? Math.max(sl, p) : Math.min(sl, p)) : p;
        }
        if (isSet(sl)) {
          const hit = d > 0 ? reachDown(cur, to, sl) : reachUp(cur, to, sl);
          if (hit) consider(hit.dist, hit.price, e.seq, () => this.fillExit(e, t, hit.price - d * slip, e.commentLoss));
        }
        // Trailing stop: arms at the activation level, then follows the best price by `trail_offset` ticks.
        const activation = isSet(e.trailPrice) ? e.trailPrice : isSet(e.trailPoints) ? t.entryPrice + d * e.trailPoints * tick : NaN;
        if (isSet(activation)) {
          const best = e.trail.get(t.uid);
          if (best === undefined) {
            const hit = d > 0 ? reachUp(cur, to, activation) : reachDown(cur, to, activation);
            if (hit) consider(hit.dist, hit.price, e.seq, () => e.trail.set(t.uid, d > 0 ? Math.max(activation, hit.price) : Math.min(activation, hit.price)));
          } else {
            const level = best - d * (isSet(e.trailOffset) ? e.trailOffset : 0) * tick;
            const hit = d > 0 ? reachDown(cur, to, level) : reachUp(cur, to, level);
            if (hit) consider(hit.dist, hit.price, e.seq, () => this.fillExit(e, t, hit.price - d * slip, e.commentTrailing));
          }
        }
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ fills

  private fillMarket(order: PriceOrder | CloseOrder, price: number): void {
    if (order.kind === 'close') this.fillClose(order, price);
    else this.fillPrice(order, price + order.side * this.config.slippage * this.mintick);
  }

  /** Closes the trades a close order matches; slippage is applied here. */
  private fillClose(order: CloseOrder, rawPrice: number): void {
    this.remove(order);
    const matching = this.trades.filter((t) => order.id === null || t.entryId === order.id);
    if (matching.length === 0) return;
    const total = matching.reduce((s, t) => s + t.qty, 0);
    let want = total;
    if (isSet(order.qtyPercent)) want = (total * Math.min(100, Math.max(0, order.qtyPercent))) / 100;
    else if (isSet(order.qty)) want = Math.min(total, Math.max(0, order.qty));
    if (want <= EPS) return;
    const exitId = order.risk ? RISK_RULE_LABELS[order.risk] : order.id === null ? 'Close all' : 'Close';
    const parts: Array<[Trade, number]> = [];
    for (const t of matching) {
      if (want <= EPS) break;
      const q = Math.min(t.qty, want);
      parts.push([t, q]);
      want -= q;
    }
    const price = rawPrice - parts[0][0].dir * this.config.slippage * this.mintick;
    this.closeParts(parts, price, exitId, order.comment ?? exitId);
    if (!order.risk) this.countFill();
  }

  private fillExit(e: ExitOrder, t: Trade, price: number, legComment: string | null): void {
    e.done.add(t.uid);
    e.trail.delete(t.uid);
    let q = t.qty;
    if (isSet(e.qtyPercent)) q = (t.qty * Math.min(100, Math.max(0, e.qtyPercent))) / 100;
    else if (isSet(e.qty)) q = Math.min(t.qty, Math.max(0, e.qty));
    if (q <= EPS) return;
    this.closeParts([[t, q]], price, e.id, legComment ?? e.comment ?? e.id);
    this.countFill();
  }

  /** Fills an entry or a plain order at `price` (slippage already applied). */
  private fillPrice(order: PriceOrder, price: number): void {
    this.remove(order);
    const side = order.side;
    const allowed = this.allows(side);
    let traded = 0;
    if (order.kind === 'entry') {
      const pos = this.positionSize;
      if (pos * side < 0) {
        // Reversal: close everything, then open the new position (unless that direction is not allowed).
        const parts = this.trades.map((t): [Trade, number] => [t, t.qty]);
        traded += parts.reduce((sum, [, q]) => sum + q, 0);
        this.closeParts(parts, price, order.id, order.comment ?? order.id);
      } else if (pos * side > 0 && this.trades.length >= Math.max(1, this.config.pyramiding)) {
        return;
      }
      if (allowed) {
        const qty = this.capQty(this.orderQty(order, price), side);
        if (qty > EPS) {
          this.open(order, qty, price);
          traded += qty;
        }
      }
      this.afterFill(order, traded, price);
      return;
    }
    let remaining = this.orderQty(order, price);
    if (!(remaining > EPS)) return;
    const parts: Array<[Trade, number]> = [];
    for (const t of this.trades) {
      if (t.dir === side || remaining <= EPS) continue;
      const q = Math.min(t.qty, remaining);
      parts.push([t, q]);
      remaining -= q;
      traded += q;
    }
    if (parts.length) this.closeParts(parts, price, order.id, order.comment ?? order.id);
    // What is left would open a position: only in an allowed direction and within the size limit.
    const opening = allowed ? this.capQty(remaining, side) : 0;
    if (opening > EPS) {
      this.open(order, opening, price);
      traded += opening;
    }
    this.afterFill(order, traded, price);
  }

  /** Applies the filled order's group (OCA) to the other pending orders, then counts the fill. */
  private afterFill(order: PriceOrder, traded: number, price: number): void {
    if (!(traded > EPS)) return;
    if (order.ocaName !== null && order.ocaType !== 'none') {
      for (const o of this.orders.slice()) {
        if (o.kind === 'close' || o.ocaName !== order.ocaName) continue;
        if (order.ocaType === 'cancel') {
          this.remove(o);
          continue;
        }
        // An order without qty is first given its default size at this fill's price.
        const left = (isSet(o.qty) ? o.qty : this.orderQty(o, price)) - traded;
        if (left > EPS) o.qty = left;
        else this.remove(o);
      }
    }
    this.countFill();
  }

  private orderQty(order: PriceOrder, price: number): number {
    if (isSet(order.qty)) return order.qty;
    const { defaultQtyType: type, defaultQtyValue: value } = this.config;
    if (type === 'fixed') return value;
    if (!(price > 0)) return NaN;
    if (type === 'cash') return value / price;
    const equity = this.config.initialCapital + this.netProfit + this.openProfitAt(price);
    return (equity * value) / 100 / price;
  }

  private commission(qty: number, price: number): number {
    const v = this.config.commissionValue;
    if (!(v > 0)) return 0;
    switch (this.config.commissionType) {
      case 'percent':
        return (qty * price * v) / 100;
      case 'cash_per_contract':
        return qty * v;
      case 'cash_per_order':
        return v;
    }
  }

  private open(order: PriceOrder, qty: number, price: number): void {
    const commission = this.commission(qty, price);
    this.commissionPaid += commission;
    const signal = order.comment ?? order.id;
    this.trades.push({
      uid: this.uid++,
      entryId: order.id,
      entrySignal: signal,
      direction: order.side > 0 ? 'long' : 'short',
      dir: order.side,
      qty,
      entryBar: this.bar,
      entryTime: this.time,
      entryPrice: price,
      commission,
      high: price,
      low: price,
      runUp: 0,
      drawdown: 0,
    });
    this.fills.push({ bar: this.bar, time: this.time, side: order.side, price, qty, kind: 'entry', label: signal });
  }

  /** Closes `qty` of each listed trade at `price` as one order fill. */
  private closeParts(parts: Array<[Trade, number]>, price: number, exitId: string, signal: string): void {
    if (parts.length === 0) return;
    const totalQty = parts.reduce((s, [, q]) => s + q, 0);
    const perOrder = this.config.commissionType === 'cash_per_order';
    const orderCommission = perOrder ? this.commission(totalQty, price) : 0;
    for (const [t, q] of parts) {
      t.high = Math.max(t.high, price);
      t.low = Math.min(t.low, price);
      const frac = Math.min(1, q / t.qty);
      const entryCommission = t.commission * frac;
      const exitCommission = perOrder ? (orderCommission * q) / totalQty : this.commission(q, price);
      this.commissionPaid += exitCommission;
      const pnl = (price - t.entryPrice) * q * t.dir - entryCommission - exitCommission;
      const runUp = Math.max(0, (t.dir > 0 ? t.high - t.entryPrice : t.entryPrice - t.low) * q);
      const drawdown = Math.max(0, (t.dir > 0 ? t.entryPrice - t.low : t.high - t.entryPrice) * q);
      this.closed.push({
        entryId: t.entryId,
        entrySignal: t.entrySignal,
        direction: t.direction,
        qty: q,
        entryBar: t.entryBar,
        entryTime: t.entryTime,
        entryPrice: t.entryPrice,
        exitId,
        exitSignal: signal,
        exitBar: this.bar,
        exitTime: this.time,
        exitPrice: price,
        pnl,
        pnlPercent: t.entryPrice > 0 ? (pnl / (t.entryPrice * q)) * 100 : 0,
        commission: entryCommission + exitCommission,
        runUp,
        drawdown,
      });
      this.netProfit += pnl;
      if (pnl > 0) this.grossProfit += pnl;
      else this.grossLoss -= pnl;
      t.qty -= q;
      t.commission -= entryCommission;
    }
    this.trades = this.trades.filter((t) => t.qty > EPS);
    const dir = parts[0][0].dir;
    this.fills.push({ bar: this.bar, time: this.time, side: dir > 0 ? -1 : 1, price, qty: totalQty, kind: 'exit', label: signal });
  }

  private remove(order: PriceOrder | CloseOrder): void {
    const i = this.orders.indexOf(order);
    if (i >= 0) this.orders.splice(i, 1);
  }

  /** Drops exits that cover no open trade and no pending entry. */
  private pruneExits(): void {
    if (this.exits.length === 0) return;
    this.exits = this.exits.filter((e) => {
      if (this.trades.some((t) => covers(e.fromEntry, t.entryId))) return true;
      return this.orders.some((o) => o.kind !== 'close' && covers(e.fromEntry, o.id));
    });
  }

  // ------------------------------------------------------------------ report

  report(times: readonly number[], closes: readonly number[], periodSeconds: number): StrategyReport {
    const n = this.equityCurve.length;
    const equity = this.equityCurve.slice();
    const lastClose = this.mark;
    const openTrades: OpenTradeReport[] = this.trades.map((t) => {
      const pnl = lastClose === lastClose ? (lastClose - t.entryPrice) * t.qty * t.dir - t.commission : 0;
      return {
        entryId: t.entryId,
        entrySignal: t.entrySignal,
        direction: t.direction,
        qty: t.qty,
        entryBar: t.entryBar,
        entryTime: t.entryTime,
        entryPrice: t.entryPrice,
        runUp: Math.max(0, (t.dir > 0 ? t.high - t.entryPrice : t.entryPrice - t.low) * t.qty),
        drawdown: Math.max(0, (t.dir > 0 ? t.entryPrice - t.low : t.high - t.entryPrice) * t.qty),
        pnl,
        pnlPercent: t.entryPrice > 0 ? (pnl / (t.entryPrice * t.qty)) * 100 : 0,
        commission: t.commission,
      };
    });
    const summary = summarize({
      config: this.config,
      trades: this.closed,
      equity,
      times: times.slice(0, n),
      closes: closes.slice(0, n),
      periodSeconds,
      openProfit: this.openProfit,
      openTrades: this.trades.length,
      commissionPaid: this.commissionPaid,
      positionSize: this.positionSize,
    });
    const r = this.risk;
    return {
      config: { ...this.config },
      risk: { ...r, maxDrawdown: r.maxDrawdown && { ...r.maxDrawdown }, maxIntradayLoss: r.maxIntradayLoss && { ...r.maxIntradayLoss } },
      riskEvents: this.riskEvents.map((e) => ({ ...e })),
      stoppedBy: this.stopped && { ...this.stopped },
      summary,
      trades: this.closed.slice(),
      openTrades,
      fills: this.fills.slice(),
      equity,
      times: times.slice(0, n),
      closes: closes.slice(0, n),
    };
  }
}

function isMarket(o: PriceOrder | CloseOrder): boolean {
  return o.kind === 'close' || (!isSet(o.limit) && !isSet(o.stop));
}

function covers(fromEntry: string, entryId: string): boolean {
  return fromEntry === '' || fromEntry === entryId;
}

/** Where a path from `cur` to `to` first has price >= level. */
function reachUp(cur: number, to: number, level: number): { dist: number; price: number } | null {
  if (cur >= level) return { dist: 0, price: cur };
  if (to >= level) return { dist: level - cur, price: level };
  return null;
}

/** Where a path from `cur` to `to` first has price <= level. */
function reachDown(cur: number, to: number, level: number): { dist: number; price: number } | null {
  if (cur <= level) return { dist: 0, price: cur };
  if (to <= level) return { dist: cur - level, price: level };
  return null;
}

// ------------------------------------------------------------------ statistics

export interface SummaryInput {
  config: StrategyConfig;
  trades: readonly ClosedTrade[];
  equity: readonly number[];
  times: readonly number[];
  closes: readonly number[];
  periodSeconds: number;
  openProfit: number;
  openTrades: number;
  commissionPaid: number;
  positionSize: number;
}

const DAY_MS = 86_400_000;

/** Performance figures for a finished run. */
export function summarize(input: SummaryInput): StrategySummary {
  const { config, trades, equity, times, closes } = input;
  const capital = config.initialCapital;
  let grossProfit = 0;
  let grossLoss = 0;
  let wins = 0;
  let losses = 0;
  let largestWin: number | null = null;
  let largestLoss: number | null = null;
  let pctSum = 0;
  for (const t of trades) {
    pctSum += t.pnlPercent;
    if (t.pnl > 0) {
      wins++;
      grossProfit += t.pnl;
      if (largestWin === null || t.pnl > largestWin) largestWin = t.pnl;
    } else if (t.pnl < 0) {
      losses++;
      grossLoss -= t.pnl;
      if (largestLoss === null || t.pnl < largestLoss) largestLoss = t.pnl;
    }
  }
  const total = trades.length;
  const netProfit = grossProfit - grossLoss;
  const avgWin = wins ? grossProfit / wins : null;
  const avgLoss = losses ? -grossLoss / losses : null;

  // Drawdown on bar-close equity, starting from the initial capital.
  let peak = capital;
  let maxDd = 0;
  let maxDdPct = 0;
  for (const e of equity) {
    if (e === undefined || e !== e) continue;
    if (e > peak) peak = e;
    const dd = peak - e;
    if (dd > maxDd) maxDd = dd;
    if (peak > 0 && (dd / peak) * 100 > maxDdPct) maxDdPct = (dd / peak) * 100;
  }

  const first = closes.find((c) => c === c && c > 0);
  const last = closes.length ? closes[closes.length - 1] : undefined;
  const bhPct = first !== undefined && last !== undefined && last === last ? (last / first - 1) * 100 : 0;
  const finalEquity = equity.length ? equity[equity.length - 1] : capital;

  return {
    initialCapital: capital,
    finalEquity,
    netProfit,
    netProfitPercent: capital > 0 ? (netProfit / capital) * 100 : 0,
    grossProfit,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    totalClosedTrades: total,
    winningTrades: wins,
    losingTrades: losses,
    evenTrades: total - wins - losses,
    percentProfitable: total ? (wins / total) * 100 : null,
    avgTrade: total ? netProfit / total : null,
    avgTradePercent: total ? pctSum / total : null,
    avgWin,
    avgLoss,
    ratioAvgWinLoss: avgWin !== null && avgLoss !== null && avgLoss !== 0 ? avgWin / -avgLoss : null,
    largestWin,
    largestLoss,
    maxDrawdown: maxDd,
    maxDrawdownPercent: maxDdPct,
    buyAndHold: (capital * bhPct) / 100,
    buyAndHoldPercent: bhPct,
    sharpe: sharpeRatio(equity, times, capital, input.periodSeconds),
    openProfit: input.openProfit,
    openTrades: input.openTrades,
    commissionPaid: input.commissionPaid,
    positionSize: input.positionSize,
  };
}

/**
 * Sharpe ratio from the equity at the end of each UTC day (each bar on daily and longer
 * timeframes): mean return over its sample standard deviation, times the square root of
 * the number of such periods in a 365-day year. The risk-free rate is 0.
 */
export function sharpeRatio(equity: readonly number[], times: readonly number[], capital: number, periodSeconds: number): number | null {
  const ends: number[] = [];
  let lastKey: number | null = null;
  for (let i = 0; i < equity.length; i++) {
    const e = equity[i];
    if (e === undefined || e !== e) continue;
    const key = periodSeconds >= 86_400 ? i : Math.floor(times[i] / DAY_MS);
    if (key === lastKey) ends[ends.length - 1] = e;
    else ends.push(e);
    lastKey = key;
  }
  const returns: number[] = [];
  let prev = capital;
  for (const e of ends) {
    if (prev > 0) returns.push(e / prev - 1);
    prev = e;
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  const sd = Math.sqrt(variance);
  if (!(sd > 0)) return null;
  const periodsPerYear = (365 * 86_400) / Math.max(86_400, periodSeconds);
  return (mean / sd) * Math.sqrt(periodsPerYear);
}
