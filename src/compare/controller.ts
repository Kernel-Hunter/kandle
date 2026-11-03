/**
 * Draws compared symbols on a chart's price pane. Each one is a chart engine indicator whose
 * values come from a series loaded through the same feeds as request.security, lined up with
 * the chart's bars and rescaled whenever the first bar on screen changes (src/compare/series.ts).
 */
import { registerIndicator, type Chart, type IndicatorCreateTooltipDataSourceParams, type KLineData } from 'klinecharts';
import { getSource } from '../data/sources';
import type { TimeframeId } from '../data/timeframes';
import type { RequestSeries, ResolvedRequest } from '../script/security';
import { requestKey } from '../script/security';
import {
  COMPARE_COLORS,
  MAX_COMPARE,
  alignCloses,
  anchorIndex,
  changeSince,
  rebaseFactor,
  sameCompare,
  type CompareSymbol,
} from './series';

export const COMPARE_INDICATOR = 'KANDLE_COMPARE';

/** What the controller needs from the feeds that also serve request.security (src/data/feeds.ts). */
export interface CompareFeeds {
  series(req: ResolvedRequest): RequestSeries | null;
  need(req: ResolvedRequest, from: number): void;
  load(req: ResolvedRequest, from: number): Promise<void>;
  onChange(fn: (key: string) => void): () => void;
}

export interface CompareHost {
  chart(): Chart;
  paneId: string;
  feeds: CompareFeeds;
  timeframe(): TimeframeId;
  /** Called with the list after the user or an agent changed it. */
  onChange?(list: CompareSymbol[]): void;
}

/** One compared symbol as the UI and the agent bridge report it. */
export interface CompareReport extends CompareSymbol {
  color: string;
  /** Last close of the compared symbol, or null while it loads. */
  last: number | null;
  /** Change of the compared symbol since the first bar on screen, in percent. */
  changePercent: number | null;
  /** Why the series could not be loaded. */
  error?: string;
  loading: boolean;
}

interface Row {
  close?: number;
}

interface Line extends CompareSymbol {
  /** Looks the line up from its indicator (extendData). */
  key: string;
  indicatorId: string;
  color: string;
  /** Compared close per chart bar from the last calculation; NaN where there is none. */
  raw: Float64Array;
  /** Index the line was last scaled from. */
  anchor: number;
  version: number;
}

/** Lines by the key in their indicator's extendData. The engine's calc callback looks them up here. */
const lines = new Map<string, { line: Line; controller: CompareController }>();
let nextKey = 1;
let registered = false;

function registerCompareIndicator(): void {
  if (registered) return;
  registered = true;
  registerIndicator<Row, number, string>({
    name: COMPARE_INDICATOR,
    shortName: 'Compare',
    series: 'price',
    calcParams: [0],
    figures: [{ key: 'close', title: '', type: 'line' }],
    calc: (data, indicator) => {
      const entry = lines.get(indicator.extendData);
      return entry ? entry.controller.calc(entry.line, data) : [];
    },
    createTooltipDataSource: (params) => {
      const entry = lines.get(params.indicator.extendData as string);
      return entry
        ? entry.controller.tooltip(entry.line, params)
        : { name: '', calcParamsText: '', features: [], legends: [] };
    },
  });
}

const fmt = (v: number, precision: number) => v.toLocaleString('en-US', { minimumFractionDigits: precision, maximumFractionDigits: precision });

/** 2 decimals from 1 up, more below so small prices keep about 4 significant digits. */
export function digitsFor(v: number): number {
  if (!(v > 0) || v >= 1) return 2;
  return Math.min(8, 3 - Math.floor(Math.log10(v)));
}

export class CompareController {
  private items: Line[] = [];
  private readonly offFeeds: () => void;
  private readonly onRange = () => this.rebaseAll();

  constructor(private readonly host: CompareHost) {
    registerCompareIndicator();
    this.offFeeds = host.feeds.onChange((key) => {
      for (const line of this.items) if (requestKey(this.request(line)) === key) this.recalc(line);
    });
    host.chart().subscribeAction('onVisibleRangeChange', this.onRange);
  }

  list(): CompareSymbol[] {
    return this.items.map((l) => ({ source: l.source, symbol: l.symbol }));
  }

  has(item: CompareSymbol): boolean {
    return this.items.some((l) => sameCompare(l, item));
  }

  get size(): number {
    return this.items.length;
  }

  /** Adds lines without reporting a change, e.g. from the saved layout. */
  restore(list: readonly CompareSymbol[]): void {
    for (const item of list) this.addLine(item);
  }

  /**
   * Adds a compared symbol. Throws when the list is full or already has it. Resolves when its
   * first history has loaded (or failed to), so callers can report the line.
   */
  async add(item: CompareSymbol): Promise<CompareReport> {
    if (this.has(item)) throw new Error(`${item.symbol} on ${getSource(item.source).name} is already compared`);
    if (this.items.length >= MAX_COMPARE) throw new Error(`At most ${MAX_COMPARE} symbols can be compared. Remove one first.`);
    const line = this.addLine(item);
    this.host.onChange?.(this.list());
    const first = this.host.chart().getDataList()[0]?.timestamp ?? Date.now();
    await this.host.feeds.load(this.request(line), first);
    // The engine runs calc in the background; line the series up now so the report has numbers.
    const data = this.host.chart().getDataList();
    this.align(line, data);
    this.fill(line, data.map(() => ({})), data.map((d) => d.close));
    this.recalc(line);
    return this.report().find((r) => sameCompare(r, line))!;
  }

  /** Removes one compared symbol. Returns false when it was not on the chart. */
  remove(item: CompareSymbol): boolean {
    const line = this.items.find((l) => sameCompare(l, item));
    if (!line) return false;
    this.drop(line);
    this.host.onChange?.(this.list());
    return true;
  }

  /** Removes every compared symbol and returns how many there were. */
  clear(): number {
    const count = this.items.length;
    for (const line of [...this.items]) this.drop(line);
    if (count) this.host.onChange?.(this.list());
    return count;
  }

  /** Each line with its color, last close and change since the left edge of the chart. */
  report(): CompareReport[] {
    const chart = this.host.chart();
    const n = chart.getDataList().length;
    const to = Math.min(n, chart.getVisibleRange().to) - 1;
    return this.items.map((line) => {
      const series = this.host.feeds.series(this.request(line));
      const bars = series?.bars ?? [];
      const report: CompareReport = {
        source: line.source,
        symbol: line.symbol,
        color: line.color,
        last: bars.length ? bars[bars.length - 1].close : null,
        changePercent: changeSince(line.raw, line.anchor, Math.min(to, line.raw.length - 1)),
        loading: !series,
      };
      if (series?.error) report.error = series.error;
      return report;
    });
  }

  dispose(): void {
    this.offFeeds();
    this.host.chart().unsubscribeAction('onVisibleRangeChange', this.onRange);
    for (const line of [...this.items]) this.drop(line);
  }

  // ---------------------------------------------------------------- engine callbacks

  /** The indicator's values: the compared closes scaled to the chart's price at the anchor. */
  calc(line: Line, data: KLineData[]): Row[] {
    const req = this.request(line);
    if (data.length > 0) this.host.feeds.need(req, data[0].timestamp);
    this.align(line, data);
    const rows: Row[] = data.map(() => ({}));
    this.fill(line, rows, data.map((d) => d.close));
    return rows;
  }

  tooltip(line: Line, { crosshair }: IndicatorCreateTooltipDataSourceParams<Row>) {
    const n = line.raw.length;
    const index = typeof crosshair.dataIndex === 'number' ? Math.min(n - 1, crosshair.dataIndex) : n - 1;
    const close = index >= 0 ? line.raw[index] : Number.NaN;
    const change = changeSince(line.raw, line.anchor, index);
    const series = this.host.feeds.series(this.request(line));
    const text = series?.error
      ? 'could not load'
      : !series
        ? 'loading'
        : Number.isFinite(close)
          ? `${fmt(close, digitsFor(close))}${change === null ? '' : `  ${change >= 0 ? '+' : ''}${change.toFixed(2)}%`}`
          : 'n/a';
    return {
      name: line.symbol,
      calcParamsText: ` ${getSource(line.source).name}`,
      features: [],
      legends: [{ title: { text: '', color: line.color }, value: { text, color: line.color } }],
    };
  }

  // ---------------------------------------------------------------- internals

  /** The compared closes for the chart's bars, from what the feeds have loaded. */
  private align(line: Line, data: readonly KLineData[]): void {
    const series = this.host.feeds.series(this.request(line));
    line.raw = alignCloses(data.map((d) => d.timestamp), series?.bars ?? []);
  }

  private request(item: CompareSymbol): ResolvedRequest {
    return { source: item.source, symbol: item.symbol, timeframe: this.host.timeframe() };
  }

  private addLine(item: CompareSymbol): Line {
    const existing = this.items.find((l) => sameCompare(l, item));
    if (existing) return existing;
    if (this.items.length >= MAX_COMPARE) throw new Error(`At most ${MAX_COMPARE} symbols can be compared`);
    const used = new Set(this.items.map((l) => l.color));
    const color = COMPARE_COLORS.find((c) => !used.has(c)) ?? COMPARE_COLORS[this.items.length % COMPARE_COLORS.length];
    const key = `cmp${nextKey++}`;
    const line: Line = { source: item.source, symbol: item.symbol, key, indicatorId: '', color, raw: new Float64Array(0), anchor: -1, version: 0 };
    lines.set(key, { line, controller: this });
    const id = this.host.chart().createIndicator(
      {
        name: COMPARE_INDICATOR,
        shortName: item.symbol,
        calcParams: [0],
        extendData: key,
        figures: [{ key: 'close', title: '', type: 'line', styles: () => ({ color, size: 2 }) }],
        paneId: this.host.paneId,
      },
      true,
    );
    if (!id) {
      lines.delete(key);
      throw new Error('The chart could not add the line');
    }
    line.indicatorId = id;
    this.items.push(line);
    return line;
  }

  private drop(line: Line): void {
    this.host.chart().removeIndicator({ id: line.indicatorId });
    lines.delete(line.key);
    this.items = this.items.filter((l) => l !== line);
  }

  /** Runs the indicator's calc again, after its series loaded more bars. */
  private recalc(line: Line): void {
    line.version++;
    this.host.chart().overrideIndicator({ name: COMPARE_INDICATOR, id: line.indicatorId, calcParams: [line.version] });
  }

  /** Writes the scaled values into `rows` for the current first bar on screen. */
  private fill(line: Line, rows: Row[], main: readonly number[]): void {
    const from = this.host.chart().getVisibleRange().from;
    const anchor = anchorIndex(line.raw, main, from);
    line.anchor = anchor;
    const factor = rebaseFactor(line.raw, main, anchor);
    const n = Math.min(rows.length, line.raw.length);
    for (let i = 0; i < n; i++) {
      const v = line.raw[i] * factor;
      if (Number.isFinite(v)) rows[i].close = v;
      else delete rows[i].close;
    }
  }

  /**
   * The chart engine reads indicator values to size the price axis right after the visible
   * range changes, in the same call, so scaling the lines here keeps the axis in step.
   */
  private rebaseAll(): void {
    const chart = this.host.chart();
    const data = chart.getDataList();
    if (this.items.length === 0 || data.length === 0) return;
    const main = data.map((d) => d.close);
    const from = chart.getVisibleRange().from;
    for (const line of this.items) {
      const ind = chart.getIndicators({ id: line.indicatorId })[0];
      const rows = ind?.result as Row[] | undefined;
      if (!rows || rows.length !== data.length || line.raw.length !== data.length) continue;
      if (anchorIndex(line.raw, main, from) === line.anchor) continue;
      this.fill(line, rows, main);
    }
  }
}
