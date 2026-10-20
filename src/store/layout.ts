import { APP } from '../config';
import { isTimeframeId, type TimeframeId } from '../data/timeframes';
import { isChartType, isPriceScale, type ChartType, type PriceScale } from '../chart/chartStyle';
import { sanitizeScripts, type ScriptRecord } from '../script/persist';

export type Theme = 'dark' | 'light';
export type PaneKind = 'main' | 'sub';

export interface IndicatorConfig {
  name: string;
  params: number[];
  pane: PaneKind;
}

export interface DrawingPoint {
  timestamp: number;
  value: number;
}

export interface DrawingRecord {
  name: string;
  points: DrawingPoint[];
  text?: string;
}

export interface Layout {
  version: 1;
  source: string;
  symbol: string;
  timeframe: TimeframeId;
  theme: Theme;
  indicators: IndicatorConfig[];
  /** User scripts on the chart (source and input values). */
  scripts?: ScriptRecord[];
  /** How bars are drawn; candles when left out. */
  chartType?: ChartType;
  /** Price axis scale; normal when left out. */
  scale?: PriceScale;
}

/** The subset of the Web Storage API the store needs. `localStorage` satisfies it. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const DEFAULT_LAYOUT: Readonly<Layout> = Object.freeze({
  version: 1,
  source: 'binance',
  symbol: 'BTCUSDT',
  timeframe: '1h',
  theme: 'dark',
  indicators: [
    { name: 'EMA', params: [20, 50, 200], pane: 'main' },
    { name: 'VOL', params: [5, 10, 20], pane: 'sub' },
  ],
} satisfies Layout);

function cloneDefault(): Layout {
  return JSON.parse(JSON.stringify(DEFAULT_LAYOUT)) as Layout;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function sanitizeIndicator(raw: unknown): IndicatorConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.name !== 'string' || r.name.length === 0 || r.name.length > 40) return null;
  const params = Array.isArray(r.params) ? r.params.filter(isFiniteNumber) : [];
  const pane: PaneKind = r.pane === 'main' ? 'main' : 'sub';
  return { name: r.name, params, pane };
}

/** Accepts anything (old versions, hand-edited JSON, garbage) and returns a valid layout. */
export function sanitizeLayout(raw: unknown): Layout {
  const layout = cloneDefault();
  if (!raw || typeof raw !== 'object') return layout;
  const r = raw as Record<string, unknown>;
  if (typeof r.source === 'string' && r.source) layout.source = r.source;
  if (typeof r.symbol === 'string' && r.symbol) layout.symbol = r.symbol;
  if (isTimeframeId(r.timeframe)) layout.timeframe = r.timeframe;
  if (r.theme === 'light' || r.theme === 'dark') layout.theme = r.theme;
  if (Array.isArray(r.indicators)) {
    layout.indicators = r.indicators.map(sanitizeIndicator).filter((i): i is IndicatorConfig => i !== null);
  }
  if (Array.isArray(r.scripts)) layout.scripts = sanitizeScripts(r.scripts);
  if (isChartType(r.chartType)) layout.chartType = r.chartType;
  if (isPriceScale(r.scale)) layout.scale = r.scale;
  return layout;
}

export function sanitizeDrawings(raw: unknown): DrawingRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: DrawingRecord[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (typeof r.name !== 'string' || !Array.isArray(r.points)) continue;
    const points = r.points
      .filter((p): p is DrawingPoint => !!p && isFiniteNumber((p as DrawingPoint).timestamp) && isFiniteNumber((p as DrawingPoint).value))
      .map((p) => ({ timestamp: p.timestamp, value: p.value }));
    if (points.length === 0) continue;
    const record: DrawingRecord = { name: r.name, points };
    if (typeof r.text === 'string') record.text = r.text;
    out.push(record);
  }
  return out;
}

/** Keeps the app working when storage is blocked (private mode, disabled cookies). */
export class MemoryStorage implements KeyValueStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

export function browserStorage(): KeyValueStorage {
  try {
    const probe = `${APP.id}:probe`;
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return new MemoryStorage();
  }
}

export class LayoutStore {
  constructor(
    private readonly storage: KeyValueStorage,
    private readonly prefix: string = APP.id,
  ) {}

  private read(key: string): unknown {
    try {
      const raw = this.storage.getItem(key);
      return raw === null ? null : JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private write(key: string, value: unknown): boolean {
    try {
      this.storage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  layoutKey(): string {
    return `${this.prefix}:layout`;
  }

  drawingsKey(source: string, symbol: string): string {
    return `${this.prefix}:drawings:${source}:${symbol}`;
  }

  loadLayout(): Layout {
    return sanitizeLayout(this.read(this.layoutKey()));
  }

  saveLayout(layout: Layout): boolean {
    return this.write(this.layoutKey(), sanitizeLayout(layout));
  }

  loadDrawings(source: string, symbol: string): DrawingRecord[] {
    return sanitizeDrawings(this.read(this.drawingsKey(source, symbol)));
  }

  saveDrawings(source: string, symbol: string, drawings: DrawingRecord[]): boolean {
    const key = this.drawingsKey(source, symbol);
    const clean = sanitizeDrawings(drawings);
    if (clean.length === 0) {
      try {
        this.storage.removeItem(key);
        return true;
      } catch {
        return false;
      }
    }
    return this.write(key, clean);
  }
}
