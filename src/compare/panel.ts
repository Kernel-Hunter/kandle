/**
 * The Compare button and its dialog: the compared symbols with their color and change since
 * the left edge of the chart, a remove button for each, and Add symbol, which opens symbol search.
 * With nothing compared yet the button goes straight to symbol search.
 */
import { getSource } from '../data/sources';
import { h } from '../ui/dom';
import { createModal } from '../ui/modal';
import type { CompareReport } from './controller';
import { MAX_COMPARE, type CompareSymbol } from './series';
import './compare.css';

export const COMPARE_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 18l5-6 4 3 4-6 5 4"/><path d="M3 12l5-3 4 2 4-5 5 1" stroke-dasharray="2 2.5"/></svg>';

export interface ComparePanelDeps {
  report(): CompareReport[];
  remove(item: CompareSymbol): void;
  /** Opens symbol search; a pick calls the app's add. */
  search(): void;
}

export interface ComparePanel {
  button: HTMLButtonElement;
  /** Opens the dialog, or symbol search when nothing is compared yet. */
  open(): void;
  close(): void;
  /** Redraws the dialog and the button state after the list changed. */
  refresh(): void;
}

const pct = (v: number | null) => (v === null ? '' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);

export function createComparePanel(deps: ComparePanelDeps): ComparePanel {
  const modal = createModal('Compare symbols', { className: 'modal-small modal-compare' });
  const list = h('div', { class: 'cmp-list' });
  // Close first: the search dialog was created earlier, so it would open underneath this one.
  const addBtn = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => (modal.close(), deps.search()) }, 'Add symbol');
  const note = h('p', { class: 'cmp-note muted' });
  modal.body.append(list, h('div', { class: 'cmp-actions' }, addBtn), note);

  const button = h(
    'button',
    { class: 'tb-btn', title: 'Compare other symbols on this chart', onclick: () => panel.open() },
    h('span', { class: 'tb-icon', html: COMPARE_ICON }),
    h('span', { class: 'tb-label' }, 'Compare'),
  );

  const render = () => {
    const rows = deps.report();
    button.classList.toggle('active', rows.length > 0);
    list.replaceChildren(
      ...rows.map((r) =>
        h(
          'div',
          { class: 'cmp-row' },
          h('span', { class: 'cmp-swatch', style: `background:${r.color}` }),
          h('span', { class: 'cmp-name' }, h('span', { class: 'cmp-symbol' }, r.symbol), h('span', { class: 'muted' }, getSource(r.source).name)),
          h(
            'span',
            { class: `cmp-change ${r.error ? 'muted' : (r.changePercent ?? 0) >= 0 ? 'up' : 'down'}`, title: 'Change since the left edge of the chart' },
            r.error ? 'could not load' : r.loading ? 'loading' : pct(r.changePercent),
          ),
          h('button', {
            class: 'icon-btn cmp-remove',
            type: 'button',
            title: `Remove ${r.symbol}`,
            'aria-label': `Remove ${r.symbol}`,
            html: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
            onclick: () => {
              deps.remove({ source: r.source, symbol: r.symbol });
              render();
            },
          }),
        ),
      ),
    );
    const full = rows.length >= MAX_COMPARE;
    addBtn.disabled = full;
    note.textContent = full
      ? `You can compare up to ${MAX_COMPARE} symbols. Remove one to add another.`
      : 'Each line starts at the price of this chart at the left edge. On the percent scale every line shows its own change from there.';
  };

  const panel: ComparePanel = {
    button,
    open() {
      if (deps.report().length === 0) {
        deps.search();
        return;
      }
      render();
      modal.open();
    },
    close: () => modal.close(),
    refresh() {
      if (modal.isOpen()) render();
      else button.classList.toggle('active', deps.report().length > 0);
    },
  };
  return panel;
}
