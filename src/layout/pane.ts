import { dispose, init, type Chart, type DeepPartial, type Styles } from 'klinecharts';
import { DEFAULT_CHART_STYLE, type ChartStyle } from '../chart/chartStyle';
import { applyChartType, applyPriceScale } from '../chart/chartStyleRender';
import { INDICATORS, getIndicatorDef } from '../chart/indicators';
import { createDataLoader } from '../chart/loader';
import { cachedSymbols, getSource } from '../data/sources';
import { displayName } from '../data/search';
import { TIMEFRAMES, getTimeframe, type TimeframeId } from '../data/timeframes';
import type { Candle, SymbolMeta } from '../data/types';
import { SwitchingLoader } from '../replay/loader';
import { createKeyCover, keyGate, type KeyCover } from '../share/keyGate';
import type { KeyValueStorage, Theme } from '../store/layout';
import { createChartStyleControl, type ChartStyleControl } from '../ui/chartStyleMenu';
import { h, ICONS } from '../ui/dom';
import type { ActiveIndicator } from '../ui/indicatorPanel';
import type { PaneConfig } from './config';

const CANDLE_PANE = 'candle_pane';

/** What the layout manager, alerts and agent bridge need from any chart pane. */
export interface PaneHandle {
  /** 1-based position in reading order; 1 is the main chart. */
  readonly index: number;
  chart(): Chart;
  loader(): SwitchingLoader;
  info(): { source: string; symbol: string; timeframe: TimeframeId };
  setSymbol(source: string, meta: SymbolMeta): void;
  setTimeframe(tf: TimeframeId): void;
  addIndicator(name: string, params?: number[]): string | null;
  removeIndicator(id: string): void;
  indicators(): ActiveIndicator[];
  /** Timeframes the current symbol can be shown in (imported data only goes up from its own). */
  timeframes(): readonly TimeframeId[];
  /** Chart type and price scale. */
  chartStyle(): ChartStyle;
  setChartStyle(change: Partial<ChartStyle>): ChartStyle;
}

export interface SecondaryPaneDeps {
  storage: KeyValueStorage;
  theme: () => Theme;
  /** The main chart's style overrides for a theme, so every pane looks the same. */
  styles: (theme: Theme) => DeepPartial<Styles>;
  onConfigChange: () => void;
  onSymbolChange: (pane: SecondaryPane) => void;
  onTimeframeChange: (pane: SecondaryPane) => void;
  onLiveCandle: (pane: SecondaryPane, candle: Candle) => void;
  openSymbolSearch: (pane: SecondaryPane) => void;
  toast: (message: string, kind?: 'info' | 'error') => void;
}

/**
 * A chart in panes 2 to 4 of a multi-chart layout. It has its own symbol, timeframe,
 * indicators and live stream, and a compact header instead of the main toolbar.
 */
export class SecondaryPane implements PaneHandle {
  readonly el: HTMLElement;
  private readonly chartEl: HTMLElement;
  private readonly symbolBtn: HTMLButtonElement;
  private readonly tfSelect: HTMLSelectElement;
  private readonly chips: HTMLElement;
  private readonly styleControl: ChartStyleControl;
  private chartRef: Chart | null = null;
  private readonly switching: SwitchingLoader;
  private meta: SymbolMeta | null = null;
  private active: ActiveIndicator[] = [];
  private disposed = false;
  private readonly keyCover: KeyCover = createKeyCover();
  private readonly offRelease: () => void;

  constructor(
    readonly index: number,
    private config: PaneConfig,
    private readonly deps: SecondaryPaneDeps,
  ) {
    this.symbolBtn = h('button', { class: 'mc-symbol', title: 'Change symbol', onclick: () => deps.openSymbolSearch(this) });
    this.tfSelect = h(
      'select',
      { class: 'mc-select', 'aria-label': `Timeframe for chart ${index}`, onchange: () => this.setTimeframe(this.tfSelect.value as TimeframeId) },
      ...TIMEFRAMES.map((tf) => h('option', { value: tf.id }, tf.label)),
    ) as HTMLSelectElement;
    const indSelect = h(
      'select',
      {
        class: 'mc-select mc-ind',
        'aria-label': `Add indicator to chart ${index}`,
        onchange: () => {
          if (indSelect.value) this.addIndicator(indSelect.value);
          indSelect.value = '';
        },
      },
      h('option', { value: '' }, '+ Indicator'),
      ...INDICATORS.map((d) => h('option', { value: d.name }, `${d.name}  ${d.label}`)),
    ) as HTMLSelectElement;
    this.chips = h('div', { class: 'mc-chips' });
    this.styleControl = createChartStyleControl({
      get: () => this.chartStyle(),
      set: (change) => this.setChartStyle(change),
      compact: true,
      name: `chart ${index}`,
    });
    this.chartEl = h('div', { class: 'chart mc-chart' });
    this.el = h(
      'div',
      { class: 'mc-pane', dataset: { pane: String(index) } },
      h('div', { class: 'mc-head' }, h('span', { class: 'mc-num' }, String(index)), this.symbolBtn, this.tfSelect, this.styleControl.el, indSelect, this.chips),
      h('div', { class: 'mc-body' }, this.chartEl, this.keyCover.el),
    );
    this.switching = new SwitchingLoader(
      createDataLoader({
        resolve: () => ({ source: getSource(this.config.source), symbol: this.config.symbol, timeframe: this.config.timeframe }),
        onError: (message) => deps.toast(`Chart ${index}: ${message}`, 'error'),
        onLiveCandle: (candle) => deps.onLiveCandle(this, candle),
        held: (source) => keyGate().holds(source.id),
        onHeld: (source) => this.keyCover.show(source),
      }),
    );
    this.offRelease = keyGate().onRelease((id) => {
      if (id === this.config.source) void this.reloadReleased();
    });
  }

  /** Loads the chart after the user let its keyed source load. */
  private async reloadReleased(): Promise<void> {
    const { source, symbol } = this.config;
    const meta = await this.lookupMeta(source, symbol);
    if (this.disposed || this.config.source !== source || this.config.symbol !== symbol) return;
    if (meta) this.meta = meta;
    this.chartRef?.setSymbol(this.symbolInfo());
    this.renderHead();
  }

  get currentConfig(): PaneConfig {
    return { ...this.config, indicators: this.active.map((i) => ({ name: i.name, params: [...i.params] })) };
  }

  chart(): Chart {
    if (!this.chartRef) throw new Error(`Chart ${this.index} is not ready`);
    return this.chartRef;
  }

  loader(): SwitchingLoader {
    return this.switching;
  }

  info() {
    return { source: this.config.source, symbol: this.config.symbol, timeframe: this.config.timeframe };
  }

  indicators(): ActiveIndicator[] {
    return this.active.map((i) => ({ ...i, params: [...i.params] }));
  }

  timeframes(): readonly TimeframeId[] {
    return getSource(this.config.source).timeframesFor?.(this.config.symbol) ?? TIMEFRAMES.map((tf) => tf.id);
  }

  /** Creates the chart once the element is in the document. */
  async mount(): Promise<void> {
    const chart = init(this.chartEl, { locale: 'en-US', styles: this.deps.theme() });
    if (!chart) throw new Error(`Chart ${this.index} failed to initialise`);
    this.chartRef = chart;
    this.applyTheme(this.deps.theme());
    applyPriceScale(chart, this.chartStyle().scale);
    chart.setOffsetRightDistance(40);
    this.meta = await this.lookupMeta(this.config.source, this.config.symbol);
    if (this.disposed) return;
    chart.setSymbol(this.symbolInfo());
    chart.setPeriod(getTimeframe(this.config.timeframe)!.period);
    chart.setDataLoader(this.switching);
    const saved = this.config.indicators;
    for (const ind of saved) this.addIndicator(ind.name, ind.params.length ? ind.params : undefined, false);
    this.renderHead();
  }

  dispose(): void {
    this.disposed = true;
    this.offRelease();
    this.keyCover.dispose();
    if (this.chartRef) dispose(this.chartEl);
    this.chartRef = null;
    this.el.remove();
  }

  applyTheme(theme: Theme): void {
    if (!this.chartRef) return;
    this.chartRef.setStyles(theme);
    this.chartRef.setStyles(this.deps.styles(theme));
    applyChartType(this.chartRef, this.chartStyle().type);
  }

  chartStyle(): ChartStyle {
    return { type: this.config.chartType ?? DEFAULT_CHART_STYLE.type, scale: this.config.scale ?? DEFAULT_CHART_STYLE.scale };
  }

  setChartStyle(change: Partial<ChartStyle>): ChartStyle {
    const current = this.chartStyle();
    const next = { ...current, ...change };
    this.config = { ...this.config, chartType: next.type, scale: next.scale };
    if (this.chartRef && next.type !== current.type) applyChartType(this.chartRef, next.type);
    if (this.chartRef && next.scale !== current.scale) applyPriceScale(this.chartRef, next.scale);
    this.styleControl.refresh();
    this.deps.onConfigChange();
    return next;
  }

  private async lookupMeta(source: string, symbol: string): Promise<SymbolMeta | null> {
    const cached = cachedSymbols(getSource(source), this.deps.storage)?.find((s) => s.symbol === symbol);
    if (cached) return cached;
    if (keyGate().holds(source)) return null;
    try {
      return await Promise.race([getSource(source).getSymbol(symbol), new Promise<null>((r) => setTimeout(() => r(null), 4000))]);
    } catch {
      return null;
    }
  }

  private symbolInfo() {
    return { ticker: this.config.symbol, pricePrecision: this.meta?.pricePrecision ?? 2, volumePrecision: this.meta?.volumePrecision ?? 4 };
  }

  setSymbol(source: string, meta: SymbolMeta): void {
    if (source === this.config.source && meta.symbol === this.config.symbol) return;
    const allowed = getSource(source).timeframesFor?.(meta.symbol);
    const timeframe = !allowed || allowed.includes(this.config.timeframe) ? this.config.timeframe : allowed[0];
    const periodChanged = timeframe !== this.config.timeframe;
    this.config = { ...this.config, source, symbol: meta.symbol, timeframe };
    this.meta = meta;
    if (periodChanged) this.chartRef?.setPeriod(getTimeframe(timeframe)!.period);
    this.chartRef?.setSymbol(this.symbolInfo());
    this.renderHead();
    this.deps.onConfigChange();
    this.deps.onSymbolChange(this);
  }

  setTimeframe(tf: TimeframeId): void {
    const timeframe = getTimeframe(tf);
    if (!timeframe || tf === this.config.timeframe || !this.timeframes().includes(tf)) {
      this.renderHead();
      return;
    }
    this.config = { ...this.config, timeframe: tf };
    this.chartRef?.setPeriod(timeframe.period);
    this.renderHead();
    this.deps.onConfigChange();
    this.deps.onTimeframeChange(this);
  }

  addIndicator(name: string, params?: number[], persist = true): string | null {
    const chart = this.chartRef;
    if (!chart) return null;
    const def = getIndicatorDef(name);
    const pane = def?.pane ?? 'sub';
    const calcParams = params ?? def?.defaults ?? [];
    const id =
      pane === 'main'
        ? chart.createIndicator({ name, calcParams, paneId: CANDLE_PANE }, true)
        : chart.createIndicator({ name, calcParams }, false);
    if (!id) {
      this.deps.toast(`Indicator ${name} is not available`, 'error');
      return null;
    }
    const created = chart.getIndicators({ id })[0];
    if (pane === 'sub' && created) chart.setPaneOptions({ id: created.paneId, height: 70 });
    this.active.push({ id, name, pane, params: [...((created?.calcParams as number[] | undefined) ?? calcParams)] });
    this.renderHead();
    if (persist) this.deps.onConfigChange();
    return id;
  }

  removeIndicator(id: string): void {
    this.chartRef?.removeIndicator({ id });
    this.active = this.active.filter((i) => i.id !== id);
    this.renderHead();
    this.deps.onConfigChange();
  }

  private renderHead(): void {
    const label = this.meta ? displayName(this.meta) : this.config.symbol;
    this.symbolBtn.replaceChildren(
      h('span', { html: ICONS.search, class: 'symbol-icon' }),
      h('span', { class: 'symbol-name' }, label),
      h('span', { class: 'muted mc-source' }, getSource(this.config.source).name),
    );
    this.tfSelect.value = this.config.timeframe;
    const allowed = this.timeframes();
    for (const option of Array.from(this.tfSelect.options)) option.disabled = !allowed.includes(option.value as TimeframeId);
    this.chips.replaceChildren(
      ...this.active.map((ind) =>
        h(
          'span',
          { class: 'mc-chip' },
          ind.params.length ? `${ind.name} ${ind.params.join(',')}` : ind.name,
          h('button', { class: 'mc-chip-x', title: `Remove ${ind.name}`, 'aria-label': `Remove ${ind.name}`, onclick: () => this.removeIndicator(ind.id) }, '×'),
        ),
      ),
    );
  }
}
