import { h, ICONS } from './dom';
import { createModal } from './modal';
import { searchSymbols } from '../data/search';
import { SOURCES, loadSymbols } from '../data/sources';
import type { SymbolMeta } from '../data/types';
import type { KeyValueStorage } from '../store/layout';

export interface SymbolSearchOptions {
  storage: KeyValueStorage;
  currentSource: () => string;
  onPick: (sourceId: string, meta: SymbolMeta) => void;
}

export function createSymbolSearch(options: SymbolSearchOptions) {
  const modal = createModal('Symbol search', { className: 'modal-search' });
  let sourceId = options.currentSource();
  let symbols: SymbolMeta[] = [];
  let results: SymbolMeta[] = [];
  let active = 0;

  const input = h('input', {
    class: 'search-input',
    type: 'text',
    placeholder: 'Search, e.g. BTC, ETHUSDT, SOL-USD',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': 'Symbol',
  }) as HTMLInputElement;
  const tabs = h('div', { class: 'seg', role: 'tablist' });
  const list = h('div', { class: 'result-list', role: 'listbox' });
  const status = h('div', { class: 'result-status' });

  modal.body.append(
    h('div', { class: 'search-row' }, h('span', { class: 'search-icon', html: ICONS.search }), input),
    h('div', { class: 'search-sources' }, h('span', { class: 'muted' }, 'Exchange'), tabs),
    list,
    status,
  );

  const renderTabs = () => {
    tabs.replaceChildren(
      ...SOURCES.map((s) =>
        h(
          'button',
          {
            class: `seg-btn${s.id === sourceId ? ' active' : ''}`,
            role: 'tab',
            'aria-selected': String(s.id === sourceId),
            onclick: () => {
              sourceId = s.id;
              renderTabs();
              void loadList();
              input.focus();
            },
          },
          s.name,
        ),
      ),
    );
  };

  const renderList = () => {
    results = searchSymbols(symbols, input.value);
    active = Math.min(active, Math.max(0, results.length - 1));
    list.replaceChildren(
      ...results.map((s, i) =>
        h(
          'div',
          {
            class: `result${i === active ? ' active' : ''}`,
            role: 'option',
            'aria-selected': String(i === active),
            onmousedown: (e: MouseEvent) => {
              e.preventDefault();
              pick(i);
            },
            onmousemove: () => {
              if (active !== i) {
                active = i;
                highlight();
              }
            },
          },
          h('span', { class: 'result-symbol' }, s.symbol),
          h('span', { class: 'result-pair muted' }, `${s.base} / ${s.quote}`),
        ),
      ),
    );
    if (symbols.length > 0) status.textContent = results.length === 0 ? 'No matching symbols' : '';
  };

  const highlight = () => {
    Array.from(list.children).forEach((el, i) => {
      el.classList.toggle('active', i === active);
      el.setAttribute('aria-selected', String(i === active));
      if (i === active) (el as HTMLElement).scrollIntoView({ block: 'nearest' });
    });
  };

  const loadList = async () => {
    const source = SOURCES.find((s) => s.id === sourceId)!;
    symbols = [];
    list.replaceChildren();
    status.textContent = `Loading ${source.name} symbols...`;
    try {
      const loaded = await loadSymbols(source, options.storage);
      if (sourceId !== source.id) return;
      symbols = loaded;
      status.textContent = '';
      renderList();
    } catch (error) {
      if (sourceId !== source.id) return;
      status.textContent = `Could not load symbols: ${error instanceof Error ? error.message : String(error)}`;
    }
  };

  const pick = (index: number) => {
    const meta = results[index];
    if (!meta) return;
    modal.close();
    options.onPick(sourceId, meta);
  };

  input.addEventListener('input', () => {
    active = 0;
    renderList();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      active = Math.min(results.length - 1, active + 1);
      highlight();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      active = Math.max(0, active - 1);
      highlight();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(active);
    }
  });

  return {
    open(initialQuery = '') {
      const current = options.currentSource();
      const sourceChanged = current !== sourceId || symbols.length === 0;
      sourceId = current;
      input.value = initialQuery;
      active = 0;
      renderTabs();
      modal.open();
      if (sourceChanged) void loadList();
      else renderList();
      requestAnimationFrame(() => {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      });
    },
    close: () => modal.close(),
    isOpen: () => modal.isOpen(),
  };
}
