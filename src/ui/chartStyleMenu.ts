import { CHART_TYPES, CHART_TYPE_LABELS, PRICE_SCALES, PRICE_SCALE_LABELS, type ChartStyle, type ChartType } from '../chart/chartStyle';
import { h } from './dom';
import './chartStyleMenu.css';

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const CHART_TYPE_ICONS: Record<ChartType, string> = {
  candles: svg('<path d="M8 3v18M16 5v14"/><rect x="6" y="7" width="4" height="10" fill="currentColor"/><rect x="14" y="9" width="4" height="6" fill="currentColor"/>'),
  hollow_candles: svg('<path d="M8 3v4M8 17v4M16 5v14"/><rect x="6" y="7" width="4" height="10"/><rect x="14" y="9" width="4" height="6" fill="currentColor"/>'),
  bars: svg('<path d="M8 4v16M5 8h3M8 16h3M16 6v12M13 14h3M16 9h3"/>'),
  line: svg('<path d="M3 17l5-6 4 3 4-7 5 4"/>'),
  area: svg('<path d="M3 17l5-6 4 3 4-7 5 4v9H3z" fill="currentColor" fill-opacity=".25" stroke="none"/><path d="M3 17l5-6 4 3 4-7 5 4"/>'),
  heikin_ashi: svg('<path d="M5 12v9M12 8v10M19 3v11"/><rect x="3.5" y="14" width="3" height="5" fill="currentColor"/><rect x="10.5" y="10" width="3" height="6" fill="currentColor"/><rect x="17.5" y="5" width="3" height="6" fill="currentColor"/>'),
};

const SCALE_SHORT = { normal: 'Normal', log: 'Log', percent: '%' } as const;

export interface ChartStyleControlOptions {
  get(): ChartStyle;
  set(change: Partial<ChartStyle>): void;
  /** Smaller button for the header of a chart in a multi-chart layout. */
  compact?: boolean;
  /** Names the chart in labels, e.g. "chart 2". */
  name?: string;
  /** Extra text for the button tooltip, such as a shortcut. */
  hint?: string;
}

export interface ChartStyleControl {
  el: HTMLElement;
  /** Updates the icon and the checked items after the style changed elsewhere. */
  refresh(): void;
}

/**
 * An icon button showing the chart type, with a small menu for the type and the price scale.
 * The menu is positioned against the window, so it also works inside the clipped header of
 * a chart in a multi-chart layout.
 */
export function createChartStyleControl(options: ChartStyleControlOptions): ChartStyleControl {
  const suffix = options.name ? ` for ${options.name}` : '';
  const button = h('button', {
    // Not tb-btn: app.ts finds the Indicators button as the first .tb-btn in the top bar.
    class: `cs-btn${options.compact ? ' compact' : ''}`,
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
  });
  const types = CHART_TYPES.map((type) =>
    h(
      'button',
      { class: 'cs-item', role: 'menuitemradio', dataset: { type }, onclick: () => choose({ type }) },
      h('span', { class: 'cs-icon', html: CHART_TYPE_ICONS[type] }),
      CHART_TYPE_LABELS[type],
    ),
  );
  const scales = PRICE_SCALES.map((scale) =>
    h('button', { class: 'seg-btn', role: 'menuitemradio', dataset: { scale }, title: `${PRICE_SCALE_LABELS[scale]} price scale`, 'aria-label': `${PRICE_SCALE_LABELS[scale]} price scale`, onclick: () => choose({ scale }) }, SCALE_SHORT[scale]),
  );
  const menu = h(
    'div',
    { class: 'popover cs-menu', hidden: true, role: 'menu', 'aria-label': `Chart type and scale${suffix}` },
    h('div', { class: 'popover-title' }, 'Chart type'),
    h('div', { class: 'cs-types' }, ...types),
    h('div', { class: 'popover-title' }, 'Price scale'),
    h('div', { class: 'seg cs-scales' }, ...scales),
  );
  const wrap = h('div', { class: 'popover-wrap cs-wrap' }, button, menu);

  const refresh = () => {
    const { type, scale } = options.get();
    button.innerHTML = CHART_TYPE_ICONS[type];
    const label = `Chart type: ${CHART_TYPE_LABELS[type]}, ${PRICE_SCALE_LABELS[scale].toLowerCase()} scale${suffix}`;
    button.title = options.hint ? `${label} (${options.hint})` : label;
    button.setAttribute('aria-label', label);
    for (const b of types) {
      const on = b.dataset.type === type;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    }
    for (const b of scales) {
      const on = b.dataset.scale === scale;
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', String(on));
    }
  };

  const onDown = (e: MouseEvent) => {
    if (!wrap.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  const close = () => {
    menu.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onDown);
    document.removeEventListener('keydown', onKey, true);
  };
  const open = () => {
    refresh();
    menu.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    // Keep the menu inside the window on narrow screens.
    const r = button.getBoundingClientRect();
    const width = menu.offsetWidth;
    menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - width - 8))}px`;
    menu.style.top = `${r.bottom + 6}px`;
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
  };
  const choose = (change: Partial<ChartStyle>) => {
    options.set(change);
    refresh();
    close();
  };

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) open();
    else close();
  });
  refresh();
  return { el: wrap, refresh };
}
