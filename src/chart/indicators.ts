import { registerIndicator, type IndicatorDrawParams, type KLineData } from 'klinecharts';
import { atr, donchian, hma, ichimoku, stochRsi, supertrend, vwap, wma, type IchimokuRow } from './ta';
import { drawVolumeProfile, volumeProfileTooltip } from './profile';
import type { PaneKind } from '../store/layout';

export interface IndicatorDef {
  name: string;
  label: string;
  pane: PaneKind;
  /** Labels for each parameter, in order. */
  paramLabels: string[];
  /** Defaults used when the indicator is added. */
  defaults: number[];
  /** Each parameter draws its own line (MA 5/10/30...), so lines can be added or removed. */
  variadic?: boolean;
}

/** Everything users can add. Names match the chart engine's registered indicator names. */
export const INDICATORS: readonly IndicatorDef[] = [
  // Overlays on the price pane
  { name: 'MA', label: 'Moving Average', pane: 'main', paramLabels: ['Length'], defaults: [5, 10, 30, 60], variadic: true },
  { name: 'EMA', label: 'Exponential Moving Average', pane: 'main', paramLabels: ['Length'], defaults: [6, 12, 20], variadic: true },
  { name: 'SMA', label: 'Smoothed Moving Average', pane: 'main', paramLabels: ['Length', 'Weight'], defaults: [12, 2] },
  { name: 'WMA', label: 'Weighted Moving Average', pane: 'main', paramLabels: ['Length'], defaults: [20] },
  { name: 'HMA', label: 'Hull Moving Average', pane: 'main', paramLabels: ['Length'], defaults: [21] },
  { name: 'BOLL', label: 'Bollinger Bands', pane: 'main', paramLabels: ['Length', 'Std dev'], defaults: [20, 2] },
  { name: 'DC', label: 'Donchian Channel', pane: 'main', paramLabels: ['Length'], defaults: [20] },
  { name: 'VWAP', label: 'VWAP (daily)', pane: 'main', paramLabels: [], defaults: [] },
  { name: 'SUPERTREND', label: 'Supertrend', pane: 'main', paramLabels: ['ATR length', 'Multiplier'], defaults: [10, 3] },
  { name: 'SAR', label: 'Parabolic SAR', pane: 'main', paramLabels: ['Start', 'Step', 'Max'], defaults: [2, 2, 20] },
  { name: 'BBI', label: 'Bull and Bear Index', pane: 'main', paramLabels: ['P1', 'P2', 'P3', 'P4'], defaults: [3, 6, 12, 24] },
  { name: 'AVP', label: 'Average Price', pane: 'main', paramLabels: [], defaults: [] },
  { name: 'ICHIMOKU', label: 'Ichimoku Cloud', pane: 'main', paramLabels: ['Conversion', 'Base', 'Span B', 'Displacement'], defaults: [9, 26, 52, 26] },
  { name: 'VP', label: 'Volume Profile (visible range)', pane: 'main', paramLabels: ['Rows', 'Value area %'], defaults: [24, 70] },
  // Separate panes
  { name: 'VOL', label: 'Volume', pane: 'sub', paramLabels: ['MA length'], defaults: [5, 10, 20], variadic: true },
  { name: 'MACD', label: 'MACD', pane: 'sub', paramLabels: ['Fast', 'Slow', 'Signal'], defaults: [12, 26, 9] },
  { name: 'RSI', label: 'Relative Strength Index', pane: 'sub', paramLabels: ['Length'], defaults: [14], variadic: true },
  { name: 'STOCHRSI', label: 'Stochastic RSI', pane: 'sub', paramLabels: ['RSI length', 'Stoch length', 'K', 'D'], defaults: [14, 14, 3, 3] },
  { name: 'KDJ', label: 'KDJ (Stochastic)', pane: 'sub', paramLabels: ['Length', 'K smooth', 'D smooth'], defaults: [9, 3, 3] },
  { name: 'ATR', label: 'Average True Range', pane: 'sub', paramLabels: ['Length'], defaults: [14] },
  { name: 'OBV', label: 'On Balance Volume', pane: 'sub', paramLabels: ['MA length'], defaults: [30] },
  { name: 'CCI', label: 'Commodity Channel Index', pane: 'sub', paramLabels: ['Length'], defaults: [20] },
  { name: 'DMI', label: 'Directional Movement (ADX)', pane: 'sub', paramLabels: ['Length', 'ADX smoothing'], defaults: [14, 6] },
  { name: 'WR', label: 'Williams %R', pane: 'sub', paramLabels: ['Length'], defaults: [6, 10, 14], variadic: true },
  { name: 'ROC', label: 'Rate of Change', pane: 'sub', paramLabels: ['Length', 'Signal'], defaults: [12, 6] },
  { name: 'MTM', label: 'Momentum', pane: 'sub', paramLabels: ['Length', 'Signal'], defaults: [12, 6] },
  { name: 'TRIX', label: 'TRIX', pane: 'sub', paramLabels: ['Length', 'Signal'], defaults: [12, 9] },
  { name: 'AO', label: 'Awesome Oscillator', pane: 'sub', paramLabels: ['Fast', 'Slow'], defaults: [5, 34] },
  { name: 'BIAS', label: 'Bias Ratio', pane: 'sub', paramLabels: ['Length'], defaults: [6, 12, 24], variadic: true },
  { name: 'BRAR', label: 'Sentiment (BR/AR)', pane: 'sub', paramLabels: ['Length'], defaults: [26] },
  { name: 'CR', label: 'Energy (CR)', pane: 'sub', paramLabels: ['Length', 'MA1', 'MA2', 'MA3', 'MA4'], defaults: [26, 10, 20, 40, 60] },
  { name: 'DMA', label: 'Different of Moving Average', pane: 'sub', paramLabels: ['Short', 'Long', 'Signal'], defaults: [10, 50, 10] },
  { name: 'EMV', label: 'Ease of Movement', pane: 'sub', paramLabels: ['Length', 'Signal'], defaults: [14, 9] },
  { name: 'PSY', label: 'Psychological Line', pane: 'sub', paramLabels: ['Length', 'Signal'], defaults: [12, 6] },
  { name: 'PVT', label: 'Price and Volume Trend', pane: 'sub', paramLabels: [], defaults: [] },
  { name: 'VR', label: 'Volume Ratio', pane: 'sub', paramLabels: ['Length', 'Signal'], defaults: [24, 30] },
];

export function getIndicatorDef(name: string): IndicatorDef | undefined {
  return INDICATORS.find((d) => d.name === name);
}

export function paramLabel(def: IndicatorDef | undefined, index: number): string {
  if (!def) return `Param ${index + 1}`;
  if (def.variadic) return `${def.paramLabels[0] ?? 'Length'} ${index + 1}`;
  return def.paramLabels[index] ?? `Param ${index + 1}`;
}

const closes = (data: KLineData[]) => data.map((d) => d.close);
const length = (v: number | undefined, fallback: number) => Math.max(1, Math.round(v ?? fallback));

const UP = '#22ab94';
const DOWN = '#f23645';
const CLOUD_UP = 'rgba(34,171,148,0.18)';
const CLOUD_DOWN = 'rgba(242,54,69,0.18)';

let registered = false;

/** Registers the indicators that the chart engine does not include. Safe to call more than once. */
export function registerCustomIndicators(): void {
  if (registered) return;
  registered = true;

  registerIndicator<{ atr?: number }, number>({
    name: 'ATR',
    shortName: 'ATR',
    calcParams: [14],
    figures: [{ key: 'atr', title: 'ATR: ', type: 'line' }],
    calc: (data, indicator) => atr(data, indicator.calcParams[0] ?? 14).map((v) => ({ atr: v })),
  });

  registerIndicator<Record<string, number | undefined>, number>({
    name: 'WMA',
    shortName: 'WMA',
    series: 'price',
    precision: 2,
    shouldOhlc: true,
    calcParams: [20],
    figures: [{ key: 'wma', title: 'WMA: ', type: 'line' }],
    calc: (data, indicator) => wma(closes(data), indicator.calcParams[0] ?? 20).map((v) => ({ wma: v })),
  });

  registerIndicator<Record<string, number | undefined>, number>({
    name: 'HMA',
    shortName: 'HMA',
    series: 'price',
    precision: 2,
    shouldOhlc: true,
    calcParams: [21],
    figures: [{ key: 'hma', title: 'HMA: ', type: 'line' }],
    calc: (data, indicator) => hma(closes(data), indicator.calcParams[0] ?? 21).map((v) => ({ hma: v })),
  });

  registerIndicator<{ upper?: number; middle?: number; lower?: number }, number>({
    name: 'DC',
    shortName: 'DC',
    series: 'price',
    precision: 2,
    shouldOhlc: true,
    calcParams: [20],
    figures: [
      { key: 'upper', title: 'UP: ', type: 'line' },
      { key: 'middle', title: 'MID: ', type: 'line' },
      { key: 'lower', title: 'DN: ', type: 'line' },
    ],
    calc: (data, indicator) => donchian(data, indicator.calcParams[0] ?? 20),
  });

  registerIndicator<{ vwap?: number }, number>({
    name: 'VWAP',
    shortName: 'VWAP',
    series: 'price',
    precision: 2,
    shouldOhlc: true,
    calcParams: [],
    figures: [{ key: 'vwap', title: 'VWAP: ', type: 'line' }],
    calc: (data) => vwap(data).map((v) => ({ vwap: v })),
  });

  registerIndicator<{ up?: number; down?: number }, number>({
    name: 'SUPERTREND',
    shortName: 'ST',
    series: 'price',
    precision: 2,
    shouldOhlc: true,
    calcParams: [10, 3],
    figures: [
      { key: 'up', title: 'UP: ', type: 'line', styles: () => ({ color: '#22ab94' }) },
      { key: 'down', title: 'DN: ', type: 'line', styles: () => ({ color: '#f23645' }) },
    ],
    calc: (data, indicator) => supertrend(data, indicator.calcParams[0] ?? 10, indicator.calcParams[1] ?? 3),
  });

  registerIndicator<{ k?: number; d?: number }, number>({
    name: 'STOCHRSI',
    shortName: 'StochRSI',
    calcParams: [14, 14, 3, 3],
    minValue: 0,
    maxValue: 100,
    figures: [
      { key: 'k', title: 'K: ', type: 'line' },
      { key: 'd', title: 'D: ', type: 'line' },
    ],
    calc: (data, indicator) => {
      const [r = 14, s = 14, k = 3, d = 3] = indicator.calcParams;
      return stochRsi(closes(data), r, s, k, d);
    },
  });

  registerIndicator<IchimokuRow, number>({
    name: 'ICHIMOKU',
    shortName: 'Ichimoku',
    series: 'price',
    shouldOhlc: true,
    calcParams: [9, 26, 52, 26],
    figures: [
      { key: 'conversion', title: 'Conv: ', type: 'line', styles: () => ({ color: '#2962ff' }) },
      { key: 'base', title: 'Base: ', type: 'line', styles: () => ({ color: '#b8336a' }) },
      { key: 'spanA', title: 'Span A: ', type: 'line', styles: () => ({ color: UP }) },
      { key: 'spanB', title: 'Span B: ', type: 'line', styles: () => ({ color: DOWN }) },
      { key: 'lagging', title: 'Lag: ', type: 'line', styles: () => ({ color: '#9c6ade' }) },
    ],
    calc: (data, indicator) => {
      const [c, b, s, d] = indicator.calcParams;
      return ichimoku(data, length(c, 9), length(b, 26), length(s, 52), Math.max(0, Math.round(d ?? 26)));
    },
    draw: (params) => {
      drawCloud(params);
      // The chart engine still draws the lines up to the last bar.
      return false;
    },
  });

  registerIndicator<unknown, number>({
    name: 'VP',
    shortName: 'VP',
    series: 'price',
    calcParams: [24, 70],
    figures: [],
    // A fresh array per data change; the draw callback uses it to know when to rebuild.
    calc: () => [],
    draw: drawVolumeProfile,
    createTooltipDataSource: volumeProfileTooltip,
  });
}

/**
 * Fills the cloud between leading spans A and B, green where A >= B and red below, and draws
 * the part of both spans that lies ahead of the last bar (the chart engine only draws lines
 * where there are bars). Span value at bar i is the value computed `displacement` bars
 * earlier, so bars past the end read the unshifted values of the newest bars.
 */
function drawCloud({ ctx, chart, indicator, bounding, xAxis, yAxis }: IndicatorDrawParams<IchimokuRow, number, unknown>): void {
  const rows = indicator.result;
  const n = rows.length;
  if (n === 0) return;
  const d = Math.max(0, Math.round(indicator.calcParams[3] ?? 26));
  const spanA = (i: number) => rows[i - d]?.leadA;
  const spanB = (i: number) => rows[i - d]?.leadB;
  const range = chart.getVisibleRange();
  const from = Math.max(d + 1, range.realFrom - 1);
  const to = Math.min(n - 1 + d, range.realTo + 1);
  if (from > to) return;

  const up = new Path2D();
  const down = new Path2D();
  const quad = (path: Path2D, pts: Array<[number, number]>) => {
    path.moveTo(pts[0][0], pts[0][1]);
    for (let k = 1; k < pts.length; k++) path.lineTo(pts[k][0], pts[k][1]);
    path.closePath();
  };
  for (let i = from; i <= to; i++) {
    const a0 = spanA(i - 1);
    const b0 = spanB(i - 1);
    const a1 = spanA(i);
    const b1 = spanB(i);
    if (a0 === undefined || b0 === undefined || a1 === undefined || b1 === undefined) continue;
    const x0 = xAxis.convertToPixel(i - 1);
    const x1 = xAxis.convertToPixel(i);
    const d0 = a0 - b0;
    const d1 = a1 - b1;
    if ((d0 >= 0) === (d1 >= 0)) {
      quad(d0 >= 0 && d1 >= 0 ? up : down, [[x0, yAxis.convertToPixel(a0)], [x1, yAxis.convertToPixel(a1)], [x1, yAxis.convertToPixel(b1)], [x0, yAxis.convertToPixel(b0)]]);
      continue;
    }
    // The spans cross inside this bar: split at the crossing so each side gets its colour.
    const t = d0 / (d0 - d1);
    const xc = x0 + (x1 - x0) * t;
    const yc = yAxis.convertToPixel(a0 + (a1 - a0) * t);
    quad(d0 >= 0 ? up : down, [[x0, yAxis.convertToPixel(a0)], [xc, yc], [x0, yAxis.convertToPixel(b0)]]);
    quad(d1 >= 0 ? up : down, [[xc, yc], [x1, yAxis.convertToPixel(a1)], [x1, yAxis.convertToPixel(b1)]]);
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, bounding.width, bounding.height);
  ctx.clip();
  // Behind the candles.
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = CLOUD_UP;
  ctx.fill(up);
  ctx.fillStyle = CLOUD_DOWN;
  ctx.fill(down);
  ctx.globalCompositeOperation = 'source-over';

  // Span lines past the last bar.
  const lineWidth = chart.getStyles().indicator.lines[0]?.size ?? 1;
  ctx.setLineDash([]);
  for (const [span, color] of [[spanA, UP], [spanB, DOWN]] as const) {
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    let started = false;
    for (let i = Math.max(n - 1, from - 1); i <= to; i++) {
      const v = span(i);
      if (v === undefined) {
        started = false;
        continue;
      }
      const x = xAxis.convertToPixel(i);
      const y = yAxis.convertToPixel(v);
      if (started) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      started = true;
    }
    ctx.stroke();
  }
  ctx.restore();
}
