import { dispose, init, type Chart, type DeepPartial, type Styles } from 'klinecharts';
import { INDICATORS, getIndicatorDef } from '../chart/indicators';
import { createDataLoader } from '../chart/loader';
import { cachedSymbols, getSource } from '../data/sources';
import { displayName } from '../data/search';
import { TIMEFRAMES, getTimeframe, type TimeframeId } from '../data/timeframes';
import type { Candle, SymbolMeta } from '../data/types';
import { SwitchingLoader } from '../replay/loader';
import type { KeyValueStorage, Theme } from '../store/layout';
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
  private chartRef: Chart | null = null;
  private readonly switching: SwitchingLoader;
  private meta: SymbolMeta | null = null;
  private active: ActiveIndicator[] = [];
  private disposed = false;

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
    this.chartEl = h('div', { class: 'chart mc-chart' });
    this.el = h(
      'div',
      { class: 'mc-pane', dataset: { pane: String(index) } },
      h('div', { class: 'mc-head' }, h('span', { class: 'mc-num' }, String(index)), this.symbolBtn, this.tfSelect, indSelect, this.chips),
      h('div', { class: 'mc-body' }, this.chartEl),
    );
    this.switching = new SwitchingLoader(
      createDataLoader({
        resolve: () => ({ source: getSource(this.config.source), symbol: this.config.symbol, timeframe: this.config.timeframe }),
        onError: (message) => deps.toast(`Chart ${index}: ${message}`, 'error'),
        onLiveCandle: (candle) => deps.onLiveCandle(this, candle),
      }),
    );
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

  /** Creates the chart once the element is in the document. */
  async mount(): Promise<void> {
    const chart = init(this.chartEl, { locale: 'en-US', styles: this.deps.theme() });
    if (!chart) throw new Error(`Chart ${this.index} failed to initialise`);
    this.chartRef = chart;
    this.applyTheme(this.deps.theme());
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
    if (this.chartRef) dispose(this.chartEl);
    this.chartRef = null;
    this.el.remove();
  }

  applyTheme(theme: Theme): void {
    if (!this.chartRef) return;
    this.chartRef.setStyles(theme);
    this.chartRef.setStyles(this.deps.styles(theme));
  }

  private async lookupMeta(source: string, symbol: string): Promise<SymbolMeta | null> {
    const cached = cachedSymbols(getSource(source), this.deps.storage)?.find((s) => s.symbol === symbol);
    if (cached) return cached;
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
    this.config = { ...this.config, source, symbol: meta.symbol };
    this.meta = meta;
    this.chartRef?.setSymbol(this.symbolInfo());
    this.renderHead();
    this.deps.onConfigChange();
    this.deps.onSymbolChange(this);
  }

  setTimeframe(tf: TimeframeId): void {
    const timeframe = getTimeframe(tf);
    if (!timeframe || tf === this.config.timeframe) {
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
