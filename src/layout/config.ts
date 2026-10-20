import { isChartType, isPriceScale, type ChartType, type PriceScale } from '../chart/chartStyle';
import { APP } from '../config';
import { isTimeframeId, type TimeframeId } from '../data/timeframes';
import type { KeyValueStorage } from '../store/layout';

export type ChartCount = 1 | 2 | 4;

export interface PaneConfig {
  source: string;
  symbol: string;
  timeframe: TimeframeId;
  indicators: Array<{ name: string; params: number[] }>;
  /** How bars are drawn; candles when left out. */
  chartType?: ChartType;
  /** Price axis scale; normal when left out. */
  scale?: PriceScale;
}

export interface SyncOptions {
  crosshair: boolean;
  timeframe: boolean;
  symbol: boolean;
}

export interface MultiChartConfig {
  version: 1;
  count: ChartCount;
  sync: SyncOptions;
  /** Settings for panes 2 to 4. Pane 1 is the main chart and keeps its own layout. */
  panes: PaneConfig[];
}

export const EXTRA_PANES = 3;

export const DEFAULT_PANES: readonly PaneConfig[] = [
  { source: 'binance', symbol: 'ETHUSDT', timeframe: '1h', indicators: [] },
  { source: 'binance', symbol: 'SOLUSDT', timeframe: '1h', indicators: [] },
  { source: 'binance', symbol: 'BNBUSDT', timeframe: '1h', indicators: [] },
];

export function defaultConfig(): MultiChartConfig {
  return {
    version: 1,
    count: 1,
    sync: { crosshair: true, timeframe: false, symbol: false },
    panes: DEFAULT_PANES.map((p) => ({ ...p, indicators: [] })),
  };
}

export function isChartCount(v: unknown): v is ChartCount {
  return v === 1 || v === 2 || v === 4;
}

function sanitizePane(raw: unknown, fallback: PaneConfig): PaneConfig {
  if (!raw || typeof raw !== 'object') return { ...fallback, indicators: [] };
  const r = raw as Record<string, unknown>;
  const indicators = Array.isArray(r.indicators)
    ? r.indicators
        .filter((i): i is { name: string; params: unknown } => !!i && typeof (i as { name?: unknown }).name === 'string')
        .slice(0, 20)
        .map((i) => ({
          name: i.name.slice(0, 40),
          params: Array.isArray(i.params) ? i.params.filter((p): p is number => typeof p === 'number' && Number.isFinite(p)).slice(0, 10) : [],
        }))
    : [];
  const pane: PaneConfig = {
    source: typeof r.source === 'string' && r.source ? r.source : fallback.source,
    symbol: typeof r.symbol === 'string' && r.symbol ? r.symbol.slice(0, 40) : fallback.symbol,
    timeframe: isTimeframeId(r.timeframe) ? r.timeframe : fallback.timeframe,
    indicators,
  };
  if (isChartType(r.chartType)) pane.chartType = r.chartType;
  if (isPriceScale(r.scale)) pane.scale = r.scale;
  return pane;
}

export function sanitizeConfig(raw: unknown): MultiChartConfig {
  const config = defaultConfig();
  if (!raw || typeof raw !== 'object') return config;
  const r = raw as Record<string, unknown>;
  if (isChartCount(r.count)) config.count = r.count;
  if (r.sync && typeof r.sync === 'object') {
    const s = r.sync as Record<string, unknown>;
    config.sync = { crosshair: s.crosshair !== false, timeframe: s.timeframe === true, symbol: s.symbol === true };
  }
  const panes = Array.isArray(r.panes) ? r.panes : [];
  config.panes = DEFAULT_PANES.map((fallback, i) => sanitizePane(panes[i], fallback));
  return config;
}

const key = () => `${APP.id}:multichart`;

export function loadConfig(storage: KeyValueStorage): MultiChartConfig {
  try {
    const raw = storage.getItem(key());
    return sanitizeConfig(raw ? JSON.parse(raw) : null);
  } catch {
    return defaultConfig();
  }
}

export function saveConfig(storage: KeyValueStorage, config: MultiChartConfig): boolean {
  try {
    storage.setItem(key(), JSON.stringify(sanitizeConfig(config)));
    return true;
  } catch {
    return false;
  }
}

/** CSS grid shape for a chart count. */
export function gridShape(count: ChartCount): { columns: number; rows: number } {
  if (count === 4) return { columns: 2, rows: 2 };
  if (count === 2) return { columns: 2, rows: 1 };
  return { columns: 1, rows: 1 };
}
