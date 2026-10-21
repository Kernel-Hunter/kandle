/**
 * What embed mode shows and where it keeps things, without the DOM. An embed keeps everything
 * in memory: it never reads the viewer's saved chart, symbol lists or API keys, and never
 * writes to browser storage.
 */
import { DEFAULT_CHART_STYLE, type ChartStyle } from '../chart/chartStyle';
import { CsvStore, setCsvStore } from '../data/csv';
import { KeyStore, setKeyStore } from '../data/keys';
import type { TimeframeId } from '../data/timeframes';
import { DEFAULT_PANES, type ChartCount, type SyncOptions } from '../layout/config';
import type { SharedChart, SharedRange } from '../share/codec';
import { MemoryStorage, type DrawingRecord, type KeyValueStorage } from '../store/layout';

/** Points the app-wide API key and CSV stores at memory and returns a memory storage for the rest. */
export function isolateStorage(): KeyValueStorage {
  const memory = new MemoryStorage();
  setKeyStore(new KeyStore(memory));
  setCsvStore(new CsvStore(memory));
  return memory;
}

/** One chart of an embed. */
export interface EmbedPane {
  source: string;
  symbol: string;
  timeframe: TimeframeId;
  style: ChartStyle;
  indicators: Array<{ name: string; params: number[] }>;
  drawings: DrawingRecord[];
  range?: SharedRange;
}

export interface EmbedLayout {
  count: ChartCount;
  sync: SyncOptions;
  /** The main chart first, then the others in reading order. */
  panes: EmbedPane[];
}

/**
 * The charts a link shows. Only what the link carries: a link without indicators shows none,
 * and a layout pane the link leaves out gets the app's default for that pane.
 */
export function embedLayout(chart: SharedChart): EmbedLayout {
  const main: EmbedPane = {
    source: chart.source,
    symbol: chart.symbol,
    timeframe: chart.timeframe,
    style: { ...(chart.style ?? DEFAULT_CHART_STYLE) },
    indicators: (chart.indicators ?? []).map((i) => ({ name: i.name, params: [...i.params] })),
    drawings: chart.drawings ?? [],
    ...(chart.range ? { range: { ...chart.range } } : {}),
  };
  const count = chart.layout?.count ?? 1;
  const others = Array.from({ length: count - 1 }, (_, i): EmbedPane => {
    const p = chart.layout?.panes[i] ?? DEFAULT_PANES[i];
    return {
      source: p.source,
      symbol: p.symbol,
      timeframe: p.timeframe,
      style: { type: p.chartType ?? DEFAULT_CHART_STYLE.type, scale: p.scale ?? DEFAULT_CHART_STYLE.scale },
      indicators: p.indicators.map((i) => ({ name: i.name, params: [...i.params] })),
      drawings: [],
    };
  });
  return { count, sync: { ...(chart.layout?.sync ?? { crosshair: false, timeframe: false, symbol: false }) }, panes: [main, ...others] };
}
