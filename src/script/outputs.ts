/** What a script draws, collected bar by bar while it runs. */
import { CONSTANTS } from './builtins/registry';

export type PlotStyle = 'line' | 'linebr' | 'stepline' | 'histogram' | 'columns' | 'circles' | 'cross' | 'area' | 'areabr';
export type ShapeStyle =
  | 'xcross'
  | 'cross'
  | 'circle'
  | 'triangleup'
  | 'triangledown'
  | 'flag'
  | 'arrowup'
  | 'arrowdown'
  | 'labelup'
  | 'labeldown'
  | 'square'
  | 'diamond';
export type Location = 'abovebar' | 'belowbar' | 'top' | 'bottom' | 'absolute';
export type LineStyle = 'solid' | 'dashed' | 'dotted';

/** Per-bar color, as a CSS string or null when na. */
export type ColorSeries = Array<string | null | undefined>;

export interface PlotOutput {
  kind: 'plot';
  index: number;
  title: string;
  style: PlotStyle;
  linewidth: number;
  offset: number;
  histbase: number;
  /** Default color when the script passes none. */
  color: string;
  values: number[];
  colors: ColorSeries;
  visible: boolean;
}

export interface ShapeOutput {
  kind: 'shape';
  index: number;
  title: string;
  /** For plotchar the glyph, otherwise null. */
  char: string | null;
  style: ShapeStyle;
  location: Location;
  size: number;
  offset: number;
  text: string;
  color: string;
  textColor: string | null;
  /** NaN when nothing is drawn on that bar; the series value otherwise. */
  values: number[];
  colors: ColorSeries;
  textColors: ColorSeries;
}

export interface HlineOutput {
  kind: 'hline';
  index: number;
  title: string;
  price: number;
  color: string | null;
  lineStyle: LineStyle;
  linewidth: number;
}

export interface FillOutput {
  kind: 'fill';
  index: number;
  from: { kind: 'plot' | 'hline'; index: number } | null;
  to: { kind: 'plot' | 'hline'; index: number } | null;
  color: string | null;
  colors: ColorSeries;
}

export interface BarColorOutput {
  kind: 'bgcolor' | 'barcolor';
  index: number;
  offset: number;
  colors: ColorSeries;
}

export interface Outputs {
  plots: PlotOutput[];
  shapes: ShapeOutput[];
  hlines: HlineOutput[];
  fills: FillOutput[];
  backgrounds: BarColorOutput[];
  barColors: BarColorOutput[];
}

export function emptyOutputs(): Outputs {
  return { plots: [], shapes: [], hlines: [], fills: [], backgrounds: [], barColors: [] };
}

/** Default colors for plots without one, cycled in order. */
export const PLOT_PALETTE = ['#2962ff', '#ff6d00', '#00b8d4', '#d500f9', '#00c853', '#ffd600', '#f50057', '#64dd17'];

export const SHAPE_SIZES: Record<string, number> = { auto: 9, tiny: 6, small: 9, normal: 13, large: 18, huge: 26 };

for (const s of ['line', 'linebr', 'stepline', 'stepline_diamond', 'histogram', 'columns', 'circles', 'cross', 'area', 'areabr', 'steplinebr']) {
  CONSTANTS.set(`plot.style_${s}`, s);
}
for (const s of ['xcross', 'cross', 'circle', 'triangleup', 'triangledown', 'flag', 'arrowup', 'arrowdown', 'labelup', 'labeldown', 'square', 'diamond']) {
  CONSTANTS.set(`shape.${s}`, s);
}
for (const l of ['abovebar', 'belowbar', 'top', 'bottom', 'absolute']) CONSTANTS.set(`location.${l}`, l);
for (const s of Object.keys(SHAPE_SIZES)) CONSTANTS.set(`size.${s}`, s);
for (const s of ['solid', 'dashed', 'dotted']) {
  CONSTANTS.set(`hline.style_${s}`, s);
  CONSTANTS.set(`plot.linestyle_${s}`, s);
}
for (const d of ['all', 'none', 'data_window', 'pane', 'price_scale', 'status_line']) CONSTANTS.set(`display.${d}`, d);
for (const f of ['inherit', 'price', 'volume', 'percent', 'mintick']) CONSTANTS.set(`format.${f}`, f);
for (const s of ['ascending', 'descending']) CONSTANTS.set(`order.${s}`, s);
