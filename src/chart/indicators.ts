import { registerIndicator, type KLineData } from 'klinecharts';
import { atr, donchian, hma, stochRsi, supertrend, vwap, wma } from './ta';
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
}
