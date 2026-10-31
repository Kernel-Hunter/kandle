import { init, type Chart, type DeepPartial, type Overlay, type OverlayEvent, type Styles } from 'klinecharts';
import { APP } from './config';
import { createDataLoader } from './chart/loader';
import { getIndicatorDef, registerCustomIndicators } from './chart/indicators';
import { DRAWING_TOOLS, registerCustomOverlays } from './chart/overlays';
import { CHART_TYPE_LABELS, nextChartType, parseChartStyleChange, type ChartStyle } from './chart/chartStyle';
import { applyChartType, applyPriceScale, registerChartTypes } from './chart/chartStyleRender';
import { SOURCES, cachedSymbols, getSource, loadSymbols } from './data/sources';
import { SeriesFeeds } from './data/feeds';
import { CSV_SOURCE_ID, csvStore } from './data/csv';
import { bindCsvDrop, setCsvImportHandler } from './ui/csvImport';
import { TIMEFRAMES, getTimeframe, type TimeframeId } from './data/timeframes';
import type { Candle, StreamStatus, SymbolMeta } from './data/types';
import { DEFAULT_LAYOUT, LayoutStore, type DrawingRecord, type KeyValueStorage, type Layout, type Theme } from './store/layout';
import { h, ICONS, isTypingTarget } from './ui/dom';
import { createModal, promptText, topModal } from './ui/modal';
import { createSymbolSearch } from './ui/symbolSearch';
import { createIndicatorPanel, type ActiveIndicator } from './ui/indicatorPanel';
import { createChartStyleControl } from './ui/chartStyleMenu';
import { createTopbarFit, type TopbarFit } from './ui/topbarFit';
import { createFeatures, type Features } from './features';
import { displayName } from './data/search';
import { keyStore } from './data/keys';
import { createDataSourcesButton } from './ui/dataSources';
import { ScriptManager, scriptApi } from './script/manager';
import { symbolContext } from './script/render';
import { scriptRows } from './ui/scriptInputs';
import type { ScriptPanel } from './ui/scriptPanel';
import type { SharedView } from './share/view';
import { createKeyCover, keyGate } from './share/keyGate';
import { createUpdateBanner } from './update';

const DRAWINGS_GROUP = 'drawings';
const CANDLE_PANE = 'candle_pane';

const UP = '#22ab94';
const DOWN = '#f23645';

/** Grid, candle and axis colors for a theme. Embed mode uses them too. */
export function chartStyles(theme: Theme): DeepPartial<Styles> {
  const dark = theme === 'dark';
  const grid = dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.06)';
  const text = dark ? '#8a929e' : '#5f6873';
  const axisLine = dark ? '#262b33' : '#e3e6eb';
  return {
    grid: { horizontal: { color: grid }, vertical: { color: grid } },
    candle: {
      bar: {
        upColor: UP,
        downColor: DOWN,
        noChangeColor: text,
        upBorderColor: UP,
        downBorderColor: DOWN,
        noChangeBorderColor: text,
        upWickColor: UP,
        downWickColor: DOWN,
        noChangeWickColor: text,
      },
      priceMark: { last: { upColor: UP, downColor: DOWN } },
    },
    xAxis: { axisLine: { color: axisLine }, tickText: { color: text }, tickLine: { color: axisLine } },
    yAxis: { axisLine: { color: axisLine }, tickText: { color: text }, tickLine: { color: axisLine } },
    separator: { color: axisLine },
  };
}

function shortcutLabel(code: string): string {
  return `Alt+${code.replace(/^Key|^Digit/, '')}`;
}

export class App {
  private readonly store: LayoutStore;
  private layout: Layout;
  private chart!: Chart;
  private meta: SymbolMeta | null = null;
  private indicators: ActiveIndicator[] = [];
  private selectedDrawing: string | null = null;
  private pendingDrawing: string | null = null;
  private activeTool: string | null = null;
  private magnet = false;
  private restoringDrawings = false;
  private lastPrice: number | null = null;
  /** Agent bridge, alerts, bar replay and multi-chart layouts (src/features). */
  private features!: Features;

  private readonly el = {
    symbolBtn: h('button', { class: 'symbol-btn', title: 'Search symbol (start typing anywhere)' }),
    timeframes: h('div', { class: 'seg timeframes', role: 'group', 'aria-label': 'Timeframe' }),
    // Replaces the row of timeframe buttons when the top bar is short of room.
    timeframeSelect: h('select', { class: 'tf-select', title: 'Timeframe (Alt+1 to Alt+7)', 'aria-label': 'Timeframe' }),
    price: h('span', { class: 'price' }),
    status: h('span', { class: 'status', title: 'Live data connection' }),
    themeBtn: h('button', { class: 'icon-btn', title: 'Toggle theme (Alt+L)', 'aria-label': 'Toggle theme' }),
    drawbar: h('nav', { class: 'drawbar', 'aria-label': 'Drawing tools' }),
    chart: h('div', { class: 'chart', id: 'chart' }),
    loading: h('div', { class: 'loading', hidden: true }, h('span', { class: 'spinner' })),
    toasts: h('div', { class: 'toasts', 'aria-live': 'polite' }),
  };

  /** Covers the chart while a shared view waits to use the viewer's API key. */
  private readonly keyCover = createKeyCover();
  private readonly symbolSearch;
  private readonly indicatorPanel;
  private readonly helpModal;
  private readonly styleControl;
  private topbar!: TopbarFit;

  constructor(
    private readonly root: HTMLElement,
    private readonly storage: KeyValueStorage,
    /** A chart opened from a share link; `storage` is then its temporary storage. */
    private readonly shared: SharedView | null = null,
  ) {
    this.store = new LayoutStore(storage);
    this.layout = this.store.loadLayout();
    this.symbolSearch = createSymbolSearch({
      storage,
      currentSource: () => this.layout.source,
      onPick: (sourceId, meta) => this.setSymbol(sourceId, meta),
    });
    this.indicatorPanel = createIndicatorPanel({
      list: () => this.indicators,
      add: (name) => this.addIndicator(name),
      remove: (id) => this.removeIndicator(id),
      update: (id, params) => this.updateIndicator(id, params),
      extraActive: (rerender) =>
        this.scripts
          ? scriptRows(this.scripts, {
              rerender,
              onEdit: (id) => (this.indicatorPanel.close(), void this.openScriptEditor(id)),
              symbols: () => loadSymbols(getSource(this.layout.source), this.storage).then((list) => list.map((s) => s.symbol)),
            })
          : [],
    });
    this.helpModal = this.buildHelp();
    this.styleControl = createChartStyleControl({
      get: () => this.chartStyle(),
      set: (change) => this.setChartStyle(change),
      hint: 'Alt+C for the next type',
    });
  }

  async start(): Promise<void> {
    registerCustomIndicators();
    registerCustomOverlays();
    registerChartTypes();
    this.render();
    this.applyTheme(this.layout.theme, false);

    const chart = init(this.el.chart, { locale: 'en-US', styles: this.layout.theme });
    if (!chart) throw new Error('Chart failed to initialise');
    this.chart = chart;
    this.chart.setStyles(chartStyles(this.layout.theme));
    this.chart.setOffsetRightDistance(60);
    applyChartType(this.chart, this.chartStyle().type);
    applyPriceScale(this.chart, this.chartStyle().scale);

    this.meta = await this.lookupMeta(this.layout.source, this.layout.symbol);
    this.chart.setSymbol(this.symbolInfo());
    this.chart.setPeriod(getTimeframe(this.layout.timeframe)!.period);
    this.features = createFeatures({ app: this, chart: this.chart, storage: this.storage, root: this.root, styles: chartStyles, topbar: this.topbar, shared: this.shared });
    this.chart.setDataLoader(
      this.features.wrapLoader(createDataLoader({
        resolve: () => ({ source: getSource(this.layout.source), symbol: this.layout.symbol, timeframe: this.layout.timeframe }),
        onError: (message) => this.toast(message, 'error'),
        onLoading: (loading) => {
          this.el.loading.hidden = !loading;
          if (!loading) this.refreshPriceFromChart();
        },
        onLiveCandle: (candle) => {
          this.updatePrice(candle);
          this.features.onLiveCandle(candle);
        },
        onStreamStatus: (status) => this.setStreamStatus(status),
        held: (source) => keyGate().holds(source.id),
        onHeld: (source) => this.keyCover.show(source),
      })),
    );
    keyGate().onRelease((id) => {
      if (id === this.layout.source) void this.reloadReleased();
    });

    for (const ind of this.layout.indicators) this.addIndicator(ind.name, ind.params, false);
    this.restoreDrawings();
    this.updateHeader();
    this.bindKeys();
    this.exposeForAutomation();
    this.initScripts();
    this.features.start();
    this.initDataSources();
    this.initCsvImport();
    // Warm the symbol list so search opens instantly.
    loadSymbols(getSource(this.layout.source), this.storage).catch(() => undefined);
  }

  // ---------------------------------------------------------------- layout

  private render(): void {
    const tfButtons = TIMEFRAMES.map((tf, i) =>
      h(
        'button',
        {
          class: 'seg-btn',
          dataset: { tf: tf.id },
          title: `${tf.label} (Alt+${i + 1})`,
          onclick: () => this.setTimeframe(tf.id),
        },
        tf.label,
      ),
    );
    this.el.timeframes.append(...tfButtons);
    const select = this.el.timeframeSelect;
    select.append(...TIMEFRAMES.map((tf) => h('option', { value: tf.id }, tf.label)));
    select.addEventListener('change', () => {
      this.setTimeframe(select.value as TimeframeId);
      // Back to the current one if the symbol does not have it.
      select.value = this.layout.timeframe;
    });
    this.el.symbolBtn.addEventListener('click', () => this.symbolSearch.open());
    this.el.themeBtn.addEventListener('click', () => this.toggleTheme());

    const indicatorsBtn = h(
      'button',
      { class: 'tb-btn', title: 'Indicators (/)', onclick: () => this.indicatorPanel.open() },
      h('span', { html: ICONS.indicators }),
      h('span', { class: 'tb-label' }, 'Indicators'),
    );
    const imageBtn = h('button', { class: 'icon-btn', dataset: { action: 'image' }, title: 'Save chart image', 'aria-label': 'Save chart image', html: ICONS.camera, onclick: () => this.saveImage() });
    const helpBtn = h('button', { class: 'icon-btn', title: 'Keyboard shortcuts (?)', 'aria-label': 'Keyboard shortcuts', html: ICONS.keyboard, onclick: () => this.helpModal.open() });
    const topbar = h(
      'header',
      { class: 'topbar' },
      h('div', { class: 'brand', title: APP.tagline }, h('span', { html: ICONS.logo }), h('span', { class: 'brand-name' }, APP.name)),
      this.el.symbolBtn,
      this.el.timeframes,
      this.el.timeframeSelect,
      this.styleControl.el,
      indicatorsBtn,
      h('div', { class: 'spacer' }),
      this.el.price,
      this.el.status,
      imageBtn,
      helpBtn,
      this.el.themeBtn,
    );
    this.topbar = createTopbarFit({ bar: topbar, timeframes: this.el.timeframes, timeframeSelect: select, watch: [this.el.price] });
    topbar.append(this.topbar.more);
    this.topbar.add(
      { id: 'chartType', el: this.styleControl.button, run: (anchor) => this.styleControl.open(anchor) },
      { id: 'indicators', el: indicatorsBtn },
      { id: 'image', el: imageBtn },
      { id: 'shortcuts', el: helpBtn },
      { id: 'theme', el: this.el.themeBtn },
    );

    this.renderDrawbar();
    const workspace = h('main', { class: 'workspace' }, this.el.drawbar, h('div', { class: 'chart-wrap' }, this.el.chart, this.el.loading, this.keyCover.el));
    this.root.replaceChildren(topbar, workspace, this.el.toasts);
  }

  private renderDrawbar(): void {
    const tools = DRAWING_TOOLS.map((tool) =>
      h('button', {
        class: 'tool-btn',
        dataset: { tool: tool.overlay },
        title: tool.shortcut ? `${tool.label} (${shortcutLabel(tool.shortcut)})` : tool.label,
        'aria-label': tool.label,
        html: tool.icon,
        onclick: () => this.startTool(tool.overlay),
      }),
    );
    const magnet = h('button', {
      class: 'tool-btn',
      dataset: { action: 'magnet' },
      title: 'Magnet: snap to candle prices (Alt+M)',
      'aria-label': 'Magnet',
      html: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M6 4v8a6 6 0 0 0 12 0V4"/><path d="M6 8h4M14 8h4"/></svg>',
      onclick: () => this.toggleMagnet(),
    });
    this.el.drawbar.replaceChildren(
      h('button', { class: 'tool-btn', dataset: { action: 'cursor' }, title: 'Cursor (Esc)', 'aria-label': 'Cursor', html: ICONS.cursor, onclick: () => this.cancelTool() }),
      ...tools,
      h('div', { class: 'tool-sep' }),
      magnet,
      h('button', { class: 'tool-btn', dataset: { action: 'delete' }, title: 'Delete selected drawing (Delete)', 'aria-label': 'Delete selected drawing', html: ICONS.trash, onclick: () => this.deleteSelected() }),
      h('button', { class: 'tool-btn', dataset: { action: 'clear' }, title: 'Remove all drawings on this symbol', 'aria-label': 'Remove all drawings', html: ICONS.clear, onclick: () => this.clearDrawings() }),
    );
    this.updateDrawbar();
  }

  private updateDrawbar(): void {
    this.el.drawbar.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === this.activeTool));
    this.el.drawbar.querySelector('[data-action="cursor"]')?.classList.toggle('active', this.activeTool === null);
    this.el.drawbar.querySelector('[data-action="magnet"]')?.classList.toggle('active', this.magnet);
    const del = this.el.drawbar.querySelector<HTMLButtonElement>('[data-action="delete"]');
    if (del) del.disabled = this.selectedDrawing === null;
  }

  private updateHeader(): void {
    const source = getSource(this.layout.source);
    this.el.symbolBtn.replaceChildren(
      h('span', { html: ICONS.search, class: 'symbol-icon' }),
      h('span', { class: 'symbol-name' }, this.meta ? displayName(this.meta) : this.layout.symbol),
      h('span', { class: 'symbol-source muted' }, source.name),
    );
    const allowed = this.allowedTimeframes();
    this.el.timeframes.querySelectorAll<HTMLButtonElement>('[data-tf]').forEach((b) => {
      const on = b.dataset.tf === this.layout.timeframe;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
      b.disabled = !allowed.includes(b.dataset.tf as TimeframeId);
    });
    for (const option of this.el.timeframeSelect.options) option.disabled = !allowed.includes(option.value as TimeframeId);
    this.el.timeframeSelect.value = this.layout.timeframe;
    // The symbol button may be squeezed, so a longer name does not always resize it.
    this.topbar.schedule();
    document.title = `${this.layout.symbol} ${getTimeframe(this.layout.timeframe)?.label ?? ''} - ${APP.name}`;
  }

  // ---------------------------------------------------------------- symbol + timeframe

  /** Uses the cached symbol list when present, otherwise asks the exchange about one symbol. */
  private async lookupMeta(sourceId: string, symbol: string): Promise<SymbolMeta | null> {
    const source = getSource(sourceId);
    const cached = cachedSymbols(source, this.storage)?.find((s) => s.symbol === symbol);
    if (cached) return cached;
    // Some keyed sources look a symbol up with the key.
    if (keyGate().holds(sourceId)) return null;
    try {
      return await Promise.race([
        source.getSymbol(symbol),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
      ]);
    } catch {
      return null;
    }
  }

  /** Loads the main chart after the user let its keyed source load. */
  private async reloadReleased(): Promise<void> {
    const { source, symbol } = this.layout;
    const meta = await this.lookupMeta(source, symbol);
    // A symbol picked meanwhile has loaded already.
    if (this.layout.source !== source || this.layout.symbol !== symbol) return;
    if (meta) this.meta = meta;
    this.chart.setSymbol(this.symbolInfo());
    this.updateHeader();
  }

  private symbolInfo() {
    return {
      ticker: this.layout.symbol,
      pricePrecision: this.meta?.pricePrecision ?? 2,
      volumePrecision: this.meta?.volumePrecision ?? 4,
    };
  }

  /** Timeframes the current symbol can be shown in. Imported data only goes up from its own. */
  private allowedTimeframes(sourceId = this.layout.source, symbol = this.layout.symbol): readonly TimeframeId[] {
    return getSource(sourceId).timeframesFor?.(symbol) ?? TIMEFRAMES.map((tf) => tf.id);
  }

  setSymbol(sourceId: string, meta: SymbolMeta): void {
    if (sourceId === this.layout.source && meta.symbol === this.layout.symbol) return;
    this.cancelTool();
    this.removeAllDrawingsFromChart();
    // Imported data only goes up from its own timeframe; switch to one it has.
    const allowed = this.allowedTimeframes(sourceId, meta.symbol);
    const timeframe = allowed.includes(this.layout.timeframe) || allowed.length === 0 ? this.layout.timeframe : allowed[0];
    const periodChanged = timeframe !== this.layout.timeframe;
    this.layout = { ...this.layout, source: sourceId, symbol: meta.symbol, timeframe };
    if (periodChanged) this.chart.setPeriod(getTimeframe(timeframe)!.period);
    this.meta = meta;
    this.lastPrice = null;
    this.el.price.textContent = '';
    this.persistLayout();
    this.chart.setSymbol(this.symbolInfo());
    this.restoreDrawings();
    this.updateHeader();
  }

  setTimeframe(id: TimeframeId): void {
    if (id === this.layout.timeframe) return;
    const tf = getTimeframe(id);
    if (!tf) return;
    if (!this.allowedTimeframes().includes(id)) {
      this.toast(`${this.meta ? displayName(this.meta) : this.layout.symbol} can be shown in ${this.allowedTimeframes().map((t) => getTimeframe(t)!.label).join(', ')}`, 'error');
      return;
    }
    this.cancelTool();
    this.layout = { ...this.layout, timeframe: id };
    this.persistLayout();
    this.chart.setPeriod(tf.period);
    this.updateHeader();
  }

  // ---------------------------------------------------------------- indicators

  addIndicator(name: string, params?: number[], persist = true): string | null {
    const def = getIndicatorDef(name);
    const pane = def?.pane ?? 'sub';
    const calcParams = params ?? def?.defaults ?? [];
    const id =
      pane === 'main'
        ? this.chart.createIndicator({ name, calcParams, paneId: CANDLE_PANE }, true)
        : this.chart.createIndicator({ name, calcParams }, false);
    if (!id) {
      this.toast(`Indicator ${name} is not available`, 'error');
      return null;
    }
    const created = this.chart.getIndicators({ id })[0];
    if (pane === 'sub' && created) this.chart.setPaneOptions({ id: created.paneId, height: 90 });
    this.indicators.push({ id, name, pane, params: [...((created?.calcParams as number[] | undefined) ?? calcParams)] });
    if (persist) this.persistIndicators();
    this.indicatorPanel.refresh();
    return id;
  }

  removeIndicator(id: string): void {
    this.chart.removeIndicator({ id });
    this.indicators = this.indicators.filter((i) => i.id !== id);
    this.persistIndicators();
  }

  updateIndicator(id: string, params: number[]): void {
    const ind = this.indicators.find((i) => i.id === id);
    if (!ind) return;
    ind.params = [...params];
    this.chart.overrideIndicator({ name: ind.name, id, calcParams: ind.params });
    this.persistIndicators();
  }

  private persistIndicators(): void {
    this.layout = { ...this.layout, indicators: this.indicators.map((i) => ({ name: i.name, params: i.params, pane: i.pane })) };
    this.persistLayout();
  }

  // ---------------------------------------------------------------- drawings

  private overlayHandlers() {
    return {
      onDrawEnd: (e: OverlayEvent<unknown>) => {
        void this.finishDrawing(e.overlay);
      },
      onPressedMoveEnd: () => this.saveDrawings(),
      onRemoved: (e: OverlayEvent<unknown>) => {
        if (this.selectedDrawing === e.overlay.id) this.selectedDrawing = null;
        if (this.pendingDrawing === e.overlay.id) {
          this.pendingDrawing = null;
          this.activeTool = null;
        }
        this.updateDrawbar();
        // The engine fires this before it drops the overlay from its list.
        setTimeout(() => this.saveDrawings(), 0);
      },
      onSelected: (e: OverlayEvent<unknown>) => {
        this.selectedDrawing = e.overlay.id;
        this.updateDrawbar();
      },
      onDeselected: (e: OverlayEvent<unknown>) => {
        if (this.selectedDrawing === e.overlay.id) this.selectedDrawing = null;
        this.updateDrawbar();
      },
      onDoubleClick: (e: OverlayEvent<unknown>) => {
        if (e.overlay.name === 'textNote') void this.editText(e.overlay as Overlay<{ text?: string }>);
      },
    };
  }

  startTool(overlayName: string): void {
    this.cancelTool();
    const id = this.chart.createOverlay({
      name: overlayName,
      groupId: DRAWINGS_GROUP,
      mode: this.magnet ? 'weak_magnet' : 'normal',
      ...this.overlayHandlers(),
    });
    if (typeof id !== 'string') {
      this.toast(`Drawing tool ${overlayName} is not available`, 'error');
      return;
    }
    this.pendingDrawing = id;
    this.activeTool = overlayName;
    this.updateDrawbar();
  }

  cancelTool(): void {
    const pending = this.pendingDrawing;
    this.pendingDrawing = null;
    this.activeTool = null;
    if (pending) {
      const overlay = this.chart?.getOverlays({ id: pending })[0];
      if (overlay && overlay.currentStep !== -1) this.chart.removeOverlay({ id: pending });
    }
    this.updateDrawbar();
  }

  private async finishDrawing(overlay: Overlay): Promise<void> {
    if (this.pendingDrawing === overlay.id) {
      this.pendingDrawing = null;
      this.activeTool = null;
      this.updateDrawbar();
    }
    if (overlay.name === 'textNote' && !(overlay.extendData as { text?: string } | undefined)?.text) {
      const text = await promptText('Text note');
      if (!text) {
        this.chart.removeOverlay({ id: overlay.id });
        return;
      }
      this.chart.overrideOverlay({ id: overlay.id, extendData: { text } });
    }
    this.saveDrawings();
  }

  private async editText(overlay: Overlay<{ text?: string }>): Promise<void> {
    const text = await promptText('Edit note', overlay.extendData?.text ?? '');
    if (text === null) return;
    if (text === '') this.chart.removeOverlay({ id: overlay.id });
    else {
      this.chart.overrideOverlay({ id: overlay.id, extendData: { text } });
      this.saveDrawings();
    }
  }

  deleteSelected(): void {
    if (this.selectedDrawing) this.chart.removeOverlay({ id: this.selectedDrawing });
  }

  clearDrawings(): void {
    const count = this.chart.getOverlays({ groupId: DRAWINGS_GROUP }).length;
    if (count === 0) return;
    if (!window.confirm(`Remove all ${count} drawings on ${this.layout.symbol}?`)) return;
    this.chart.removeOverlay({ groupId: DRAWINGS_GROUP });
  }

  toggleMagnet(): void {
    this.magnet = !this.magnet;
    for (const o of this.chart.getOverlays({ groupId: DRAWINGS_GROUP })) {
      this.chart.overrideOverlay({ id: o.id, mode: this.magnet ? 'weak_magnet' : 'normal' });
    }
    this.updateDrawbar();
  }

  private serializeDrawings(): DrawingRecord[] {
    return this.chart
      .getOverlays({ groupId: DRAWINGS_GROUP })
      .filter((o) => o.currentStep === -1)
      .map((o) => {
        const record: DrawingRecord = {
          name: o.name,
          points: o.points
            .filter((p) => typeof p.timestamp === 'number' && typeof p.value === 'number')
            .map((p) => ({ timestamp: p.timestamp as number, value: p.value as number })),
        };
        const text = (o.extendData as { text?: string } | undefined)?.text;
        if (text) record.text = text;
        return record;
      });
  }

  private saveDrawings(): void {
    if (this.restoringDrawings || !this.chart) return;
    this.store.saveDrawings(this.layout.source, this.layout.symbol, this.serializeDrawings());
  }

  private removeAllDrawingsFromChart(): void {
    this.restoringDrawings = true;
    this.chart.removeOverlay({ groupId: DRAWINGS_GROUP });
    this.selectedDrawing = null;
    // onRemoved schedules saves; keep them suppressed until they have run.
    setTimeout(() => {
      this.restoringDrawings = false;
    }, 0);
  }

  private restoreDrawings(): void {
    const records = this.store.loadDrawings(this.layout.source, this.layout.symbol);
    if (records.length === 0) return;
    const handlers = this.overlayHandlers();
    this.chart.createOverlay(
      records.map((r) => ({
        name: r.name,
        groupId: DRAWINGS_GROUP,
        points: r.points,
        extendData: r.text ? { text: r.text } : undefined,
        mode: this.magnet ? ('weak_magnet' as const) : ('normal' as const),
        ...handlers,
      })),
    );
  }

  // ---------------------------------------------------------------- theme, price, status

  toggleTheme(): void {
    this.applyTheme(this.layout.theme === 'dark' ? 'light' : 'dark', true);
  }

  private applyTheme(theme: Theme, persist: boolean): void {
    document.documentElement.dataset.theme = theme;
    this.el.themeBtn.innerHTML = theme === 'dark' ? ICONS.sun : ICONS.moon;
    if (this.chart) {
      this.chart.setStyles(theme);
      this.chart.setStyles(chartStyles(theme));
      applyChartType(this.chart, this.chartStyle().type);
    }
    if (persist) {
      this.layout = { ...this.layout, theme };
      this.persistLayout();
    }
  }

  // ---------------------------------------------------------------- chart type and scale

  chartStyle(): ChartStyle {
    return { type: this.layout.chartType ?? 'candles', scale: this.layout.scale ?? 'normal' };
  }

  /** Changes how bars are drawn and the price scale. Indicators, scripts and alerts keep reading the real bars. */
  setChartStyle(change: Partial<ChartStyle>): ChartStyle {
    const current = this.chartStyle();
    const next = { ...current, ...change };
    if (next.type !== current.type) applyChartType(this.chart, next.type);
    if (next.scale !== current.scale) applyPriceScale(this.chart, next.scale);
    this.layout = { ...this.layout, chartType: next.type, scale: next.scale };
    this.persistLayout();
    this.styleControl.refresh();
    return next;
  }

  private refreshPriceFromChart(): void {
    const list = this.chart.getDataList();
    const last = list[list.length - 1];
    if (last) this.updatePrice({ time: last.timestamp, open: last.open, high: last.high, low: last.low, close: last.close, volume: last.volume ?? 0 });
  }

  private updatePrice(candle: Candle): void {
    const precision = this.meta?.pricePrecision ?? 2;
    const prev = this.lastPrice;
    this.lastPrice = candle.close;
    const change = candle.open ? ((candle.close - candle.open) / candle.open) * 100 : 0;
    this.el.price.replaceChildren(
      h('span', { class: `price-last ${prev === null ? '' : candle.close >= prev ? 'tick-up' : 'tick-down'}` }, candle.close.toFixed(precision)),
      h('span', { class: `price-change ${change >= 0 ? 'up' : 'down'}`, title: 'Change since the current bar opened' }, `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`),
    );
  }

  private setStreamStatus(status: StreamStatus): void {
    const labels: Record<StreamStatus, string> = { connecting: 'Connecting', live: 'Live', reconnecting: 'Reconnecting', closed: 'Offline', polling: 'Polling', delayed: 'Delayed', static: 'Static' };
    this.el.status.className = `status status-${status}`;
    this.el.status.replaceChildren(h('span', { class: 'dot' }), h('span', { class: 'status-label' }, labels[status]));
  }

  private saveImage(): void {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#0f1115';
    const url = this.chart.getConvertPictureUrl(true, 'png', bg);
    const a = h('a', { href: url, download: `${APP.id}-${this.layout.symbol}-${this.layout.timeframe}.png` });
    document.body.append(a);
    a.click();
    a.remove();
  }

  toast(message: string, kind: 'info' | 'error' = 'info'): void {
    const t = h('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
    this.el.toasts.append(t);
    setTimeout(() => t.remove(), kind === 'error' ? 6000 : 3000);
  }

  /** Shows the banner for a newer build (src/update.ts) above the toasts. */
  offerUpdate(): void {
    if (this.el.toasts.querySelector('.update-banner')) return;
    this.el.toasts.prepend(createUpdateBanner({ beforeReload: () => this.prepareReload() }));
  }

  /**
   * Before a reload into a new build: saves the drawings and the script draft now (they are
   * otherwise saved a moment after each change) and returns what a reload would still lose.
   * Layouts, indicators, scripts on the chart, the watchlist and alerts are saved as they change.
   */
  prepareReload(): string[] {
    this.saveDrawings();
    this.scriptPanel?.saveDraft();
    const lost: string[] = [];
    if (this.shared?.storage.temporary) lost.push('This shared chart opens again as the link has it, without your changes. Use Keep it to save it as your chart first.');
    if (this.features.replayActive()) lost.push('Bar replay ends.');
    return lost;
  }

  private persistLayout(): void {
    if (!this.store.saveLayout(this.layout)) this.toast('Could not save layout to browser storage', 'error');
  }

  // ---------------------------------------------------------------- keyboard

  private bindKeys(): void {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const modal = topModal();
        if (modal) {
          e.preventDefault();
          modal.close();
          return;
        }
        if (this.pendingDrawing) {
          this.cancelTool();
          return;
        }
      }
      if (isTypingTarget(e.target) || topModal()) return;

      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        // Alt changes e.key on macOS (Alt+H gives "˙"), so match on the physical key code.
        const code = e.code || (/^[a-z]$/i.test(e.key) ? `Key${e.key.toUpperCase()}` : /^[0-9]$/.test(e.key) ? `Digit${e.key}` : '');
        const tool = DRAWING_TOOLS.find((t) => t.shortcut === code);
        if (tool) {
          e.preventDefault();
          this.startTool(tool.overlay);
          return;
        }
        const digit = /^Digit([1-9])$/.exec(code);
        if (digit) {
          const tf = TIMEFRAMES[Number(digit[1]) - 1];
          if (tf) {
            e.preventDefault();
            this.setTimeframe(tf.id);
          }
          return;
        }
        if (code === 'KeyL') {
          e.preventDefault();
          this.toggleTheme();
          return;
        }
        if (code === 'KeyM') {
          e.preventDefault();
          this.toggleMagnet();
          return;
        }
        if (code === 'KeyI') {
          e.preventDefault();
          this.indicatorPanel.open();
          return;
        }
        if (code === 'KeyC') {
          e.preventDefault();
          const { type } = this.setChartStyle({ type: nextChartType(this.chartStyle().type) });
          this.toast(CHART_TYPE_LABELS[type]);
          return;
        }
        return;
      }
      if (e.ctrlKey || e.metaKey) return;

      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedDrawing) {
        e.preventDefault();
        this.deleteSelected();
        return;
      }
      if (e.key === '/') {
        e.preventDefault();
        this.indicatorPanel.open();
        return;
      }
      if (e.key === '?') {
        e.preventDefault();
        this.helpModal.open();
        return;
      }
      if (/^[a-zA-Z0-9]$/.test(e.key)) {
        e.preventDefault();
        this.symbolSearch.open(e.key.toUpperCase());
      }
    });
  }

  private buildHelp() {
    const modal = createModal('Keyboard shortcuts', { className: 'modal-small' });
    const rows: Array<[string, string]> = [
      ['Any letter or digit', 'Search symbols'],
      ['/ or Alt+I', 'Indicators'],
      ['Alt+1 ... Alt+7', 'Timeframes 1m to 1W'],
      ...DRAWING_TOOLS.filter((t) => t.shortcut).map((t): [string, string] => [shortcutLabel(t.shortcut!), t.label]),
      ['Alt+M', 'Magnet on or off'],
      ['Alt+C', 'Next chart type'],
      ['Delete / Backspace', 'Delete selected drawing'],
      ['Double click a note', 'Edit note text'],
      ['Esc', 'Cancel drawing or close dialog'],
      ['Alt+L', 'Light or dark theme'],
      ['Alt+W', 'Show or hide the watchlist'],
      ['Alt+K', 'Share a link to this chart'],
      ['?', 'This list'],
    ];
    modal.body.append(
      h('table', { class: 'shortcuts' }, h('tbody', {}, ...rows.map(([k, v]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, v))))),
    );
    return modal;
  }

  /**
   * A small, stable handle for scripts and future agent tooling. Week 3 wires this to the
   * MCP bridge; for now it is handy for debugging from the console.
   */
  private exposeForAutomation(): void {
    (window as unknown as Record<string, unknown>)[APP.id] = {
      getState: () => ({
        ...this.layout,
        chartType: this.chartStyle().type,
        scale: this.chartStyle().scale,
        drawings: this.serializeDrawings(),
        bars: this.chart.getDataList().length,
        lastPrice: this.lastPrice,
      }),
      setSymbol: async (symbol: string, sourceId = this.layout.source) => {
        const list = await loadSymbols(getSource(sourceId), this.storage);
        const meta = list.find((s) => s.symbol === symbol);
        if (!meta) throw new Error(`Unknown symbol ${symbol}`);
        this.setSymbol(sourceId, meta);
      },
      setTimeframe: (tf: TimeframeId) => {
        if (!getTimeframe(tf)) throw new Error(`Unknown timeframe ${tf}. Use one of ${TIMEFRAMES.map((t) => t.id).join(', ')}`);
        this.setTimeframe(tf);
      },
      /** { type, scale }: type is candles, hollow_candles, bars, line, area or heikin_ashi; scale is normal, log or percent. */
      setChartStyle: (style: { type?: unknown; scale?: unknown }) => this.setChartStyle(parseChartStyleChange(style ?? {})),
      addIndicator: (name: string, params?: number[]) => this.addIndicator(name, params),
      removeIndicator: (id: string) => this.removeIndicator(id),
      listIndicators: () => this.indicators.map((i) => ({ ...i })),
      draw: (name: string, points: Array<{ timestamp: number; value: number }>, text?: string) => {
        const id = this.chart.createOverlay({
          name,
          groupId: DRAWINGS_GROUP,
          points,
          extendData: text ? { text } : undefined,
          ...this.overlayHandlers(),
        });
        this.saveDrawings();
        return id;
      },
      chart: () => this.chart,
    };
  }

  // ---------------------------------------------------------------- scripts

  private scripts: ScriptManager | null = null;
  private scriptPanel: ScriptPanel | null = null;
  private scriptPanelLoading: Promise<ScriptPanel> | null = null;
  private readonly scriptsBtn = h('button', { class: 'tb-btn', title: 'Script editor (Alt+S)' }, h('span', { class: 'tb-icon', html: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 5l-3 14"/></svg>' }), h('span', { class: 'tb-label' }, 'Scripts'));

  /** Sets up user scripts: restores saved ones, adds the toolbar button and the automation API. */
  private initScripts(): void {
    const manager = new ScriptManager({
      chart: () => this.chart,
      candlePaneId: CANDLE_PANE,
      symbol: () => symbolContext(this.layout.symbol, getTimeframe(this.layout.timeframe)?.ms ?? 3_600_000, this.meta?.pricePrecision ?? 2, this.layout.source),
      feeds: new SeriesFeeds({ source: (id) => SOURCES.find((s) => s.id === id) }),
      persist: (records) => {
        this.layout = { ...this.layout, scripts: records };
        this.persistLayout();
      },
      toast: (message, kind) => this.toast(message, kind),
    });
    this.scripts = manager;
    manager.restore(this.layout.scripts ?? []);
    manager.onChange(() => this.indicatorPanel.refresh());

    this.scriptsBtn.addEventListener('click', () => void this.toggleScriptEditor());
    const indicatorsBtn = this.root.querySelector('.topbar .tb-btn');
    if (indicatorsBtn) indicatorsBtn.after(this.scriptsBtn);
    this.topbar.add({ id: 'scripts', el: this.scriptsBtn });
    document.addEventListener('keydown', (e) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyS' && !topModal()) {
        e.preventDefault();
        void this.toggleScriptEditor();
      }
    });

    const api = scriptApi(manager);
    const runScript = api.runScript;
    // A strategy run from automation opens its results, so the user sees what the agent did.
    api.runScript = async (source, options) => {
      const res = await runScript(source, options);
      if (res.ok && res.id && 'backtest' in res) void this.showStrategyResults(res.id);
      return res;
    };
    const handle = (window as unknown as Record<string, unknown>)[APP.id];
    if (handle && typeof handle === 'object') Object.assign(handle, api);
  }

  async showStrategyResults(scriptId?: string): Promise<void> {
    const panel = await this.loadScriptPanel();
    panel.showStrategy(scriptId);
  }

  private loadScriptPanel(): Promise<ScriptPanel> {
    if (this.scriptPanel) return Promise.resolve(this.scriptPanel);
    this.scriptPanelLoading ??= import('./ui/scriptPanel').then(({ createScriptPanel }) => {
      const panel = createScriptPanel({ manager: this.scripts!, storage: this.storage, toast: (m, k) => this.toast(m, k),
        onVisibilityChange: (open) => this.scriptsBtn.classList.toggle('active', open),
        onShowTime: (time) => this.chart.scrollToTimestamp(time, 200),
      });
      this.root.querySelector('.workspace')?.after(panel.root);
      this.scriptPanel = panel;
      return panel;
    });
    return this.scriptPanelLoading;
  }

  async openScriptEditor(scriptId?: string): Promise<void> {
    const panel = await this.loadScriptPanel();
    panel.open(scriptId);
  }

  async toggleScriptEditor(): Promise<void> {
    const panel = await this.loadScriptPanel();
    panel.toggle();
  }

  // ---------------------------------------------------------------- CSV import

  /** Imported files open on the main chart; deleting the one on the chart switches back to the default market. */
  private initCsvImport(): void {
    setCsvImportHandler((sourceId, meta) => {
      const d = csvStore().get(meta.symbol);
      this.setSymbol(sourceId, meta);
      if (d) this.toast(`${d.name}: ${d.bars.toLocaleString('en-US')} bars of ${getTimeframe(d.timeframe)!.label}`);
    });
    const wrap = this.root.querySelector<HTMLElement>('.chart-wrap');
    if (wrap) bindCsvDrop(wrap);
    csvStore().onChange(() => {
      if (this.layout.source !== CSV_SOURCE_ID || csvStore().get(this.layout.symbol)) return;
      void this.lookupMeta(DEFAULT_LAYOUT.source, DEFAULT_LAYOUT.symbol).then((meta) =>
        this.setSymbol(DEFAULT_LAYOUT.source, meta ?? { symbol: DEFAULT_LAYOUT.symbol, base: 'BTC', quote: 'USDT', pricePrecision: 2, volumePrecision: 5 }),
      );
    });
  }

  // ---------------------------------------------------------------- data sources

  /** Adds the Data sources button and reloads the main chart when its source's key changes. */
  private initDataSources(): void {
    const status = this.root.querySelector('.topbar .status');
    const button = createDataSourcesButton();
    status?.before(button);
    this.topbar.add({ id: 'data', el: button });
    keyStore().onChange((sourceId) => {
      if (sourceId === this.layout.source) this.chart.resetData();
    });
  }
}
