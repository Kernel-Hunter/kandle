/**
 * Embed mode (?embed=1): the chart from a share link and nothing else, for an iframe on
 * another site. There is no top bar, drawing toolbar, panel, alert, agent bridge or
 * window.kandle, and nothing the parent page can call; pan, zoom and the crosshair work.
 * Storage stays in memory (src/embed/state.ts) and scripts in the link never run. A footer
 * names the chart and links to it in the full app.
 */
import { init, type Chart, type Crosshair, type DeepPartial, type Styles } from 'klinecharts';
import { chartStyles } from '../app';
import { APP } from '../config';
import { applyChartType, applyPriceScale, registerChartTypes } from '../chart/chartStyleRender';
import { getIndicatorDef, registerCustomIndicators } from '../chart/indicators';
import { createDataLoader } from '../chart/loader';
import { registerCustomOverlays } from '../chart/overlays';
import { displayName } from '../data/search';
import { getSource } from '../data/sources';
import { getTimeframe } from '../data/timeframes';
import type { Candle, SymbolMeta } from '../data/types';
import { gridShape } from '../layout/config';
import { SwitchingLoader } from '../replay/loader';
import { applyRange } from '../share';
import { ShareError, decodeShareHash, isShareHash } from '../share/codec';
import { SCRIPTS_NOT_RUN, appPage, openInAppUrl, type EmbedParams } from '../share/embed';
import type { Theme } from '../store/layout';
import { h, ICONS } from '../ui/dom';
import { embedLayout, isolateStorage, type EmbedPane } from './state';
import './embed.css';

const CANDLE_PANE = 'candle_pane';

/** The footer names the chart, so the price pane drops its title row. */
const EMBED_STYLES: DeepPartial<Styles> = { candle: { tooltip: { title: { show: false } } } };
/** Small embeds show the bar and indicator values only under the crosshair, so they do not cover the bars. */
const COMPACT_STYLES: DeepPartial<Styles> = { candle: { tooltip: { showRule: 'follow_cross' } }, indicator: { tooltip: { showRule: 'follow_cross' } } };

interface MountedPane {
  spec: EmbedPane;
  chart: Chart;
  setTheme(theme: Theme): void;
}

interface PaneHooks {
  theme: Theme;
  note(text: string): void;
  onPrice?(candle: Candle, meta: SymbolMeta | null): void;
}

function tfLabel(spec: EmbedPane): string {
  return getTimeframe(spec.timeframe)?.label ?? spec.timeframe;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

async function lookupMeta(spec: EmbedPane): Promise<SymbolMeta | null> {
  try {
    return await Promise.race([getSource(spec.source).getSymbol(spec.symbol), new Promise<null>((r) => setTimeout(() => r(null), 4000))]);
  } catch {
    return null;
  }
}

/** One read-only chart: data, indicators, locked drawings and the shared view. */
async function mountPane(cell: HTMLElement, spec: EmbedPane, hooks: PaneHooks): Promise<MountedPane | null> {
  const source = getSource(spec.source);
  if (source.auth) {
    // API keys stay out of embeds, so these sources have nothing to load.
    cell.append(h('p', { class: 'em-cover' }, `This chart needs an API key. Open it in ${APP.name} to see it.`));
    return null;
  }
  const el = h('div', { class: 'chart' });
  const loading = h('div', { class: 'loading', hidden: true }, h('span', { class: 'spinner' }));
  cell.append(el, loading);
  const chart = init(el, { locale: 'en-US', styles: hooks.theme });
  if (!chart) {
    hooks.note(`${spec.symbol} could not be drawn in this browser.`);
    return null;
  }
  const compact = cell.clientWidth < 480 || cell.clientHeight < 300;
  const setTheme = (theme: Theme) => {
    chart.setStyles(theme);
    chart.setStyles(chartStyles(theme));
    chart.setStyles(EMBED_STYLES);
    if (compact) chart.setStyles(COMPACT_STYLES);
    applyChartType(chart, spec.style.type);
  };
  setTheme(hooks.theme);
  applyPriceScale(chart, spec.style.scale);
  chart.setOffsetRightDistance(compact ? 24 : 60);

  const meta = await lookupMeta(spec);
  chart.setSymbol({ ticker: spec.symbol, pricePrecision: meta?.pricePrecision ?? 2, volumePrecision: meta?.volumePrecision ?? 4 });
  chart.setPeriod(getTimeframe(spec.timeframe)!.period);

  // Each indicator pane gets at most a fifth of the height and all of them two fifths, so small embeds keep room for the bars.
  const subs = spec.indicators.filter((i) => (getIndicatorDef(i.name)?.pane ?? 'sub') === 'sub').length;
  const subHeight = Math.max(20, Math.min(90, Math.round(cell.clientHeight * 0.2), Math.floor((cell.clientHeight * 0.4) / Math.max(1, subs))));
  for (const ind of spec.indicators) {
    const pane = getIndicatorDef(ind.name)?.pane ?? 'sub';
    const id = pane === 'main' ? chart.createIndicator({ name: ind.name, calcParams: ind.params, paneId: CANDLE_PANE }, true) : chart.createIndicator({ name: ind.name, calcParams: ind.params }, false);
    const created = id ? chart.getIndicators({ id })[0] : undefined;
    if (pane === 'sub' && created) chart.setPaneOptions({ id: created.paneId, height: subHeight });
  }
  if (spec.drawings.length > 0) {
    chart.createOverlay(spec.drawings.map((d) => ({ name: d.name, groupId: 'drawings', points: d.points, extendData: d.text ? { text: d.text } : undefined, lock: true })));
  }

  const loader = new SwitchingLoader(
    createDataLoader({
      resolve: () => ({ source, symbol: spec.symbol, timeframe: spec.timeframe }),
      onError: (message) => hooks.note(message),
      onLoading: (on) => {
        loading.hidden = !on;
        const bars = chart.getDataList();
        const last = bars[bars.length - 1];
        if (!on && last) hooks.onPrice?.({ time: last.timestamp, open: last.open, high: last.high, low: last.low, close: last.close, volume: last.volume ?? 0 }, meta);
      },
      onLiveCandle: (candle) => hooks.onPrice?.(candle, meta),
    }),
  );
  chart.setDataLoader(loader);
  const range = spec.range;
  if (range) loader.nextLoad(30_000).then(() => applyRange(chart, range), () => undefined);
  return { spec, chart, setTheme };
}

/** Moves the crosshair of every other chart to the time under the pointer, as layouts do in the app. */
function syncCrosshairs(panes: MountedPane[], cells: HTMLElement[]): void {
  let syncing = false;
  for (const from of panes) {
    from.chart.subscribeAction('onCrosshairChange', (data?: unknown) => {
      const c = data as Crosshair | undefined;
      if (syncing || !c || typeof c.x !== 'number') return;
      const converted = from.chart.convertFromPixel([{ x: c.x, y: c.y }], { paneId: c.paneId ?? CANDLE_PANE });
      const point = Array.isArray(converted) ? converted[0] : converted;
      if (point?.timestamp === undefined) return;
      syncing = true;
      try {
        for (const to of panes) {
          if (to === from) continue;
          const same = to.spec.source === from.spec.source && to.spec.symbol === from.spec.symbol && c.paneId === CANDLE_PANE;
          const target = to.chart.convertToPixel({ timestamp: point.timestamp, value: same ? point.value : undefined }, { paneId: CANDLE_PANE });
          const coord = Array.isArray(target) ? target[0] : target;
          if (typeof coord?.x !== 'number') continue;
          // Without a matching price, park the horizontal hair above the pane so only the time line shows.
          to.chart.executeAction('onCrosshairChange', { x: coord.x, y: same && typeof coord.y === 'number' ? coord.y : -1000, paneId: CANDLE_PANE });
        }
      } finally {
        syncing = false;
      }
    });
  }
  for (const cell of cells) {
    cell.addEventListener('mouseleave', () => {
      for (const p of panes) p.chart.executeAction('onCrosshairChange', null as unknown as Crosshair);
    });
  }
}

function openLink(href: string, label: string): HTMLAnchorElement {
  return h('a', { class: 'em-open', href, target: '_blank', rel: 'noopener', title: `Open this chart in ${APP.name} in a new tab` }, h('span', { class: 'em-logo', html: ICONS.logo }), h('span', {}, label));
}

/** Shown instead of a chart when the link has none or cannot be read. */
function showMessage(root: HTMLElement, text: string, href: string): void {
  root.replaceChildren(h('div', { class: 'em-message' }, h('p', {}, text), openLink(href, `Open ${APP.name}`)));
}

export async function startEmbed(root: HTMLElement, params: EmbedParams): Promise<void> {
  isolateStorage();
  root.classList.add('embed');
  const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: light)') : null;
  const pickTheme = (): Theme => params.theme ?? (media?.matches ? 'light' : 'dark');
  let theme = pickTheme();
  document.documentElement.dataset.theme = theme;

  const open = openInAppUrl(window.location.href, window.location.hash);
  if (!isShareHash(window.location.hash)) {
    showMessage(root, `This embed has no chart in its link. Make one in ${APP.name} with Share, then Embed.`, open);
    return;
  }
  let decoded: Awaited<ReturnType<typeof decodeShareHash>>;
  try {
    decoded = await decodeShareHash(window.location.hash);
  } catch (error) {
    // The app would only say the same, so link to the app without the broken chart.
    showMessage(root, `Could not open the chart. ${error instanceof ShareError ? error.message : 'The link could not be read.'}`, appPage(window.location.href));
    return;
  }

  registerCustomIndicators();
  registerCustomOverlays();
  registerChartTypes();

  const layout = embedLayout(decoded.chart);
  const main = layout.panes[0];
  document.title = `${main.symbol} ${tfLabel(main)} - ${APP.name}`;

  const { columns, rows } = gridShape(layout.count);
  const many = layout.panes.length > 1;
  const cells = layout.panes.map((spec, i) => {
    const body = h('div', { class: 'em-body' });
    const head = many ? h('div', { class: 'em-head' }, h('span', { class: 'em-num' }, String(i + 1)), h('span', {}, `${spec.symbol} ${tfLabel(spec)}`), h('span', { class: 'muted' }, getSource(spec.source).name)) : null;
    return { body, el: h('div', { class: 'em-cell' }, head, body) };
  });
  const grid = h('div', { class: 'em-grid' }, ...cells.map((c) => c.el));
  grid.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;
  grid.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;

  const notes = h('div', { class: 'em-notes', 'aria-live': 'polite' });
  const name = h('span', { class: 'em-symbol' }, main.symbol);
  const price = h('span', { class: 'em-price' });
  const footer = h(
    'footer',
    { class: 'em-foot' },
    h('span', { class: 'em-label' }, name, h('span', { class: 'em-tf' }, tfLabel(main)), h('span', { class: 'em-source muted' }, getSource(main.source).name), price),
    openLink(open, `Open in ${APP.name}`),
  );
  root.replaceChildren(grid, notes, footer);

  const shown = new Set<string>();
  const note = (text: string) => {
    if (shown.has(text)) return;
    shown.add(text);
    notes.append(h('p', { class: 'em-note', title: text }, text));
  };
  for (const text of decoded.notes) note(text);
  const scripts = decoded.chart.scripts?.length ?? 0;
  if (scripts > 0) note(`${plural(scripts, 'script')} in this link did not run. ${SCRIPTS_NOT_RUN}`);

  const onPrice = (candle: Candle, meta: SymbolMeta | null) => {
    if (meta) name.textContent = displayName(meta);
    const change = candle.open ? ((candle.close - candle.open) / candle.open) * 100 : 0;
    price.className = `em-price ${change >= 0 ? 'up' : 'down'}`;
    price.textContent = `${candle.close.toFixed(meta?.pricePrecision ?? 2)} ${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
  };
  const mounted = await Promise.all(
    layout.panes.map((spec, i) =>
      mountPane(cells[i].body, spec, {
        theme,
        note: (text) => note(many ? `Chart ${i + 1}: ${text}` : text),
        ...(i === 0 ? { onPrice } : {}),
      }),
    ),
  );
  const panes = mounted.filter((p): p is MountedPane => p !== null);
  if (layout.sync.crosshair && panes.length > 1) syncCrosshairs(panes, cells.map((c) => c.el));

  if (!params.theme && media) {
    media.addEventListener('change', () => {
      theme = pickTheme();
      document.documentElement.dataset.theme = theme;
      for (const p of panes) p.setTheme(theme);
    });
  }
}
