/**
 * Glue between a ScriptEngine and the chart engine: one generic indicator template whose
 * instances carry their own calc and draw callbacks.
 */
import { registerIndicator, type Chart, type IndicatorCreate, type IndicatorDrawParams, type IndicatorTooltipData, type KLineData } from 'klinecharts';
import type { RunResult, ScriptEngine, SymbolContext } from './engine';
import type { LineStyle, PlotOutput, ShapeOutput } from './outputs';

export const SCRIPT_INDICATOR = 'KANDLE_SCRIPT';
/** Draws a strategy's trades on the price chart when the strategy itself sits in its own pane. */
export const TRADES_INDICATOR = 'KANDLE_SCRIPT_TRADES';

let registered = false;

export function registerScriptIndicator(): void {
  if (registered) return;
  registered = true;
  registerIndicator({ name: SCRIPT_INDICATOR, shortName: 'Script', calc: () => [] });
  registerIndicator({ name: TRADES_INDICATOR, shortName: '', calc: () => [] });
}

type Row = Record<string, number | undefined>;

export interface ScriptIndicatorOptions {
  id: string;
  engine: ScriptEngine;
  symbol: () => SymbolContext;
  onRun: (result: RunResult) => void;
}

/** Decimal places for a separate pane, based on the size of the values it shows. */
export function autoPrecision(engine: ScriptEngine): number {
  if (engine.meta.precision !== null) return engine.meta.precision;
  if (engine.meta.format === 'volume') return 0;
  let max = 0;
  for (const p of engine.outputs.plots) {
    const vals = p.values;
    for (let i = Math.max(0, vals.length - 200); i < vals.length; i++) {
      const v = Math.abs(vals[i]);
      if (v === v && v > max) max = v;
    }
  }
  if (max === 0) return 2;
  if (max < 0.01) return 6;
  if (max < 1) return 4;
  return 2;
}

/** Everything the chart engine needs to create (or update) the indicator for a script. */
export function scriptIndicator(opts: ScriptIndicatorOptions): Omit<IndicatorCreate, 'paneId'> {
  const { engine } = opts;
  const overlay = engine.meta.overlay;
  const rows: Row[] = [];
  // Rows below this index are up to date. The engine may already have run (a test run
  // before the indicator was created), so this is tracked separately from the engine.
  let built = 0;
  const plots = engine.outputs.plots;
  const hlines = engine.outputs.hlines;

  const calc = (dataList: KLineData[]): Row[] => {
    engine.setSymbol(opts.symbol());
    const result = engine.run(dataList);
    opts.onRun(result);
    const n = engine.barCount;
    const from = result.incremental ? Math.max(0, Math.min(built, n - result.barsRun)) : 0;
    rows.length = n;
    for (let i = from; i < n; i++) {
      const row: Row = {};
      for (const p of plots) {
        if (!p.visible) continue;
        const v = p.values[i - p.offset];
        if (v !== undefined && v === v) row[`p${p.index}`] = v;
      }
      if (!overlay) {
        for (const h of hlines) if (h.price === h.price) row[`h${h.index}`] = h.price;
      }
      rows[i] = row;
    }
    built = result.error ? 0 : n;
    return rows;
  };

  const figures = [...plots.map((p) => ({ key: `p${p.index}` })), ...(overlay ? [] : hlines.map((h) => ({ key: `h${h.index}` })))];

  const create: Omit<IndicatorCreate<Row>, 'paneId'> = {
    name: SCRIPT_INDICATOR,
    id: opts.id,
    shortName: engine.meta.shortTitle,
    series: overlay ? 'price' : 'normal',
    precision: overlay ? undefined : autoPrecision(engine),
    shouldOhlc: overlay,
    figures,
    calc,
    draw: (params) => {
      drawScript(params, engine);
      return true;
    },
    createTooltipDataSource: ({ indicator, crosshair }): IndicatorTooltipData => {
      const i = crosshair.dataIndex ?? engine.barCount - 1;
      const values = engine.inputs
        .filter((d) => d.type !== 'color' && d.type !== 'bool')
        .map((d) => String(engine.inputValues()[d.key]))
        .slice(0, 6);
      const legends = plots
        .filter((p) => p.visible && p.title)
        .slice(0, 8)
        .map((p) => {
          const v = p.values[i - p.offset];
          const color = plotColor(p, i - p.offset) ?? p.color;
          return {
            title: { text: `${p.title}: `, color },
            value: { text: v === undefined || v !== v ? 'n/a' : v.toFixed(indicator.precision), color },
          };
        });
      return {
        name: engine.lastError ? `${engine.meta.shortTitle} (error)` : engine.meta.shortTitle,
        calcParamsText: values.length ? `(${values.join(', ')})` : '',
        features: [],
        legends,
      };
    },
  };
  return create as unknown as Omit<IndicatorCreate, 'paneId'>;
}

// ------------------------------------------------------------------ drawing

function plotColor(p: PlotOutput, i: number): string | null {
  if (p.colors.length === 0) return p.color;
  const c = p.colors[i];
  return c === undefined ? p.color : c;
}

function dash(ctx: CanvasRenderingContext2D, style: LineStyle, width: number): void {
  if (style === 'dashed') ctx.setLineDash([Math.max(4, width * 4), Math.max(3, width * 3)]);
  else if (style === 'dotted') ctx.setLineDash([Math.max(1, width), Math.max(2, width * 2)]);
  else ctx.setLineDash([]);
}

interface View {
  ctx: CanvasRenderingContext2D;
  x: (i: number) => number;
  y: (v: number) => number;
  from: number;
  to: number;
  bar: number;
  gap: number;
  width: number;
  height: number;
}

function drawScript(params: IndicatorDrawParams<Row, unknown, unknown>, engine: ScriptEngine): void {
  const { ctx, chart, bounding, xAxis, yAxis } = params;
  const n = engine.barCount;
  if (n === 0) return;
  const range = chart.getVisibleRange();
  const space = chart.getBarSpace();
  const o = engine.outputs;
  let maxOffset = 0;
  for (const p of o.plots) maxOffset = Math.max(maxOffset, Math.abs(p.offset));
  const view: View = {
    ctx,
    x: (i) => xAxis.convertToPixel(i),
    y: (v) => yAxis.convertToPixel(v),
    from: Math.max(0, Math.floor(range.from) - 2 - maxOffset),
    to: Math.min(n - 1, Math.ceil(range.to) + 1 + maxOffset),
    bar: space.bar,
    gap: space.gapBar,
    width: bounding.width,
    height: bounding.height,
  };
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, bounding.width, bounding.height);
  ctx.clip();
  for (const bg of o.backgrounds) drawBackground(view, bg.colors, bg.offset);
  for (const f of o.fills) drawFill(view, engine, f);
  for (const h of o.hlines) {
    if (h.price !== h.price || !h.color) continue;
    const y = Math.round(view.y(h.price)) + 0.5;
    ctx.strokeStyle = h.color;
    ctx.lineWidth = h.linewidth;
    dash(ctx, h.lineStyle, h.linewidth);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(view.width, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  for (const p of o.plots) if (p.visible) drawPlot(view, p);
  for (const s of o.shapes) drawShapes(view, engine, s, engine.meta.overlay);
  if (engine.meta.overlay) for (const bc of o.barColors) drawBarColors(view, engine, bc.colors, bc.offset);
  if (engine.meta.overlay) drawTrades(view, engine);
  ctx.restore();
}

/** The indicator that shows a pane strategy's trades on the price chart. */
export function tradesIndicator(id: string, engine: ScriptEngine): Omit<IndicatorCreate, 'paneId'> {
  return {
    name: TRADES_INDICATOR,
    id,
    shortName: '',
    series: 'price',
    figures: [],
    calc: () => [],
    draw: ({ ctx, chart, bounding, xAxis, yAxis }) => {
      const n = engine.barCount;
      if (n === 0) return true;
      const range = chart.getVisibleRange();
      const space = chart.getBarSpace();
      const view: View = {
        ctx,
        x: (i) => xAxis.convertToPixel(i),
        y: (v) => yAxis.convertToPixel(v),
        from: Math.max(0, Math.floor(range.from) - 2),
        to: Math.min(n - 1, Math.ceil(range.to) + 1),
        bar: space.bar,
        gap: space.gapBar,
        width: bounding.width,
        height: bounding.height,
      };
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, bounding.width, bounding.height);
      ctx.clip();
      drawTrades(view, engine);
      ctx.restore();
      return true;
    },
    createTooltipDataSource: () => ({ name: '', calcParamsText: '', features: [], legends: [] }),
  };
}

export const BUY_COLOR = '#2962ff';
export const SELL_COLOR = '#e91e63';
const WIN_COLOR = 'rgba(34,171,148,0.75)';
const LOSS_COLOR = 'rgba(242,54,69,0.75)';

/**
 * Strategy fills as arrows (buys below the bar, sells above) labelled with the order's
 * signal, and a dashed line from each entry to its exit, green for a win and red for a loss.
 */
function drawTrades(v: View, engine: ScriptEngine): void {
  const report = engine.strategy;
  if (!report) return;
  const { ctx } = v;
  const bars = engine.bars;
  const n = engine.barCount;

  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  for (const t of report.trades) {
    if (t.exitBar < v.from || t.entryBar > v.to) continue;
    ctx.strokeStyle = t.pnl >= 0 ? WIN_COLOR : LOSS_COLOR;
    ctx.beginPath();
    ctx.moveTo(v.x(t.entryBar), v.y(t.entryPrice));
    ctx.lineTo(v.x(t.exitBar), v.y(t.exitPrice));
    ctx.stroke();
  }
  // Open trades: a dotted line at the entry price up to the last bar.
  ctx.setLineDash([2, 3]);
  for (const t of report.openTrades) {
    if (t.entryBar > v.to) continue;
    ctx.strokeStyle = t.direction === 'long' ? BUY_COLOR : SELL_COLOR;
    const y = Math.round(v.y(t.entryPrice)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(v.x(t.entryBar), y);
    ctx.lineTo(v.x(n - 1), y);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // One marker per bar and side, listing each distinct label once.
  const groups = new Map<number, { bar: number; side: 1 | -1; labels: string[] }>();
  for (const f of report.fills) {
    if (f.bar < v.from || f.bar > v.to) continue;
    const key = f.bar * 2 + (f.side > 0 ? 0 : 1);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { bar: f.bar, side: f.side, labels: [] }));
    if (!g.labels.includes(f.label)) g.labels.push(f.label);
  }
  const size = Math.max(6, Math.min(9, v.bar * 0.9));
  const tagH = 15;
  ctx.font = '600 10px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const g of groups.values()) {
    const x = v.x(g.bar);
    const buy = g.side > 0;
    const color = buy ? BUY_COLOR : SELL_COLOR;
    // Arrow pointing at the bar, then a tag with the signal names beyond it.
    const tip = buy ? v.y(bars.low[g.bar]) + 3 : v.y(bars.high[g.bar]) - 3;
    const base = buy ? tip + size : tip - size;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, tip);
    ctx.lineTo(x + size * 0.65, base);
    ctx.lineTo(x - size * 0.65, base);
    ctx.closePath();
    ctx.fill();
    const raw = g.labels.join(', ');
    const text = raw.length > 24 ? `${raw.slice(0, 23)}…` : raw;
    const w = Math.ceil(ctx.measureText(text).width) + 8;
    const top = buy ? base + 2 : base - 2 - tagH;
    ctx.beginPath();
    ctx.roundRect(Math.round(x - w / 2), Math.round(top), w, tagH, 3);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, x, Math.round(top) + tagH / 2 + 0.5);
  }
}

function drawBackground(v: View, colors: Array<string | null | undefined>, offset: number): void {
  const { ctx } = v;
  const w = Math.max(1, v.bar);
  for (let i = v.from; i <= v.to; i++) {
    const c = colors[i - offset];
    if (!c) continue;
    ctx.fillStyle = c;
    const x = v.x(i);
    ctx.fillRect(Math.floor(x - w / 2), 0, Math.ceil(w), v.height);
  }
}

function seriesFor(engine: ScriptEngine, ref: { kind: 'plot' | 'hline'; index: number }): ((i: number) => number) | null {
  if (ref.kind === 'hline') {
    const h = engine.outputs.hlines[ref.index];
    return h ? () => h.price : null;
  }
  const p = engine.outputs.plots[ref.index];
  if (!p) return null;
  return (i) => {
    const val = p.values[i - p.offset];
    return val === undefined ? NaN : val;
  };
}

function drawFill(v: View, engine: ScriptEngine, f: ScriptEngineFill): void {
  if (!f.from || !f.to) return;
  const a = seriesFor(engine, f.from);
  const b = seriesFor(engine, f.to);
  if (!a || !b) return;
  const { ctx } = v;
  const colorAt = (i: number) => (f.colors.length > 0 ? f.colors[i] : f.color);
  if (f.from.kind === 'hline') {
    const c = colorAt(engine.barCount - 1) ?? f.color;
    if (!c) return;
    const y1 = v.y(a(0));
    const y2 = v.y(b(0));
    if (y1 !== y1 || y2 !== y2) return;
    ctx.fillStyle = c;
    ctx.fillRect(0, Math.min(y1, y2), v.width, Math.abs(y2 - y1));
    return;
  }
  let current: string | null = null;
  ctx.beginPath();
  const flush = () => {
    if (current) {
      ctx.fillStyle = current;
      ctx.fill();
    }
    ctx.beginPath();
  };
  for (let i = Math.max(1, v.from); i <= v.to; i++) {
    const a0 = a(i - 1);
    const a1 = a(i);
    const b0 = b(i - 1);
    const b1 = b(i);
    if (a0 !== a0 || a1 !== a1 || b0 !== b0 || b1 !== b1) continue;
    const c = colorAt(i);
    if (!c) continue;
    if (c !== current) {
      flush();
      current = c;
    }
    const x0 = v.x(i - 1);
    const x1 = v.x(i);
    ctx.moveTo(x0, v.y(a0));
    ctx.lineTo(x1, v.y(a1));
    ctx.lineTo(x1, v.y(b1));
    ctx.lineTo(x0, v.y(b0));
    ctx.closePath();
  }
  flush();
}

type ScriptEngineFill = ScriptEngine['outputs']['fills'][number];

function drawPlot(v: View, p: PlotOutput): void {
  const { ctx } = v;
  const val = (i: number) => {
    const x = p.values[i];
    return x === undefined ? NaN : x;
  };
  // Bars are stored by source index; plotting shifts them right by `offset`.
  const from = v.from - p.offset;
  const to = v.to - p.offset;
  const px = (i: number) => v.x(i + p.offset);
  ctx.lineWidth = p.linewidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'butt';

  switch (p.style) {
    case 'line':
    case 'linebr':
    case 'stepline':
    case 'area':
    case 'areabr': {
      const bridge = p.style === 'line' || p.style === 'stepline' || p.style === 'area';
      const step = p.style === 'stepline';
      const area = p.style === 'area' || p.style === 'areabr';
      const baseY = v.y(p.histbase);
      let prevI = -1;
      // Start from the last valid point before the visible range so the line enters smoothly.
      for (let i = from - 1; i >= Math.max(0, from - 500); i--) {
        if (val(i) === val(i)) {
          prevI = i;
          break;
        }
      }
      let current: string | null = null;
      ctx.beginPath();
      const flush = () => {
        if (current) {
          ctx.strokeStyle = current;
          ctx.stroke();
        }
        ctx.beginPath();
      };
      for (let i = Math.max(0, from); i <= to; i++) {
        const y = val(i);
        if (y !== y) {
          if (!bridge) prevI = -1;
          continue;
        }
        if (prevI >= 0) {
          const c = plotColor(p, i);
          if (c) {
            const x0 = px(prevI);
            const y0 = v.y(val(prevI));
            const x1 = px(i);
            const y1 = v.y(y);
            if (area) {
              ctx.save();
              ctx.globalAlpha = 0.18;
              ctx.fillStyle = c;
              ctx.beginPath();
              ctx.moveTo(x0, y0);
              ctx.lineTo(x1, y1);
              ctx.lineTo(x1, baseY);
              ctx.lineTo(x0, baseY);
              ctx.closePath();
              ctx.fill();
              ctx.restore();
            }
            if (c !== current) {
              flush();
              current = c;
            }
            ctx.moveTo(x0, y0);
            if (step) {
              ctx.lineTo(x1, y0);
              ctx.lineTo(x1, y1);
            } else {
              ctx.lineTo(x1, y1);
            }
          }
        }
        prevI = i;
      }
      flush();
      break;
    }
    case 'histogram': {
      const baseY = v.y(p.histbase);
      for (let i = Math.max(0, from); i <= to; i++) {
        const y = val(i);
        const c = plotColor(p, i);
        if (y !== y || !c) continue;
        const x = Math.round(px(i)) + (p.linewidth % 2 ? 0.5 : 0);
        ctx.strokeStyle = c;
        ctx.beginPath();
        ctx.moveTo(x, baseY);
        ctx.lineTo(x, v.y(y));
        ctx.stroke();
      }
      break;
    }
    case 'columns': {
      const baseY = v.y(p.histbase);
      const w = Math.max(1, v.gap);
      for (let i = Math.max(0, from); i <= to; i++) {
        const y = val(i);
        const c = plotColor(p, i);
        if (y !== y || !c) continue;
        const yy = v.y(y);
        ctx.fillStyle = c;
        ctx.fillRect(px(i) - w / 2, Math.min(yy, baseY), w, Math.max(1, Math.abs(baseY - yy)));
      }
      break;
    }
    case 'circles':
    case 'cross': {
      const r = Math.max(1.5, p.linewidth + 1);
      for (let i = Math.max(0, from); i <= to; i++) {
        const y = val(i);
        const c = plotColor(p, i);
        if (y !== y || !c) continue;
        const x = px(i);
        const yy = v.y(y);
        if (p.style === 'circles') {
          ctx.fillStyle = c;
          ctx.beginPath();
          ctx.arc(x, yy, r, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.strokeStyle = c;
          ctx.lineWidth = Math.max(1, p.linewidth);
          ctx.beginPath();
          ctx.moveTo(x - r - 1, yy);
          ctx.lineTo(x + r + 1, yy);
          ctx.moveTo(x, yy - r - 1);
          ctx.lineTo(x, yy + r + 1);
          ctx.stroke();
        }
      }
      break;
    }
  }
}

function drawShapes(v: View, engine: ScriptEngine, s: ShapeOutput, overlay: boolean): void {
  const { ctx } = v;
  const bars = engine.bars;
  const size = s.size;
  const pad = 4;
  const from = v.from - s.offset;
  const to = v.to - s.offset;
  for (let i = Math.max(0, from); i <= to; i++) {
    const value = s.values[i];
    if (value === undefined || value !== value) continue;
    const color = s.colors.length > 0 ? s.colors[i] : s.color;
    if (!color) continue;
    const x = v.x(i + s.offset);
    let y: number;
    let above: boolean;
    switch (s.location) {
      case 'abovebar':
        above = true;
        y = overlay ? v.y(bars.high[i]) - pad - size / 2 : pad + size / 2;
        break;
      case 'belowbar':
        above = false;
        y = overlay ? v.y(bars.low[i]) + pad + size / 2 : v.height - pad - size / 2;
        break;
      case 'top':
        above = true;
        y = pad + size / 2;
        break;
      case 'bottom':
        above = false;
        y = v.height - pad - size / 2;
        break;
      default:
        above = true;
        y = v.y(value);
    }
    if (s.char !== null) {
      ctx.fillStyle = color;
      ctx.font = `${Math.round(size * 1.3)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(s.char, x, y);
    } else {
      drawShape(ctx, s.style, x, y, size, color);
    }
    if (s.text) {
      const tc = (s.textColors.length > 0 ? s.textColors[i] : s.textColor) ?? color;
      ctx.fillStyle = tc;
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = above ? 'bottom' : 'top';
      const lines = s.text.split('\n');
      lines.forEach((line, k) => {
        const offset = above ? -(size / 2 + 2) - (lines.length - 1 - k) * 12 : size / 2 + 2 + k * 12;
        ctx.fillText(line, x, y + offset);
      });
    }
  }
}

function drawShape(ctx: CanvasRenderingContext2D, style: ShapeOutput['style'], x: number, y: number, size: number, color: string): void {
  const h = size / 2;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, size / 7);
  ctx.beginPath();
  switch (style) {
    case 'circle':
      ctx.arc(x, y, h, 0, Math.PI * 2);
      ctx.fill();
      return;
    case 'square':
      ctx.fillRect(x - h, y - h, size, size);
      return;
    case 'diamond':
      ctx.moveTo(x, y - h);
      ctx.lineTo(x + h, y);
      ctx.lineTo(x, y + h);
      ctx.lineTo(x - h, y);
      ctx.closePath();
      ctx.fill();
      return;
    case 'triangleup':
    case 'labelup':
      ctx.moveTo(x, y - h);
      ctx.lineTo(x + h, y + h);
      ctx.lineTo(x - h, y + h);
      ctx.closePath();
      ctx.fill();
      return;
    case 'triangledown':
    case 'labeldown':
      ctx.moveTo(x, y + h);
      ctx.lineTo(x + h, y - h);
      ctx.lineTo(x - h, y - h);
      ctx.closePath();
      ctx.fill();
      return;
    case 'arrowup':
      ctx.moveTo(x, y - h);
      ctx.lineTo(x + h, y);
      ctx.lineTo(x + h / 3, y);
      ctx.lineTo(x + h / 3, y + h);
      ctx.lineTo(x - h / 3, y + h);
      ctx.lineTo(x - h / 3, y);
      ctx.lineTo(x - h, y);
      ctx.closePath();
      ctx.fill();
      return;
    case 'arrowdown':
      ctx.moveTo(x, y + h);
      ctx.lineTo(x + h, y);
      ctx.lineTo(x + h / 3, y);
      ctx.lineTo(x + h / 3, y - h);
      ctx.lineTo(x - h / 3, y - h);
      ctx.lineTo(x - h / 3, y);
      ctx.lineTo(x - h, y);
      ctx.closePath();
      ctx.fill();
      return;
    case 'flag':
      ctx.moveTo(x - h, y + h);
      ctx.lineTo(x - h, y - h);
      ctx.lineTo(x + h, y - h / 3);
      ctx.lineTo(x - h, y + h / 3);
      ctx.stroke();
      ctx.fill();
      return;
    case 'cross':
      ctx.moveTo(x - h, y);
      ctx.lineTo(x + h, y);
      ctx.moveTo(x, y - h);
      ctx.lineTo(x, y + h);
      ctx.stroke();
      return;
    default:
      // xcross
      ctx.moveTo(x - h, y - h);
      ctx.lineTo(x + h, y + h);
      ctx.moveTo(x + h, y - h);
      ctx.lineTo(x - h, y + h);
      ctx.stroke();
  }
}

function drawBarColors(v: View, engine: ScriptEngine, colors: Array<string | null | undefined>, offset: number): void {
  const { ctx } = v;
  const b = engine.bars;
  const w = Math.max(1, v.gap);
  for (let i = v.from; i <= v.to; i++) {
    const c = colors[i - offset];
    if (!c) continue;
    const x = v.x(i);
    const yo = v.y(b.open[i]);
    const yc = v.y(b.close[i]);
    ctx.strokeStyle = c;
    ctx.fillStyle = c;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const xs = Math.round(x) + 0.5;
    ctx.moveTo(xs, v.y(b.high[i]));
    ctx.lineTo(xs, v.y(b.low[i]));
    ctx.stroke();
    ctx.fillRect(x - w / 2, Math.min(yo, yc), w, Math.max(1, Math.abs(yc - yo)));
  }
}

/** Builds the symbol context scripts see (syminfo.*, timeframe.*). */
export function symbolContext(ticker: string, periodMs: number, pricePrecision: number, source?: string): SymbolContext {
  const seconds = Math.round(periodMs / 1000);
  let period: string;
  if (seconds >= 604800 && seconds % 604800 === 0) period = seconds === 604800 ? 'W' : `${seconds / 604800}W`;
  else if (seconds >= 86400 && seconds % 86400 === 0) period = seconds === 86400 ? 'D' : `${seconds / 86400}D`;
  else period = String(Math.max(1, Math.round(seconds / 60)));
  return { ticker, period, periodSeconds: seconds, mintick: 10 ** -pricePrecision, source };
}

export type { Chart };
