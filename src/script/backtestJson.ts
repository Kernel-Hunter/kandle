/** Backtest results as plain JSON for the automation API and the agent bridge. */
import type { ClosedTrade, OpenTradeReport, RiskEvent, RiskSettings, RiskRule, StrategyReport, StrategySummary } from './strategy';

const money = (v: number | null) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const ratio = (v: number | null) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000);
const precise = (v: number) => (Number.isFinite(v) ? Number(v.toPrecision(10)) : null);
const iso = (t: number) => (Number.isFinite(t) ? new Date(t).toISOString() : null);

/** The strategy.risk.* rules a script set; rules it did not set are left out. */
export type RiskSettingsJson = { [K in keyof RiskSettings]?: NonNullable<RiskSettings[K]> };

export interface RiskEventJson {
  rule: RiskRule;
  time: string | null;
  detail: string;
}

export interface BacktestJson {
  /** The strategy() settings in use, plus `risk` when the script sets strategy.risk.* rules. */
  settings: StrategyReport['config'] & { risk?: RiskSettingsJson };
  /** The risk rule that stopped trading for the rest of the run, or null. */
  riskStop: RiskEventJson | null;
  /** How many times an intraday risk rule halted trading until the next UTC day. */
  riskHalts: number;
  summary: Record<keyof StrategySummary, number | null>;
  totalTrades: number;
  /** The latest closed trades, oldest first. */
  trades: Array<Record<string, unknown>>;
  openTrades: Array<Record<string, unknown>>;
}

function tradeJson(t: ClosedTrade | OpenTradeReport, n: number): Record<string, unknown> {
  const out: Record<string, unknown> = {
    n,
    direction: t.direction,
    qty: precise(t.qty),
    entryTime: iso(t.entryTime),
    entryPrice: precise(t.entryPrice),
    entrySignal: t.entrySignal,
  };
  if ('exitTime' in t) {
    out.exitTime = iso(t.exitTime);
    out.exitPrice = precise(t.exitPrice);
    out.exitSignal = t.exitSignal;
  }
  out.pnl = money(t.pnl);
  out.pnlPercent = ratio(t.pnlPercent);
  out.runUp = money(t.runUp);
  out.drawdown = money(t.drawdown);
  return out;
}

function riskJson(risk: RiskSettings): RiskSettingsJson | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(risk)) if (v !== null) out[k] = typeof v === 'object' ? { ...v } : v;
  return Object.keys(out).length ? (out as RiskSettingsJson) : undefined;
}

const eventJson = (e: RiskEvent): RiskEventJson => ({ rule: e.rule, time: iso(e.time), detail: e.detail });

/** A JSON-friendly digest of a backtest: settings, rounded summary and the latest trades. */
export function backtestSummary(report: StrategyReport, maxTrades: number): BacktestJson {
  const summary = {} as Record<keyof StrategySummary, number | null>;
  for (const [k, v] of Object.entries(report.summary) as Array<[keyof StrategySummary, number | null]>) {
    summary[k] = k === 'sharpe' || k === 'profitFactor' || k === 'ratioAvgWinLoss' ? ratio(v) : k === 'positionSize' ? (v === null ? null : precise(v)) : money(v);
  }
  const limit = Math.max(0, Math.min(500, Math.floor(maxTrades)));
  const first = Math.max(0, report.trades.length - limit);
  const risk = riskJson(report.risk);
  return {
    settings: risk ? { ...report.config, risk } : { ...report.config },
    riskStop: report.stoppedBy && eventJson(report.stoppedBy),
    riskHalts: report.riskEvents.filter((e) => !e.final).length,
    summary,
    totalTrades: report.trades.length,
    trades: report.trades.slice(first).map((t, i) => tradeJson(t, first + i + 1)),
    openTrades: report.openTrades.map((t, i) => tradeJson(t, report.trades.length + i + 1)),
  };
}
