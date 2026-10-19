/**
 * Volume profile of the bars in view: total volume traded at each price row, the point of
 * control and the value area. The math is plain functions; the chart glue at the bottom
 * draws it on the right side of the price pane and caches it between redraws.
 */
import type { IndicatorCreateTooltipDataSourceParams, IndicatorDrawParams } from 'klinecharts';
import type { Bar } from './ta';

export interface VolumeProfile {
  /** Bottom of the lowest row and top of the highest row. */
  low: number;
  high: number;
  /** Price height of one row. */
  step: number;
  /** Volume per row, lowest price first. */
  volumes: number[];
  total: number;
  /** Row with the most volume. */
  poc: number;
  /** Lowest and highest row of the value area (inclusive). */
  valueLow: number;
  valueHigh: number;
}

/**
 * Builds the profile of `bars[from..to)` with `rowCount` equal price rows between the lowest
 * low and the highest high.
 *
 * Splitting a bar's volume: we only know the bar's range, not where inside it the trades
 * happened, so the volume is spread evenly over the range. Each row gets
 * volume * (overlap of the row with [low, high]) / (high - low). A bar with no range
 * (high == low) puts all its volume in the row holding that price.
 *
 * Point of control: the row with the most volume. On a tie the row nearer the middle of the
 * price range wins, then the lower one.
 *
 * Value area: start at the point of control and keep adding the neighbouring row, above or
 * below, that has more volume (the upper one on a tie) until the rows hold at least
 * `valueAreaPercent` of the total volume.
 */
export function volumeProfile(bars: Bar[], rowCount: number, valueAreaPercent: number, from = 0, to = bars.length): VolumeProfile | null {
  const start = Math.max(0, from);
  const end = Math.min(bars.length, to);
  const rows = Math.max(1, Math.floor(rowCount));
  let low = Infinity;
  let high = -Infinity;
  for (let i = start; i < end; i++) {
    low = Math.min(low, bars[i].low);
    high = Math.max(high, bars[i].high);
  }
  if (!(low <= high)) return null;

  const step = (high - low) / rows;
  const rowOf = (price: number) => (step > 0 ? Math.min(rows - 1, Math.max(0, Math.floor((price - low) / step))) : 0);
  const volumes = new Array<number>(rows).fill(0);
  let total = 0;
  for (let i = start; i < end; i++) {
    const b = bars[i];
    const v = b.volume ?? 0;
    if (!(v > 0)) continue;
    total += v;
    const range = b.high - b.low;
    if (range <= 0) {
      volumes[rowOf(b.low)] += v;
      continue;
    }
    const first = rowOf(b.low);
    const last = rowOf(b.high);
    for (let r = first; r <= last; r++) {
      const top = r === rows - 1 ? high : low + (r + 1) * step;
      const bottom = low + r * step;
      const overlap = Math.min(top, b.high) - Math.max(bottom, b.low);
      if (overlap > 0) volumes[r] += (v * overlap) / range;
    }
  }

  const middle = (rows - 1) / 2;
  let poc = 0;
  for (let r = 1; r < rows; r++) {
    if (volumes[r] > volumes[poc] || (volumes[r] === volumes[poc] && Math.abs(r - middle) < Math.abs(poc - middle))) poc = r;
  }

  const target = (total * Math.min(100, Math.max(0, valueAreaPercent))) / 100;
  let valueLow = poc;
  let valueHigh = poc;
  let inside = volumes[poc];
  while (inside < target && (valueLow > 0 || valueHigh < rows - 1)) {
    const above = valueHigh < rows - 1 ? volumes[valueHigh + 1] : -1;
    const below = valueLow > 0 ? volumes[valueLow - 1] : -1;
    if (above >= below) inside += volumes[++valueHigh];
    else inside += volumes[--valueLow];
  }
  return { low, high, step, volumes, total, poc, valueLow, valueHigh };
}

/** Price at the middle of a row. */
export function rowPrice(p: VolumeProfile, row: number): number {
  return p.low + (row + 0.5) * p.step;
}

// ------------------------------------------------------------------ chart glue

const VALUE_AREA_COLOR = 'rgba(47,128,237,0.3)';
const OUTSIDE_COLOR = 'rgba(138,146,158,0.2)';
const POC_COLOR = 'rgba(227,160,8,0.7)';
/** Share of the pane width the histogram may use. */
const WIDTH_SHARE = 0.25;

interface Cached {
  from: number;
  to: number;
  rows: number;
  valueArea: number;
  profile: VolumeProfile | null;
}

/**
 * The indicator's calc returns a new (empty) array whenever the chart's data changes, so the
 * result array identifies the data version. A profile is kept per version and rebuilt only
 * when the visible range or the parameters change; crosshair moves and plain redraws reuse it.
 */
const cache = new WeakMap<object, Cached>();

function profileFor(chart: IndicatorDrawParams<unknown, number, unknown>['chart'], result: object, rows: number, valueArea: number): VolumeProfile | null {
  // realFrom/realTo follow the screen even when it is scrolled past the last bar.
  const range = chart.getVisibleRange();
  const from = Math.max(0, range.realFrom);
  const to = range.realTo;
  const hit = cache.get(result);
  if (hit && hit.from === from && hit.to === to && hit.rows === rows && hit.valueArea === valueArea) return hit.profile;
  const profile = volumeProfile(chart.getDataList(), rows, valueArea, from, to);
  cache.set(result, { from, to, rows, valueArea, profile });
  return profile;
}

export function profileParams(calcParams: number[]): { rows: number; valueArea: number } {
  const [rows = 24, valueArea = 70] = calcParams;
  return { rows: Math.min(500, Math.max(1, Math.round(rows))), valueArea: Math.min(100, Math.max(1, valueArea)) };
}

export function drawVolumeProfile({ ctx, chart, indicator, bounding, yAxis }: IndicatorDrawParams<unknown, number, unknown>): boolean {
  const { rows, valueArea } = profileParams(indicator.calcParams);
  const p = profileFor(chart, indicator.result, rows, valueArea);
  if (!p || p.total <= 0) return true;
  let max = 0;
  for (const v of p.volumes) max = Math.max(max, v);
  const maxWidth = bounding.width * WIDTH_SHARE;
  const right = bounding.width;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, bounding.width, bounding.height);
  ctx.clip();
  // Behind the candles, so they stay readable through the histogram.
  ctx.globalCompositeOperation = 'destination-over';
  for (let r = 0; r < p.volumes.length; r++) {
    const v = p.volumes[r];
    if (v <= 0) continue;
    const yTop = yAxis.convertToPixel(p.low + (r + 1) * p.step);
    const yBottom = yAxis.convertToPixel(p.low + r * p.step);
    const top = Math.min(yTop, yBottom);
    // One pixel of space between rows when they are tall enough to afford it.
    const height = Math.max(1, Math.abs(yBottom - yTop) - (Math.abs(yBottom - yTop) > 3 ? 1 : 0));
    const width = Math.max(1, (v / max) * maxWidth);
    ctx.fillStyle = r === p.poc ? POC_COLOR : r >= p.valueLow && r <= p.valueHigh ? VALUE_AREA_COLOR : OUTSIDE_COLOR;
    ctx.fillRect(Math.round(right - width), Math.round(top), Math.round(width), Math.max(1, Math.round(height)));
  }
  ctx.globalCompositeOperation = 'source-over';
  // The point of control as a line across the pane.
  const y = Math.round(yAxis.convertToPixel(rowPrice(p, p.poc))) + 0.5;
  ctx.strokeStyle = POC_COLOR;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(0, y);
  ctx.lineTo(right, y);
  ctx.stroke();
  ctx.restore();
  return true;
}

export function volumeProfileTooltip({ chart, indicator }: IndicatorCreateTooltipDataSourceParams<unknown>) {
  const params = indicator.calcParams as number[];
  const { rows, valueArea } = profileParams(params);
  const p = profileFor(chart, indicator.result, rows, valueArea);
  const precision = chart.getSymbol()?.pricePrecision ?? 2;
  const legend = (title: string, value: number | undefined, color: string) => ({
    title: { text: `${title}: `, color },
    value: { text: value === undefined ? 'n/a' : value.toFixed(precision), color },
  });
  return {
    name: indicator.shortName,
    calcParamsText: `(${params.join(',')})`,
    features: [],
    legends: p
      ? [
          legend('POC', rowPrice(p, p.poc), '#e3a008'),
          legend('VAH', p.low + (p.valueHigh + 1) * p.step, '#2f80ed'),
          legend('VAL', p.low + p.valueLow * p.step, '#2f80ed'),
        ]
      : [],
  };
}
