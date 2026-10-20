/**
 * Chart types (how bars are drawn) and price scales for the price pane.
 *
 * Most types are the chart engine's own candle styles. Heikin Ashi is different: the engine
 * keeps the real OHLC bars, which indicators, scripts, alerts, drawings and the agent API all
 * read, and a hidden indicator on the price pane draws the averaged bars over transparent
 * real candles. So switching to Heikin Ashi changes the picture, never the numbers.
 */
import type { KLineData } from 'klinecharts';

export const CHART_TYPES = ['candles', 'hollow_candles', 'bars', 'line', 'area', 'heikin_ashi'] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export const PRICE_SCALES = ['normal', 'log', 'percent'] as const;
export type PriceScale = (typeof PRICE_SCALES)[number];

export interface ChartStyle {
  type: ChartType;
  scale: PriceScale;
}

export const DEFAULT_CHART_STYLE: Readonly<ChartStyle> = Object.freeze({ type: 'candles', scale: 'normal' });

export const CHART_TYPE_LABELS: Record<ChartType, string> = {
  candles: 'Candles',
  hollow_candles: 'Hollow candles',
  bars: 'Bars',
  line: 'Line',
  area: 'Area',
  heikin_ashi: 'Heikin Ashi',
};

export const PRICE_SCALE_LABELS: Record<PriceScale, string> = {
  normal: 'Normal',
  log: 'Logarithmic',
  percent: 'Percent',
};

export function isChartType(v: unknown): v is ChartType {
  return typeof v === 'string' && (CHART_TYPES as readonly string[]).includes(v);
}

export function isPriceScale(v: unknown): v is PriceScale {
  return typeof v === 'string' && (PRICE_SCALES as readonly string[]).includes(v);
}

/** The type after `type` in menu order, wrapping around. */
export function nextChartType(type: ChartType): ChartType {
  return CHART_TYPES[(CHART_TYPES.indexOf(type) + 1) % CHART_TYPES.length];
}

// ---------------------------------------------------------------- Heikin Ashi

export interface HeikinAshiBar {
  open: number;
  high: number;
  low: number;
  close: number;
}

type Ohlc = Pick<KLineData, 'open' | 'high' | 'low' | 'close'>;

/** One Heikin Ashi bar from the real bar and the previous Heikin Ashi bar (none for the first). */
function haBar(bar: Ohlc, prev: HeikinAshiBar | undefined): HeikinAshiBar {
  const close = (bar.open + bar.high + bar.low + bar.close) / 4;
  const open = prev ? (prev.open + prev.close) / 2 : (bar.open + bar.close) / 2;
  return { open, high: Math.max(bar.high, open, close), low: Math.min(bar.low, open, close), close };
}

/**
 * Heikin Ashi bars for `bars`, oldest first:
 * close = (open + high + low + close) / 4, open = (previous HA open + previous HA close) / 2
 * (the first bar uses (open + close) / 2), high = max(high, HA open, HA close) and
 * low = min(low, HA open, HA close).
 *
 * Each open depends on every bar before it, so loading older history changes all the values
 * after it a little; the difference halves with every bar.
 */
export function heikinAshi(bars: readonly Ohlc[]): HeikinAshiBar[] {
  const out: HeikinAshiBar[] = [];
  for (const bar of bars) out.push(haBar(bar, out[out.length - 1]));
  return out;
}

const sameBar = (a: KLineData | undefined, b: KLineData | undefined) =>
  !!a && !!b && a.timestamp === b.timestamp && a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close;

/**
 * Keeps the Heikin Ashi bars of a chart's data in step with it. A live update of the last bar
 * or new bars at the end only recompute from the last bar; anything else (older history
 * loaded in front, a new symbol or timeframe) recomputes everything.
 */
export class HeikinAshiSeries {
  private bars: HeikinAshiBar[] = [];
  /** Copies of the first bar and the last settled bar (the one before the last) of the previous data. */
  private first: KLineData | undefined;
  private settled: KLineData | undefined;

  update(data: readonly KLineData[]): HeikinAshiBar[] {
    const known = this.bars.length;
    // The last known bar may still have been forming, so it is always recomputed.
    const continues = known > 0 && data.length >= known && sameBar(data[0], this.first) && (known < 2 || sameBar(data[known - 2], this.settled));
    const from = continues ? known - 1 : 0;
    const bars = this.bars.slice(0, from);
    for (let i = from; i < data.length; i++) bars.push(haBar(data[i], bars[i - 1]));
    this.bars = bars;
    // Copies, so in-place edits of the engine's bars cannot fool the checks above.
    this.first = data[0] && { ...data[0] };
    this.settled = data.length >= 2 ? { ...data[data.length - 2] } : undefined;
    return bars;
  }
}

/**
 * Checks a requested change from the automation API or the agent bridge. Throws a message
 * that lists the valid values when one is wrong, or when neither is given.
 */
export function parseChartStyleChange(raw: { type?: unknown; scale?: unknown }): Partial<ChartStyle> {
  const change: Partial<ChartStyle> = {};
  if (raw.type !== undefined && raw.type !== null) {
    if (!isChartType(raw.type)) throw new Error(`Unknown chart type ${String(raw.type)}. Use one of ${CHART_TYPES.join(', ')}.`);
    change.type = raw.type;
  }
  if (raw.scale !== undefined && raw.scale !== null) {
    if (!isPriceScale(raw.scale)) throw new Error(`Unknown scale ${String(raw.scale)}. Use one of ${PRICE_SCALES.join(', ')}.`);
    change.scale = raw.scale;
  }
  if (change.type === undefined && change.scale === undefined) throw new Error('Give a chart type, a scale or both');
  return change;
}
