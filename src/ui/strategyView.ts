/**
 * Backtest results of strategy scripts, shown in the Strategy tab of the script panel:
 * an overview with the main figures and the equity curve, and the list of trades.
 */
import type { ScriptManager } from '../script/manager';
import { RISK_RULE_LABELS, type ClosedTrade, type OpenTradeReport, type StrategyReport } from '../script/strategy';
import { h } from './dom';
import './strategyView.css';

export interface StrategyViewOptions {
  manager: ScriptManager;
  /** Scrolls the chart to a time, when a trade row is clicked. */
  onShowTime?: (time: number) => void;
}

export interface StrategyView {
  /** Body of the tab. */
  root: HTMLElement;
  /** Controls for the panel header. */
  tools: HTMLElement;
  /** Shows a strategy, or the first one when `id` is not given or unknown. */
  select(id?: string): void;
  /** Call when the tab becomes visible or hidden. */
  setVisible(visible: boolean): void;
  /** Ids of the strategy scripts on the chart. */
  strategies(): string[];
}

type Tab = 'overview' | 'trades';

// ------------------------------------------------------------------ formatting

const fmt = (v: number, digits = 2) => v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const signed = (v: number, digits = 2) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt(Math.abs(v), digits)}`;
const pct = (v: number) => `${signed(v)}%`;
const dash = '–';

export function formatMoney(v: number | null): string {
  return v === null || !Number.isFinite(v) ? dash : signed(v);
}

export function formatPrice(v: number): string {
  if (!Number.isFinite(v)) return dash;
  const a = Math.abs(v);
  return fmt(v, a >= 1000 ? 2 : a >= 1 ? 4 : 6);
}

function formatQty(v: number): string {
  return Number(v.toPrecision(6)).toLocaleString('en-US', { maximumFractionDigits: 6 });
}

function formatTime(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const tone = (v: number | null) => (v === null || v === 0 || !Number.isFinite(v) ? '' : v > 0 ? 'st-up' : 'st-down');

// ------------------------------------------------------------------ view

export function createStrategyView(opts: StrategyViewOptions): StrategyView {
  const { manager } = opts;
  let selected = '';
  let tab: Tab = 'overview';
  let visible = false;
  let pending: ReturnType<typeof setTimeout> | null = null;
  let lastReport: StrategyReport | null = null;

  const picker = h('select', { class: 'sp-select', 'aria-label': 'Strategy', title: 'Strategy to show' }) as HTMLSelectElement;
  const overviewBtn = h('button', { class: 'st-seg active', type: 'button', 'aria-pressed': 'true' }, 'Overview');
  const tradesBtn = h('button', { class: 'st-seg', type: 'button', 'aria-pressed': 'false' }, 'List of trades');
  const tools = h('div', { class: 'st-tools' }, picker, h('div', { class: 'st-segs', role: 'group', 'aria-label': 'Results view' }, overviewBtn, tradesBtn));

  const kpis = h('div', { class: 'st-kpis' });
  const canvas = h('canvas', { class: 'st-canvas', 'aria-label': 'Equity curve' }) as HTMLCanvasElement;
  const readout = h('div', { class: 'st-readout' });
  const legend = h(
    'div',
    { class: 'st-legend' },
    h('span', { class: 'st-key st-key-equity' }, 'Equity'),
    h('span', { class: 'st-key st-key-hold' }, 'Buy & hold'),
    readout,
  );
  const chartBox = h('div', { class: 'st-chart' }, legend, canvas);
  const stats = h('table', { class: 'st-stats' });
  const note = h('div', { class: 'st-note', role: 'status', hidden: true });
  const overview = h('div', { class: 'st-overview' }, kpis, note, h('div', { class: 'st-main' }, chartBox, h('div', { class: 'st-aside' }, stats)));
  const tradesBody = h('tbody');
  const tradesTable = h(
    'table',
    { class: 'st-trades' },
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        ...['#', 'Type', 'Signal', 'Entry time', 'Entry price', 'Exit time', 'Exit price', 'Qty', 'Profit', 'Profit %', 'Cum. profit', 'Run-up', 'Drawdown'].map((t, i) =>
          h('th', { class: i >= 4 && t !== 'Exit time' ? 'num' : '' }, t),
        ),
      ),
    ),
    tradesBody,
  );
  const trades = h('div', { class: 'st-trades-wrap', hidden: true }, tradesTable);
  const empty = h(
    'div',
    { class: 'st-empty muted' },
    'No strategy on the chart yet. Pick one of the strategy examples in the Editor tab and press Ctrl+Enter (Cmd+Enter on a Mac), or write a script that calls strategy().',
  );
  const root = h('div', { class: 'st-view' }, empty, overview, trades);

  // ------------------------------------------------------------------ data

  const strategies = () => manager.list().filter((s) => s.strategy);

  const refreshPicker = () => {
    const list = strategies();
    if (!list.some((s) => s.id === selected)) selected = list.length ? list[list.length - 1].id : '';
    picker.replaceChildren(...list.map((s) => h('option', { value: s.id, selected: s.id === selected }, s.shortTitle)));
    picker.hidden = list.length === 0;
  };

  const setTab = (next: Tab) => {
    tab = next;
    overviewBtn.classList.toggle('active', tab === 'overview');
    tradesBtn.classList.toggle('active', tab === 'trades');
    overviewBtn.setAttribute('aria-pressed', String(tab === 'overview'));
    tradesBtn.setAttribute('aria-pressed', String(tab === 'trades'));
    render();
  };

  function render(): void {
    pending = null;
    const report = selected ? manager.report(selected) : null;
    lastReport = report;
    empty.hidden = report !== null;
    overview.hidden = report === null || tab !== 'overview';
    trades.hidden = report === null || tab !== 'trades';
    if (!report || !visible) return;
    if (tab === 'overview') {
      renderKpis(kpis, report);
      renderStopNote(note, report);
      renderStats(stats, report);
      drawEquity(canvas, report, null);
      readout.textContent = '';
    } else {
      renderTrades(tradesBody, report);
    }
  }

  const schedule = () => {
    if (!visible || pending) return;
    pending = setTimeout(render, 200);
  };

  // ------------------------------------------------------------------ events

  picker.addEventListener('change', () => {
    selected = picker.value;
    render();
  });
  overviewBtn.addEventListener('click', () => setTab('overview'));
  tradesBtn.addEventListener('click', () => setTab('trades'));
  manager.onChange(() => {
    refreshPicker();
    schedule();
  });
  manager.onStrategyRun((id) => {
    if (id === selected) schedule();
  });
  tradesBody.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest('tr');
    const t = Number(row?.dataset.time);
    if (row && Number.isFinite(t)) opts.onShowTime?.(t);
  });
  new ResizeObserver(() => {
    if (visible && tab === 'overview' && lastReport) drawEquity(canvas, lastReport, null);
  }).observe(chartBox);
  canvas.addEventListener('pointermove', (e) => {
    if (!lastReport) return;
    const rect = canvas.getBoundingClientRect();
    const i = drawEquity(canvas, lastReport, e.clientX - rect.left);
    if (i === null) return;
    const { equity, times, closes, config } = lastReport;
    const first = closes.find((c) => c === c && c > 0) ?? NaN;
    const hold = (config.initialCapital * closes[i]) / first;
    readout.textContent = `${formatTime(times[i])}   Equity ${fmt(equity[i])}   Buy & hold ${fmt(hold)}`;
  });
  canvas.addEventListener('pointerleave', () => {
    if (lastReport) drawEquity(canvas, lastReport, null);
    readout.textContent = '';
  });

  refreshPicker();
  render();

  return {
    root,
    tools,
    select(id?: string) {
      refreshPicker();
      if (id && strategies().some((s) => s.id === id)) selected = id;
      refreshPicker();
      render();
    },
    setVisible(v: boolean) {
      visible = v;
      if (v) {
        refreshPicker();
        render();
      }
    },
    strategies: () => strategies().map((s) => s.id),
  };
}

// ------------------------------------------------------------------ overview

function kpi(label: string, value: string, sub: string, valueTone = '', subTone = valueTone): HTMLElement {
  return h('div', { class: 'st-kpi' }, h('div', { class: 'st-kpi-label' }, label), h('div', { class: `st-kpi-value ${valueTone}` }, value), h('div', { class: `st-kpi-sub ${subTone}` }, sub));
}

function renderKpis(el: HTMLElement, r: StrategyReport): void {
  const s = r.summary;
  el.replaceChildren(
    kpi('Net profit', formatMoney(s.netProfit), pct(s.netProfitPercent), tone(s.netProfit)),
    kpi('Closed trades', String(s.totalClosedTrades), s.openTrades ? `${s.openTrades} open` : 'none open'),
    kpi('Percent profitable', s.percentProfitable === null ? dash : `${fmt(s.percentProfitable)}%`, `${s.winningTrades} won, ${s.losingTrades} lost`),
    kpi('Profit factor', s.profitFactor === null ? dash : fmt(s.profitFactor, 3), 'gross profit / loss', s.profitFactor === null ? '' : s.profitFactor >= 1 ? 'st-up' : 'st-down', ''),
    kpi('Max drawdown', s.maxDrawdown ? `−${fmt(s.maxDrawdown)}` : fmt(0), s.maxDrawdown ? `−${fmt(s.maxDrawdownPercent)}%` : '0.00%', s.maxDrawdown ? 'st-down' : ''),
    kpi('Avg trade', formatMoney(s.avgTrade), s.avgTradePercent === null ? dash : pct(s.avgTradePercent), tone(s.avgTrade)),
    kpi('Sharpe ratio', s.sharpe === null ? dash : fmt(s.sharpe, 3), 'daily, annualized'),
    kpi('Buy & hold', formatMoney(s.buyAndHold), pct(s.buyAndHoldPercent), tone(s.buyAndHold)),
  );
}

function renderStats(el: HTMLElement, r: StrategyReport): void {
  const s = r.summary;
  const c = r.config;
  const qty =
    c.defaultQtyType === 'fixed' ? `${formatQty(c.defaultQtyValue)} contracts` : c.defaultQtyType === 'cash' ? `${fmt(c.defaultQtyValue)} cash` : `${fmt(c.defaultQtyValue)}% of equity`;
  const commission =
    c.commissionValue === 0
      ? 'none'
      : c.commissionType === 'percent'
        ? `${c.commissionValue}%`
        : c.commissionType === 'cash_per_contract'
          ? `${c.commissionValue} per contract`
          : `${c.commissionValue} per order`;
  const rows: Array<[string, string, string?]> = [
    ['Initial capital', fmt(s.initialCapital)],
    ['Equity', fmt(s.finalEquity)],
    ['Open P&L', formatMoney(s.openProfit), tone(s.openProfit)],
    ['Gross profit', fmt(s.grossProfit), s.grossProfit ? 'st-up' : ''],
    ['Gross loss', s.grossLoss ? `−${fmt(s.grossLoss)}` : fmt(0), s.grossLoss ? 'st-down' : ''],
    ['Avg winning trade', formatMoney(s.avgWin), tone(s.avgWin)],
    ['Avg losing trade', formatMoney(s.avgLoss), tone(s.avgLoss)],
    ['Ratio avg win / avg loss', s.ratioAvgWinLoss === null ? dash : fmt(s.ratioAvgWinLoss, 3)],
    ['Largest winning trade', formatMoney(s.largestWin), tone(s.largestWin)],
    ['Largest losing trade', formatMoney(s.largestLoss), tone(s.largestLoss)],
    ['Commission paid', fmt(s.commissionPaid)],
    ['Order size', qty],
    ['Commission, slippage', `${commission}, ${c.slippage} ticks`],
    ...riskRows(r),
  ];
  el.replaceChildren(h('tbody', {}, ...rows.map(([k, v, t]) => h('tr', {}, h('th', {}, k), h('td', { class: t ?? '' }, v)))));
}

/** Says which risk rule stopped trading, when one did. */
function renderStopNote(el: HTMLElement, r: StrategyReport): void {
  const stop = r.stoppedBy;
  el.hidden = stop === null;
  if (!stop) return;
  el.textContent = `Trading stopped on ${formatTime(stop.time)} by strategy.risk.${stop.rule}: ${stop.detail}. The position was closed and later orders were ignored.`;
}

/** Rows for the strategy.risk.* rules the script set. */
function riskRows(r: StrategyReport): Array<[string, string, string?]> {
  const k = r.risk;
  const amount = (a: { value: number; type: string }) => (a.type === 'cash' ? fmt(a.value) : `${a.value}% of equity`);
  const rows: Array<[string, string, string?]> = [];
  if (k.allowEntryIn !== null) rows.push(['Entries allowed', k.allowEntryIn === 'all' ? 'long and short' : `${k.allowEntryIn} only`]);
  if (k.maxPositionSize !== null) rows.push(['Max position size', formatQty(k.maxPositionSize)]);
  if (k.maxDrawdown) rows.push(['Max drawdown allowed', amount(k.maxDrawdown)]);
  if (k.maxIntradayLoss) rows.push(['Max loss per day', amount(k.maxIntradayLoss)]);
  if (k.maxIntradayFilledOrders !== null) rows.push(['Max orders per day', String(k.maxIntradayFilledOrders)]);
  if (k.maxConsLossDays !== null) rows.push(['Max losing days in a row', String(k.maxConsLossDays)]);
  if (k.maxIntradayLoss || k.maxIntradayFilledOrders !== null) {
    const halts = r.riskEvents.filter((e) => !e.final).length;
    rows.push(['Days halted', String(halts), halts ? 'st-down' : '']);
  }
  if (k.maxDrawdown || k.maxConsLossDays !== null) {
    rows.push(['Trading stopped', r.stoppedBy ? RISK_RULE_LABELS[r.stoppedBy.rule] : 'no', r.stoppedBy ? 'st-down' : '']);
  }
  return rows;
}

/** `#rrggbb` with an alpha, as rgba(); other color strings are returned unchanged. */
function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** Theme colors read from CSS, so the canvas follows light and dark mode. */
function themeColor(el: Element, name: string, fallback: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

/**
 * Draws the equity curve and the buy-and-hold line. With `hoverX`, also draws a crosshair
 * there and returns the bar index under it.
 */
function drawEquity(canvas: HTMLCanvasElement, r: StrategyReport, hoverX: number | null): number | null {
  const box = canvas.parentElement!;
  const cssW = Math.max(50, box.clientWidth);
  const cssH = Math.max(50, box.clientHeight);
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const { equity, closes, times, config } = r;
  const n = equity.length;
  if (n < 2) return null;
  const capital = config.initialCapital;
  const first = closes.find((c) => c === c && c > 0) ?? NaN;
  const hold = closes.map((c) => (capital * c) / first);

  let lo = capital;
  let hi = capital;
  for (let i = 0; i < n; i++) {
    for (const v of [equity[i], hold[i]]) {
      if (v === v) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
  }
  if (hi - lo < 1e-9) {
    hi += 1;
    lo -= 1;
  }
  const padY = (hi - lo) * 0.08;
  lo -= padY;
  hi += padY;

  const muted = themeColor(canvas, '--muted', '#8a929e');
  const border = themeColor(canvas, '--border', '#252b34');
  const up = themeColor(canvas, '--up', '#22ab94');
  const down = themeColor(canvas, '--down', '#f23645');
  const accent = themeColor(canvas, '--accent', '#2f80ed');

  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  const labels = [hi - padY, capital, lo + padY].map((v) => fmt(v, 0));
  const axisW = Math.max(...labels.map((l) => ctx.measureText(l).width)) + 12;
  const left = 4;
  const right = cssW - axisW;
  const top = 26;
  const bottom = cssH - 20;
  const x = (i: number) => left + ((right - left) * i) / (n - 1);
  const y = (v: number) => top + ((hi - v) / (hi - lo)) * (bottom - top);

  // Grid: the initial capital line and the axis labels.
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(right + 0.5, top);
  ctx.lineTo(right + 0.5, bottom);
  ctx.moveTo(left, bottom + 0.5);
  ctx.lineTo(right, bottom + 0.5);
  ctx.stroke();
  const baseY = Math.round(y(capital)) + 0.5;
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = muted;
  ctx.globalAlpha = 0.6;
  ctx.beginPath();
  ctx.moveTo(left, baseY);
  ctx.lineTo(right, baseY);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  ctx.fillStyle = muted;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  [hi - padY, capital, lo + padY].forEach((v, k) => {
    const yy = y(v);
    if (k !== 1 && Math.abs(yy - baseY) < 14) return;
    ctx.fillText(labels[k], right + 6, yy);
  });
  ctx.textBaseline = 'top';
  ctx.fillText(formatTime(times[0]).slice(0, 10), left, bottom + 5);
  ctx.textAlign = 'right';
  ctx.fillText(formatTime(times[n - 1]).slice(0, 10), right, bottom + 5);

  // Area between the equity curve and the initial capital, green above and red below.
  const path = new Path2D();
  let started = false;
  for (let i = 0; i < n; i++) {
    const v = equity[i];
    if (v !== v || v === undefined) continue;
    if (!started) {
      path.moveTo(x(i), y(v));
      started = true;
    } else path.lineTo(x(i), y(v));
  }
  const area = new Path2D(path);
  area.lineTo(x(n - 1), baseY);
  area.lineTo(x(0), baseY);
  area.closePath();
  // Fades towards the initial capital line.
  const fillSide = (color: string, from: number, to: number) => {
    if (Math.abs(to - from) < 1) return;
    const g = ctx.createLinearGradient(0, from, 0, to);
    g.addColorStop(0, withAlpha(color, 0.3));
    g.addColorStop(1, withAlpha(color, 0.02));
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, Math.min(from, to), right - left, Math.abs(to - from));
    ctx.clip();
    ctx.fillStyle = g;
    ctx.fill(area);
    ctx.restore();
  };
  fillSide(up, top, baseY);
  fillSide(down, bottom, baseY);

  // Buy and hold, then equity on top.
  ctx.strokeStyle = muted;
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const v = hold[i];
    if (i === 0) ctx.moveTo(x(i), y(v));
    else ctx.lineTo(x(i), y(v));
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.stroke(path);

  // Where a risk rule stopped trading.
  const stop = r.stoppedBy;
  if (stop && stop.bar >= 0 && stop.bar < n) {
    const sx = Math.round(x(stop.bar)) + 0.5;
    ctx.strokeStyle = down;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(sx, top);
    ctx.lineTo(sx, bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = down;
    ctx.textBaseline = 'top';
    ctx.textAlign = sx > (left + right) / 2 ? 'right' : 'left';
    ctx.fillText('Stopped', sx + (ctx.textAlign === 'right' ? -4 : 4), top + 2);
  }

  if (hoverX === null || hoverX < left || hoverX > right) return null;
  const i = Math.max(0, Math.min(n - 1, Math.round(((hoverX - left) / (right - left)) * (n - 1))));
  const xx = Math.round(x(i)) + 0.5;
  ctx.strokeStyle = muted;
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  ctx.moveTo(xx, top);
  ctx.lineTo(xx, bottom);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(xx, y(equity[i]), 3, 0, Math.PI * 2);
  ctx.fill();
  return i;
}

// ------------------------------------------------------------------ list of trades

function tradeRow(t: ClosedTrade | OpenTradeReport, n: number, cum: number | null): HTMLElement {
  const closed = 'exitTime' in t;
  const long = t.direction === 'long';
  const signal = closed ? `${t.entrySignal} → ${t.exitSignal}` : t.entrySignal;
  return h(
    'tr',
    { class: closed ? '' : 'st-open', dataset: { time: String(t.entryTime) }, title: 'Show on the chart' },
    h('td', { class: 'muted' }, String(n)),
    h('td', {}, h('span', { class: `st-side ${long ? 'st-long' : 'st-short'}` }, long ? 'Long' : 'Short')),
    h('td', { class: 'st-signal' }, signal),
    h('td', {}, formatTime(t.entryTime)),
    h('td', { class: 'num' }, formatPrice(t.entryPrice)),
    h('td', {}, closed ? formatTime(t.exitTime) : h('span', { class: 'muted' }, 'Open')),
    h('td', { class: 'num' }, closed ? formatPrice(t.exitPrice) : dash),
    h('td', { class: 'num' }, formatQty(t.qty)),
    h('td', { class: `num ${tone(t.pnl)}` }, formatMoney(t.pnl)),
    h('td', { class: `num ${tone(t.pnlPercent)}` }, pct(t.pnlPercent)),
    h('td', { class: `num ${cum === null ? '' : tone(cum)}` }, cum === null ? dash : formatMoney(cum)),
    h('td', { class: 'num' }, fmt(t.runUp)),
    h('td', { class: 'num' }, t.drawdown ? `−${fmt(t.drawdown)}` : fmt(0)),
  );
}

function renderTrades(body: HTMLElement, r: StrategyReport): void {
  const rows: HTMLElement[] = [];
  const total = r.trades.length;
  // Newest first: open trades, then closed trades from the latest.
  for (let k = r.openTrades.length - 1; k >= 0; k--) rows.push(tradeRow(r.openTrades[k], total + k + 1, null));
  let cum = r.trades.reduce((s, t) => s + t.pnl, 0);
  for (let k = total - 1; k >= 0; k--) {
    const t = r.trades[k];
    rows.push(tradeRow(t, k + 1, cum));
    cum -= t.pnl;
  }
  if (rows.length === 0) rows.push(h('tr', {}, h('td', { class: 'muted st-none', colspan: 13 }, 'No trades yet. Orders fill from the bar after the one that placed them.')));
  body.replaceChildren(...rows);
}
