/**
 * Draws the chart types and price scales of chartStyle.ts with the chart engine.
 *
 * Most types are the engine's own candle styles. For Heikin Ashi the engine keeps the real
 * bars and a hidden indicator on the price pane draws the averaged bars over transparent
 * real candles.
 */
import { registerIndicator, type Chart, type DeepPartial, type IndicatorCreateTooltipDataSourceParams, type IndicatorDrawParams, type Styles } from 'klinecharts';
import { HeikinAshiSeries, type ChartType, type HeikinAshiBar, type PriceScale } from './chartStyle';

const CANDLE_PANE = 'candle_pane';
const HEIKIN_ASHI_INDICATOR = 'KANDLE_HEIKIN_ASHI';

const UP = '#22ab94';
const DOWN = '#f23645';
const LINE = '#2f80ed';
const CLEAR = 'rgba(0,0,0,0)';

const series = new WeakMap<object, HeikinAshiSeries>();

function drawHeikinAshi({ ctx, chart, indicator, bounding, xAxis, yAxis }: IndicatorDrawParams<HeikinAshiBar, unknown, unknown>): boolean {
  const rows = indicator.result;
  const { from, to } = chart.getVisibleRange();
  const { gapBar, halfGapBar } = chart.getBarSpace();
  // Same geometry as the engine's own candles.
  const correction = gapBar % 2 === 0 ? 1 : 0;
  // Indicators below zero are drawn behind the rest with destination-over; draw normally,
  // just first, so other indicators on the price pane stay on top of the bars.
  ctx.globalCompositeOperation = 'source-over';
  ctx.beginPath();
  ctx.rect(0, 0, bounding.width, bounding.height);
  ctx.clip();
  for (let i = Math.max(0, from); i < Math.min(rows.length, to); i++) {
    const bar = rows[i];
    if (!bar) continue;
    const x = xAxis.convertToPixel(i);
    const [high, top, bottom, low] = [bar.high, Math.max(bar.open, bar.close), Math.min(bar.open, bar.close), bar.low].map((v) => yAxis.convertToPixel(v));
    ctx.fillStyle = bar.close >= bar.open ? UP : DOWN;
    ctx.fillRect(x, high, 1, low - high);
    ctx.fillRect(x - halfGapBar, top, gapBar + correction, Math.max(1, bottom - top));
  }
  return true;
}

function heikinAshiTooltip({ chart, indicator, crosshair }: IndicatorCreateTooltipDataSourceParams<HeikinAshiBar>) {
  const rows = indicator.result;
  const index = crosshair.dataIndex ?? rows.length - 1;
  const bar = rows[index];
  const precision = chart.getSymbol()?.pricePrecision ?? 2;
  const color = bar && bar.close >= bar.open ? UP : DOWN;
  const legend = (title: string, value: number | undefined) => ({
    title: { text: `${title}: `, color },
    value: { text: value === undefined ? 'n/a' : value.toFixed(precision), color },
  });
  return {
    name: 'Heikin Ashi',
    calcParamsText: '',
    features: [],
    legends: [legend('O', bar?.open), legend('H', bar?.high), legend('L', bar?.low), legend('C', bar?.close)],
  };
}

let registered = false;

/** Registers the indicator that draws Heikin Ashi bars. Safe to call more than once. */
export function registerChartTypes(): void {
  if (registered) return;
  registered = true;
  registerIndicator<HeikinAshiBar>({
    name: HEIKIN_ASHI_INDICATOR,
    shortName: 'Heikin Ashi',
    series: 'price',
    // Below the other indicators on the price pane.
    zLevel: -1,
    // Keys only, so the price axis makes room for the bars; drawHeikinAshi does the drawing.
    figures: [{ key: 'high' }, { key: 'low' }],
    calc: (data, indicator) => {
      let s = series.get(indicator);
      if (!s) series.set(indicator, (s = new HeikinAshiSeries()));
      return s.update(data);
    },
    draw: drawHeikinAshi,
    createTooltipDataSource: heikinAshiTooltip,
  });
}

/** Candle styles for a chart type, applied over the theme's styles. */
export function candleStyles(type: ChartType): DeepPartial<Styles> {
  const solid = { upColor: UP, downColor: DOWN, upBorderColor: UP, downBorderColor: DOWN, upWickColor: UP, downWickColor: DOWN };
  switch (type) {
    case 'hollow_candles':
      return { candle: { type: 'candle_up_stroke', bar: solid } };
    case 'bars':
      return { candle: { type: 'ohlc', bar: solid } };
    case 'line':
      return { candle: { type: 'area', area: { lineColor: LINE, lineSize: 2, backgroundColor: CLEAR, point: { color: LINE, rippleColor: 'rgba(47,128,237,0.3)' } } } };
    case 'area':
      return {
        candle: {
          type: 'area',
          area: {
            lineColor: LINE,
            lineSize: 2,
            backgroundColor: [
              { offset: 0, color: 'rgba(47,128,237,0.02)' },
              { offset: 1, color: 'rgba(47,128,237,0.28)' },
            ],
            point: { color: LINE, rippleColor: 'rgba(47,128,237,0.3)' },
          },
        },
      };
    case 'heikin_ashi':
      // The real candles stay for the price marks and the crosshair, but are not painted.
      return {
        candle: {
          type: 'candle_solid',
          bar: { upColor: CLEAR, downColor: CLEAR, noChangeColor: CLEAR, upBorderColor: CLEAR, downBorderColor: CLEAR, noChangeBorderColor: CLEAR, upWickColor: CLEAR, downWickColor: CLEAR, noChangeWickColor: CLEAR },
        },
      };
    default:
      return { candle: { type: 'candle_solid', bar: solid } };
  }
}

const AXIS_NAMES: Record<PriceScale, string> = { normal: 'normal', log: 'logarithm', percent: 'percentage' };

/**
 * Applies a chart type's candle styles. Call after any setStyles that resets the theme,
 * since that puts the engine's default candle type back.
 */
export function applyChartType(chart: Chart, type: ChartType): void {
  chart.setStyles(candleStyles(type));
  const ha = chart.getIndicators({ name: HEIKIN_ASHI_INDICATOR }).length > 0;
  if (type === 'heikin_ashi' && !ha) chart.createIndicator({ name: HEIKIN_ASHI_INDICATOR, paneId: CANDLE_PANE }, true);
  if (type !== 'heikin_ashi' && ha) chart.removeIndicator({ name: HEIKIN_ASHI_INDICATOR });
}

/** Switches the price pane's axis between normal, logarithmic and percent. */
export function applyPriceScale(chart: Chart, scale: PriceScale): void {
  const name = AXIS_NAMES[scale];
  if (chart.getYAxes({ paneId: CANDLE_PANE })[0]?.name === name) return;
  chart.overrideYAxis({ paneId: CANDLE_PANE, name });
}
