/**
 * Opening a shared chart as a temporary view. The app runs on a TemporaryStorage that keeps
 * every change to the saved chart (layout, multi-chart layout, drawings) in memory, so the
 * user's own saved chart stays as it was until they choose Keep. Everything else, such as
 * symbol lists, the watchlist and alerts, goes straight to browser storage.
 */
import { APP } from '../config';
import { getIndicatorDef } from '../chart/indicators';
import { loadConfig, saveConfig, type MultiChartConfig } from '../layout/config';
import { MAX_SCRIPTS, type ScriptRecord } from '../script/persist';
import { LayoutStore, sanitizeDrawings, sanitizeLayout, type DrawingRecord, type KeyValueStorage, type Layout } from '../store/layout';
import type { SharedChart, SharedScript } from './codec';

/** The storage keys that make up the saved chart. */
export function isChartKey(key: string, prefix: string = APP.id): boolean {
  return key === `${prefix}:layout` || key === `${prefix}:multichart` || key.startsWith(`${prefix}:drawings:`);
}

/**
 * Reads from `base`, but keeps writes to the keys `captures` picks in memory until commit().
 * After commit or with capturing off it passes everything through.
 */
export class TemporaryStorage implements KeyValueStorage {
  /** Captured values; null means removed. */
  private readonly changes = new Map<string, string | null>();
  private capturing = true;

  constructor(
    readonly base: KeyValueStorage,
    private readonly captures: (key: string) => boolean = (key) => isChartKey(key),
  ) {}

  get temporary(): boolean {
    return this.capturing;
  }

  private held(key: string): boolean {
    return this.capturing && this.captures(key);
  }

  getItem(key: string): string | null {
    if (this.held(key) && this.changes.has(key)) return this.changes.get(key) ?? null;
    return this.base.getItem(key);
  }

  setItem(key: string, value: string): void {
    if (this.held(key)) this.changes.set(key, value);
    else this.base.setItem(key, value);
  }

  removeItem(key: string): void {
    if (this.held(key)) this.changes.set(key, null);
    else this.base.removeItem(key);
  }

  /** Keys with captured changes. */
  keys(): string[] {
    return [...this.changes.keys()];
  }

  /**
   * Writes the captured changes to the base storage, each through `merge` if given, and
   * passes everything through from then on. Returns false if the base storage refused one.
   */
  commit(merge: (key: string, value: string | null) => string | null = (_k, v) => v): boolean {
    let ok = true;
    for (const [key, captured] of this.changes) {
      const value = merge(key, captured);
      try {
        if (value === null) this.base.removeItem(key);
        else this.base.setItem(key, value);
      } catch {
        ok = false;
      }
    }
    this.changes.clear();
    this.capturing = false;
    return ok;
  }

  /** Drops the captured changes. Later writes stay in memory too, so nothing reaches the base storage. */
  discard(): void {
    this.changes.clear();
  }
}

const sameScript = (a: ScriptRecord, b: ScriptRecord) => a.source === b.source && JSON.stringify(a.inputs) === JSON.stringify(b.inputs);
const sameDrawing = (a: DrawingRecord, b: DrawingRecord) => JSON.stringify(a) === JSON.stringify(b);

function parse(value: string | null): unknown {
  try {
    return value === null ? null : JSON.parse(value);
  } catch {
    return null;
  }
}

export interface KeepResult {
  /** False when browser storage refused to save. */
  saved: boolean;
  /** Own drawings or scripts that were hidden came back, so the page must reload to show them. */
  reload: boolean;
  /** Scripts from the link that were never run, so they were not saved. */
  skippedScripts: number;
}

/** A shared chart open as a temporary view. */
export interface SharedView {
  readonly chart: SharedChart;
  readonly notes: string[];
  readonly storage: TemporaryStorage;
  /** Scripts from the link that have not run yet. They only run when the user asks. */
  pendingScripts(): SharedScript[];
  /** Call after a pending script was added to the chart (or failed to), so it is not offered again. */
  markScriptsHandled(): void;
  /** Saves the shared chart as the user's own; their own drawings and scripts stay. */
  keep(): KeepResult;
  /** Drops the shared chart before the page reloads; the saved one is untouched. */
  discard(): void;
}

/**
 * Seeds a TemporaryStorage with the shared chart over the user's saved one. Anything the link
 * does not carry comes from the user's own chart, and the theme always does.
 */
export function openSharedView(base: KeyValueStorage, chart: SharedChart, notes: string[] = [], prefix: string = APP.id): SharedView {
  const storage = new TemporaryStorage(base, (key) => isChartKey(key, prefix));
  const own = new LayoutStore(base, prefix).loadLayout();
  const store = new LayoutStore(storage, prefix);

  const layout: Layout = {
    ...own,
    source: chart.source,
    symbol: chart.symbol,
    timeframe: chart.timeframe,
    ...(chart.style ? { chartType: chart.style.type, scale: chart.style.scale } : {}),
    indicators: chart.indicators
      ? chart.indicators.map((i) => ({ name: i.name, params: [...i.params], pane: getIndicatorDef(i.name)?.pane ?? 'sub' }))
      : own.indicators,
    // Shared scripts wait for the user; the user's own are hidden meanwhile and come back on Keep.
    scripts: chart.scripts ? [] : own.scripts,
  };
  store.saveLayout(layout);
  const hiddenScripts = chart.scripts ? (own.scripts ?? []) : [];

  const drawingsKey = store.drawingsKey(chart.source, chart.symbol);
  let hiddenDrawings: DrawingRecord[] = [];
  if (chart.drawings) {
    hiddenDrawings = new LayoutStore(base, prefix).loadDrawings(chart.source, chart.symbol);
    store.saveDrawings(chart.source, chart.symbol, chart.drawings);
  }

  if (chart.layout) {
    const ownConfig = loadConfig(base);
    const config: MultiChartConfig = {
      ...ownConfig,
      count: chart.layout.count,
      sync: { ...chart.layout.sync },
      panes: ownConfig.panes.map((p, i) => chart.layout!.panes[i] ?? p),
    };
    saveConfig(storage, config);
  }

  let pending: SharedScript[] = chart.scripts ? [...chart.scripts] : [];

  const merge = (key: string, value: string | null): string | null => {
    if (key === store.layoutKey() && hiddenScripts.length > 0) {
      const kept = sanitizeLayout(parse(value) ?? own);
      const scripts = [...hiddenScripts];
      for (const s of kept.scripts ?? []) if (!scripts.some((o) => sameScript(o, s))) scripts.push(s);
      return JSON.stringify({ ...kept, scripts: scripts.slice(0, MAX_SCRIPTS) });
    }
    if (key === drawingsKey && hiddenDrawings.length > 0) {
      const drawings = [...hiddenDrawings];
      for (const d of sanitizeDrawings(parse(value))) if (!drawings.some((o) => sameDrawing(o, d))) drawings.push(d);
      return JSON.stringify(drawings);
    }
    return value;
  };

  return {
    chart,
    notes,
    storage,
    pendingScripts: () => [...pending],
    markScriptsHandled: () => {
      pending = [];
    },
    keep() {
      const skippedScripts = pending.length;
      pending = [];
      const saved = storage.commit(merge);
      return { saved, reload: hiddenScripts.length > 0 || hiddenDrawings.length > 0, skippedScripts };
    },
    discard() {
      pending = [];
      storage.discard();
    },
  };
}
