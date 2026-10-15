import { h, ICONS } from './dom';
import { createModal } from './modal';
import { displayName, searchSymbols } from '../data/search';
import { SOURCES, getSource, hasKey, loadSymbols, sourceMarkets } from '../data/sources';
import { errorMessage } from '../data/http';
import { keyStore } from '../data/keys';
import type { DataSource, SymbolMeta } from '../data/types';
import type { KeyValueStorage } from '../store/layout';
import { marketBadge, openDataSources } from './dataSources';

export interface SymbolSearchOptions {
  storage: KeyValueStorage;
  currentSource: () => string;
  onPick: (sourceId: string, meta: SymbolMeta) => void;
}

/** Waits this long after the last keystroke before asking a provider's search API. */
const REMOTE_DEBOUNCE_MS = 450;

export function createSymbolSearch(options: SymbolSearchOptions) {
  const modal = createModal('Symbol search', { className: 'modal-search' });
  let sourceId = options.currentSource();
  let symbols: SymbolMeta[] = [];
  let results: SymbolMeta[] = [];
  let active = 0;
  let remoteTimer: ReturnType<typeof setTimeout> | null = null;
  let remoteSeq = 0;

  const input = h('input', {
    class: 'search-input',
    type: 'text',
    placeholder: 'Search, e.g. BTC, ETHUSDT, AAPL, EUR/USD',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': 'Symbol',
  }) as HTMLInputElement;
  const tabs = h('div', { class: 'seg', role: 'tablist' });
  const list = h('div', { class: 'result-list', role: 'listbox' });
  const status = h('div', { class: 'result-status' });

  modal.body.append(
    h('div', { class: 'search-row' }, h('span', { class: 'search-icon', html: ICONS.search }), input),
    h(
      'div',
      { class: 'search-sources' },
      h('span', { class: 'muted' }, 'Source'),
      tabs,
      h('button', { class: 'btn small btn-ghost', type: 'button', onclick: () => openDataSources(sourceId) }, 'Data sources'),
    ),
    list,
    status,
  );

  const source = (): DataSource => getSource(sourceId);

  const renderTabs = () => {
    tabs.replaceChildren(
      ...SOURCES.map((s) =>
        h(
          'button',
          {
            class: `seg-btn${s.id === sourceId ? ' active' : ''}`,
            role: 'tab',
            title: `${s.name}: ${sourceMarkets(s).join(', ')}${s.auth ? (hasKey(s) ? ' (key saved)' : ' (needs your free key)') : ''}`,
            'aria-selected': String(s.id === sourceId),
            onclick: () => {
              sourceId = s.id;
              renderTabs();
              void loadList();
              input.focus();
            },
          },
          s.name,
          s.auth && !hasKey(s) ? h('span', { class: 'key-mark', 'aria-label': 'needs a key' }, 'key') : null,
        ),
      ),
    );
  };

  const showResults = (items: SymbolMeta[]) => {
    results = items;
    active = Math.min(active, Math.max(0, results.length - 1));
    const fallbackMarket = sourceMarkets(source()).length === 1 ? sourceMarkets(source())[0] : undefined;
    list.replaceChildren(
      ...results.map((s, i) => {
        const market = s.market ?? fallbackMarket;
        return h(
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
          h(
            'span',
            { class: 'result-main' },
            h('span', { class: 'result-symbol' }, s.symbol),
            h('span', { class: 'result-name muted' }, s.name ?? (s.market === 'stock' || s.market === 'etf' ? displayName(s) : `${s.base} / ${s.quote}`)),
          ),
          h(
            'span',
            { class: 'result-side' },
            s.exchange ? h('span', { class: 'result-exchange muted' }, s.exchange) : null,
            market ? marketBadge(market) : null,
          ),
        );
      }),
    );
  };

  const renderLocal = () => {
    showResults(searchSymbols(symbols, input.value));
    if (symbols.length > 0) status.textContent = results.length === 0 ? 'No matching symbols' : '';
  };

  const needKeyMessage = (s: DataSource) => {
    status.replaceChildren(
      h(
        'span',
        { class: 'search-need-key' },
        `${s.name} needs your own free API key.`,
        h('button', { class: 'btn small btn-primary', type: 'button', onclick: () => openDataSources(s.id) }, 'Add key'),
      ),
    );
  };

  /** Sources with a search API are asked as the user types; the rest filter their full list. */
  const render = () => {
    const s = source();
    if (s.auth && !hasKey(s)) {
      showResults([]);
      needKeyMessage(s);
      return;
    }
    if (!s.search) {
      renderLocal();
      return;
    }
    if (!input.value.trim()) {
      // Sources with a search API list a short set of popular symbols; show all of them.
      showResults(symbols);
      status.textContent = '';
      return;
    }
    if (remoteTimer) clearTimeout(remoteTimer);
    const seq = ++remoteSeq;
    const query = input.value;
    status.textContent = 'Searching...';
    remoteTimer = setTimeout(async () => {
      try {
        const found = await s.search!(query);
        if (seq !== remoteSeq || s.id !== sourceId) return;
        showResults(found);
        status.textContent = found.length === 0 ? 'No matching symbols' : '';
      } catch (error) {
        if (seq !== remoteSeq || s.id !== sourceId) return;
        showResults([]);
        status.textContent = errorMessage(error);
      }
    }, REMOTE_DEBOUNCE_MS);
  };

  const highlight = () => {
    Array.from(list.children).forEach((el, i) => {
      el.classList.toggle('active', i === active);
      el.setAttribute('aria-selected', String(i === active));
      if (i === active) (el as HTMLElement).scrollIntoView({ block: 'nearest' });
    });
  };

  const loadList = async () => {
    const s = source();
    symbols = [];
    remoteSeq += 1;
    list.replaceChildren();
    if (s.auth && !hasKey(s)) {
      render();
      return;
    }
    status.textContent = `Loading ${s.name} symbols...`;
    try {
      const loaded = await loadSymbols(s, options.storage);
      if (sourceId !== s.id) return;
      symbols = loaded;
      status.textContent = '';
      render();
    } catch (error) {
      if (sourceId !== s.id) return;
      status.textContent = `Could not load symbols: ${errorMessage(error)}`;
    }
  };

  const pick = (index: number) => {
    const meta = results[index];
    if (!meta) return;
    modal.close();
    options.onPick(sourceId, meta);
  };

  // A key saved in the Data sources dialog takes effect right away.
  keyStore().onChange(() => {
    if (!modal.isOpen()) return;
    renderTabs();
    void loadList();
  });

  input.addEventListener('input', () => {
    active = 0;
    render();
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
      else render();
      requestAnimationFrame(() => {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      });
    },
    close: () => modal.close(),
    isOpen: () => modal.isOpen(),
  };
}
