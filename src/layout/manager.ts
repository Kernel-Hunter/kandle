import type { Chart, Crosshair, DeepPartial, Styles } from 'klinecharts';
import type { ChartType, PriceScale } from '../chart/chartStyle';
import { cachedSymbols, getSource } from '../data/sources';
import type { TimeframeId } from '../data/timeframes';
import type { Candle, SymbolMeta } from '../data/types';
import type { KeyValueStorage, Theme } from '../store/layout';
import { keyGate } from '../share/keyGate';
import { h } from '../ui/dom';
import { createSymbolSearch } from '../ui/symbolSearch';
import { EXTRA_PANES, gridShape, isChartCount, loadConfig, saveConfig, type ChartCount, type MultiChartConfig, type SyncOptions } from './config';
import { SecondaryPane, type PaneHandle } from './pane';

export interface LayoutManagerOptions {
  /** The main chart, always pane 1. */
  main: PaneHandle;
  /** The main chart's wrapper element; it becomes the first cell of the grid. */
  mainWrap: HTMLElement;
  storage: KeyValueStorage;
  theme: () => Theme;
  styles: (theme: Theme) => DeepPartial<Styles>;
  toast: (message: string, kind?: 'info' | 'error') => void;
  onLiveCandle: (pane: PaneHandle, candle: Candle) => void;
}

export interface LayoutState {
  charts: ChartCount;
  sync: SyncOptions;
  panes: Array<{ pane: number; exchange: string; symbol: string; timeframe: TimeframeId; chart_type: ChartType; price_scale: PriceScale }>;
}

export const LAYOUT_ICONS: Record<ChartCount, string> = {
  1: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/></svg>',
  2: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M12 4.5v15"/></svg>',
  4: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M12 4.5v15M3.5 12h17"/></svg>',
};

/**
 * Multi-chart layouts: 1 chart, 2 side by side, or 4 in a grid. Pane 1 is the app's main
 * chart; panes 2 to 4 are SecondaryPane instances. Crosshair, timeframe and symbol can be
 * kept in sync. The layout and each pane's settings are saved in browser storage.
 */
export class LayoutManager {
  private config: MultiChartConfig;
  private panes: SecondaryPane[] = [];
  readonly grid: HTMLElement;
  private readonly search;
  private searchTarget: SecondaryPane | null = null;
  private readonly listeners = new Set<() => void>();
  private syncingCrosshair = false;
  private readonly crosshairHandlers = new Map<number, (data?: unknown) => void>();
  /** The pane the user last clicked or touched; the watchlist loads symbols into it. */
  private focusedIndex = 1;

  constructor(private readonly options: LayoutManagerOptions) {
    this.config = loadConfig(options.storage);
    this.grid = h('div', { class: 'chart-grid n1' });
    options.mainWrap.replaceWith(this.grid);
    this.grid.append(options.mainWrap);
    options.mainWrap.classList.add('mc-main');
    options.mainWrap.addEventListener('mouseleave', () => this.clearCrosshairs(1));
    options.mainWrap.addEventListener('pointerdown', () => this.focus(1), true);

    this.search = createSymbolSearch({
      storage: options.storage,
      currentSource: () => this.searchTarget?.info().source ?? options.main.info().source,
      onPick: (sourceId, meta) => this.searchTarget?.setSymbol(sourceId, meta),
    });

    options.main.loader().onContext(() => {
      // The main chart changed symbol or timeframe; bring the others along if synced.
      void this.propagateFrom(options.main);
    });

    new MutationObserver(() => {
      for (const p of this.panes) p.applyTheme(options.theme());
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  get count(): ChartCount {
    return this.config.count;
  }

  get sync(): SyncOptions {
    return { ...this.config.sync };
  }

  /** Builds the saved layout. Call once after the main chart is ready. */
  async init(): Promise<void> {
    this.watchCrosshair(this.options.main);
    await this.setCount(this.config.count);
  }

  /** Pane by 1-based index, or null if that pane is not showing. */
  pane(index: number): PaneHandle | null {
    if (index === 1) return this.options.main;
    return this.panes.find((p) => p.index === index) ?? null;
  }

  /** The focused pane: the one the user last clicked, pane 1 until then. */
  focused(): PaneHandle {
    return this.pane(this.focusedIndex) ?? this.options.main;
  }

  focus(index: number): void {
    const target = this.pane(index) ? index : 1;
    if (target === this.focusedIndex) return;
    this.focusedIndex = target;
    this.markFocus();
    this.emit();
  }

  /** Outlines the focused pane when more than one chart is showing. */
  private markFocus(): void {
    const many = this.panes.length > 0;
    this.options.mainWrap.classList.toggle('mc-focused', many && this.focusedIndex === 1);
    for (const p of this.panes) p.el.classList.toggle('mc-focused', many && this.focusedIndex === p.index);
  }

  allPanes(): PaneHandle[] {
    return [this.options.main, ...this.panes];
  }

  /** The layout and every pane's settings as they are now, for share links. */
  currentConfig(): MultiChartConfig {
    const config = this.syncedConfig();
    return { ...config, sync: { ...config.sync }, panes: config.panes.map((p) => ({ ...p, indicators: p.indicators.map((i) => ({ ...i, params: [...i.params] })) })) };
  }

  state(): LayoutState {
    return {
      charts: this.config.count,
      sync: this.sync,
      panes: this.allPanes().map((p) => {
        const info = p.info();
        const style = p.chartStyle();
        return { pane: p.index, exchange: info.source, symbol: info.symbol, timeframe: info.timeframe, chart_type: style.type, price_scale: style.scale };
      }),
    };
  }

  async setCount(count: ChartCount): Promise<void> {
    if (!isChartCount(count)) throw new Error('Layouts have 1, 2 or 4 charts');
    this.config = { ...this.syncedConfig(), count };
    this.persist();
    const wanted = count - 1;
    while (this.panes.length > wanted) {
      const pane = this.panes.pop()!;
      this.unwatchCrosshair(pane);
      pane.dispose();
    }
    const { columns, rows } = gridShape(count);
    this.grid.className = `chart-grid n${count}`;
    this.grid.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
    this.grid.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
    const mounting: Promise<void>[] = [];
    while (this.panes.length < wanted && this.panes.length < EXTRA_PANES) {
      const index = this.panes.length + 2;
      const pane = new SecondaryPane(index, this.config.panes[index - 2], {
        storage: this.options.storage,
        theme: this.options.theme,
        styles: this.options.styles,
        onConfigChange: () => this.persist(),
        onSymbolChange: (p) => void this.propagateFrom(p, 'symbol'),
        onTimeframeChange: (p) => void this.propagateFrom(p, 'timeframe'),
        onLiveCandle: (p, candle) => this.options.onLiveCandle(p, candle),
        openSymbolSearch: (p) => {
          this.searchTarget = p;
          this.search.open();
        },
        toast: this.options.toast,
      });
      this.panes.push(pane);
      this.grid.append(pane.el);
      pane.el.addEventListener('mouseleave', () => this.clearCrosshairs(pane.index));
      pane.el.addEventListener('pointerdown', () => this.focus(pane.index), true);
      mounting.push(
        pane.mount().then(
          () => {
            this.watchCrosshair(pane);
            void this.propagateFrom(this.options.main);
          },
          (error: unknown) => this.options.toast(error instanceof Error ? error.message : String(error), 'error'),
        ),
      );
    }
    if (!this.pane(this.focusedIndex)) this.focusedIndex = 1;
    this.markFocus();
    await Promise.all(mounting);
    // The engine watches its container size, but a nudge avoids one stale frame.
    requestAnimationFrame(() => {
      for (const p of this.allPanes()) {
        try {
          p.chart().resize();
        } catch {
          // Pane still mounting.
        }
      }
    });
    this.emit();
  }

  setSync(partial: Partial<SyncOptions>): void {
    this.config = { ...this.syncedConfig(), sync: { ...this.config.sync, ...partial } };
    this.persist();
    if (partial.symbol || partial.timeframe) void this.propagateFrom(this.options.main);
    if (partial.crosshair === false) this.clearCrosshairs(0);
    this.emit();
  }

  /** The stored config with the live settings of mounted panes folded in. */
  private syncedConfig(): MultiChartConfig {
    const panes = this.config.panes.map((p, i) => this.panes[i]?.currentConfig ?? p);
    return { ...this.config, panes };
  }

  private persist(): void {
    this.config = this.syncedConfig();
    saveConfig(this.options.storage, this.config);
    this.emit();
  }

  async metaFor(source: string, symbol: string): Promise<SymbolMeta> {
    const cached = cachedSymbols(getSource(source), this.options.storage)?.find((s) => s.symbol === symbol);
    if (cached) return cached;
    // Some keyed sources look a symbol up with the key, which a shared view holds back.
    const fetched = keyGate().holds(source)
      ? null
      : await getSource(source)
          .getSymbol(symbol)
          .catch(() => null);
    return fetched ?? { symbol, base: symbol, quote: '', pricePrecision: 2, volumePrecision: 4 };
  }

  /** Copies symbol and/or timeframe from one pane to the others when sync is on. */
  private async propagateFrom(from: PaneHandle, what?: 'symbol' | 'timeframe'): Promise<void> {
    const { symbol: syncSymbol, timeframe: syncTimeframe } = this.config.sync;
    const info = from.info();
    const doSymbol = syncSymbol && (what === undefined || what === 'symbol');
    const doTimeframe = syncTimeframe && (what === undefined || what === 'timeframe');
    if (!doSymbol && !doTimeframe) return;
    const meta = doSymbol ? await this.metaFor(info.source, info.symbol) : null;
    for (const pane of this.allPanes()) {
      if (pane === from) continue;
      const current = pane.info();
      if (meta && (current.source !== info.source || current.symbol !== info.symbol)) pane.setSymbol(info.source, meta);
      if (doTimeframe && current.timeframe !== info.timeframe) pane.setTimeframe(info.timeframe);
    }
  }

  private watchCrosshair(pane: PaneHandle): void {
    let chart: Chart;
    try {
      chart = pane.chart();
    } catch {
      return;
    }
    const handler = (data?: unknown) => this.onCrosshair(pane, data as Crosshair | undefined);
    this.crosshairHandlers.set(pane.index, handler);
    chart.subscribeAction('onCrosshairChange', handler);
  }

  private unwatchCrosshair(pane: PaneHandle): void {
    const handler = this.crosshairHandlers.get(pane.index);
    if (!handler) return;
    try {
      pane.chart().unsubscribeAction('onCrosshairChange', handler);
    } catch {
      // Already disposed.
    }
    this.crosshairHandlers.delete(pane.index);
  }

  private onCrosshair(from: PaneHandle, data: Crosshair | undefined): void {
    if (!this.config.sync.crosshair || this.syncingCrosshair || this.panes.length === 0) return;
    if (!data || typeof data.x !== 'number') return;
    const source = from.chart();
    const converted = source.convertFromPixel([{ x: data.x, y: data.y }], { paneId: data.paneId ?? 'candle_pane' });
    const point = Array.isArray(converted) ? converted[0] : converted;
    const timestamp = point?.timestamp;
    if (timestamp === undefined) return;
    const fromInfo = from.info();
    this.syncingCrosshair = true;
    try {
      for (const pane of this.allPanes()) {
        if (pane === from) continue;
        let chart: Chart;
        try {
          chart = pane.chart();
        } catch {
          continue;
        }
        const same = pane.info().symbol === fromInfo.symbol && pane.info().source === fromInfo.source && data.paneId === 'candle_pane';
        const target = chart.convertToPixel({ timestamp, value: same ? point.value : undefined }, { paneId: 'candle_pane' });
        const coord = Array.isArray(target) ? target[0] : target;
        if (typeof coord?.x !== 'number') continue;
        // Without a matching price, park the horizontal hair above the pane so only the time line shows.
        chart.executeAction('onCrosshairChange', { x: coord.x, y: same && typeof coord.y === 'number' ? coord.y : -1000, paneId: 'candle_pane' });
      }
    } finally {
      this.syncingCrosshair = false;
    }
  }

  private clearCrosshairs(exceptIndex: number): void {
    if (this.panes.length === 0) return;
    for (const pane of this.allPanes()) {
      if (pane.index === exceptIndex) continue;
      try {
        pane.chart().executeAction('onCrosshairChange', null as unknown as Crosshair);
      } catch {
        // Not mounted.
      }
    }
  }

  /** Topbar control: a button that opens a small menu with layouts and sync switches. open() can show the menu under another element. */
  createControl(): { el: HTMLElement; button: HTMLButtonElement; open(anchor?: HTMLElement): void } {
    const icon = h('span', { html: LAYOUT_ICONS[this.config.count] });
    const button = h(
      'button',
      { class: 'tb-btn', title: 'Chart layout', 'aria-haspopup': 'true', 'aria-expanded': 'false' },
      icon,
      h('span', { class: 'tb-label' }, 'Layout'),
    );
    const choices = ([1, 2, 4] as const).map((n) =>
      h('button', {
        class: 'seg-btn lay-choice',
        dataset: { count: String(n) },
        title: n === 1 ? 'One chart' : n === 2 ? 'Two charts side by side' : 'Four charts in a grid',
        'aria-label': n === 1 ? 'One chart' : n === 2 ? 'Two charts' : 'Four charts',
        html: LAYOUT_ICONS[n],
        onclick: () => void this.setCount(n),
      }),
    );
    const toggle = (key: keyof SyncOptions, label: string) => {
      const input = h('input', { type: 'checkbox', onchange: () => this.setSync({ [key]: input.checked }) }) as HTMLInputElement;
      return { key, input, row: h('label', { class: 'lay-sync' }, input, label) };
    };
    const toggles = [toggle('crosshair', 'Sync crosshair'), toggle('timeframe', 'Sync timeframe'), toggle('symbol', 'Sync symbol')];
    const menu = h(
      'div',
      { class: 'popover lay-menu', hidden: true, role: 'menu' },
      h('div', { class: 'popover-title' }, 'Layout'),
      h('div', { class: 'seg lay-choices' }, ...choices),
      ...toggles.map((t) => t.row),
    );
    const refresh = () => {
      icon.innerHTML = LAYOUT_ICONS[this.config.count];
      for (const c of choices) c.classList.toggle('active', Number(c.dataset.count) === this.config.count);
      for (const t of toggles) t.input.checked = this.config.sync[t.key];
    };
    refresh();
    this.onChange(refresh);
    const close = () => {
      menu.hidden = true;
      button.setAttribute('aria-expanded', 'false');
    };
    const open = (anchor: HTMLElement = button) => {
      menu.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      // Fixed to the window, so it can open under the More button and stay on screen.
      const r = anchor.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8))}px`;
      menu.style.top = `${r.bottom + 6}px`;
    };
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      if (menu.hidden) open();
      else close();
    });
    // Pointer events, so a tap on the chart closes the menu too.
    document.addEventListener('pointerdown', (e) => {
      if (!menu.hidden && !wrap.contains(e.target as Node)) close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !menu.hidden) close();
    });
    const wrap = h('div', { class: 'popover-wrap' }, button, menu);
    return { el: wrap, button, open: (anchor) => (menu.hidden ? open(anchor) : close()) };
  }
}
