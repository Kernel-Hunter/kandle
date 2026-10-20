import { computeChange } from '../data/tickers';
import type { SymbolMeta } from '../data/types';
import { h, ICONS, isTypingTarget } from '../ui/dom';
import { topModal } from '../ui/modal';
import type { WatchlistController } from './controller';
import { direction, formatChange, formatPercent, formatPrice } from './format';
import { itemKey, MAX_ITEMS, type WatchItem } from './store';
import './watchlist.css';

export const LIST_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1" fill="currentColor"/><circle cx="4.5" cy="12" r="1" fill="currentColor"/><circle cx="4.5" cy="18" r="1" fill="currentColor"/></svg>';
const PLUS_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const GRIP_ICON =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>';

/** Below this width the panel floats over the charts instead of taking a column. */
const NARROW = '(max-width: 900px)';

export interface WatchlistPanelOptions {
  controller: WatchlistController;
  /** Source and symbol of the focused chart pane. */
  current: () => WatchItem;
  /** Loads a row into the focused pane. */
  load: (item: WatchItem) => void;
  /** Opens symbol search; the pick is added to the watchlist. */
  search: () => void;
  sourceName: (id: string) => string;
  /** Tick size of a symbol when its source's symbol list is cached. */
  precision: (item: WatchItem) => number | undefined;
  toast: (message: string, kind?: 'info' | 'error') => void;
}

interface RowCells {
  row: HTMLElement;
  last: HTMLElement;
  pct: HTMLElement;
  abs: HTMLElement;
  price: number | null;
}

const NOTES: Record<string, string> = {
  '24h': 'Crypto: last trade and change over the last 24 hours, streamed live.',
  prev_close: 'Stocks and forex: change since the previous daily close, refreshed every few minutes within the free plan, or live from a chart showing the symbol.',
  prev_bar: 'CSV: last close of the imported data against the bar before.',
};

/** The watchlist column on the right of the charts, and its topbar button. */
export function createWatchlistPanel(options: WatchlistPanelOptions) {
  const { controller } = options;
  const list = h('ol', { class: 'wl-list', 'aria-label': 'Watchlist symbols' });
  const empty = h('p', { class: 'wl-empty muted' }, 'No symbols yet. Use + to add the chart\'s symbol or the search button to find one.');
  const notes = h('div', { class: 'wl-notes muted' });
  const addCurrent = h('button', {
    class: 'icon-btn tiny',
    title: 'Add the focused chart\'s symbol',
    'aria-label': 'Add the focused chart\'s symbol',
    html: PLUS_ICON,
    onclick: () => {
      const item = options.current();
      if (controller.add(item)) options.toast(`Added ${item.symbol} to the watchlist`);
      else if (controller.items().length >= MAX_ITEMS) options.toast(`The watchlist holds up to ${MAX_ITEMS} symbols`, 'error');
      else options.toast(`${item.symbol} is already in the watchlist`);
    },
  });
  const root = h(
    'aside',
    { class: 'wl-panel', 'aria-label': 'Watchlist', hidden: !controller.open },
    h(
      'div',
      { class: 'wl-head' },
      h('span', { class: 'wl-title' }, 'Watchlist'),
      addCurrent,
      h('button', { class: 'icon-btn tiny', title: 'Search for a symbol to add', 'aria-label': 'Search for a symbol to add', html: ICONS.search, onclick: () => options.search() }),
      h('button', { class: 'icon-btn tiny', title: 'Hide watchlist (Alt+W)', 'aria-label': 'Hide watchlist', html: ICONS.close, onclick: () => controller.setOpen(false) }),
    ),
    h('div', { class: 'wl-cols muted' }, h('span', {}, 'Symbol'), h('span', {}, 'Last'), h('span', { title: 'See the notes below the list' }, 'Change')),
    list,
    empty,
    notes,
  );
  const button = h(
    'button',
    { class: 'tb-btn', title: 'Watchlist (Alt+W)', 'aria-pressed': String(controller.open), onclick: () => controller.setOpen(!controller.open) },
    h('span', { html: LIST_ICON }),
    h('span', { class: 'tb-label' }, 'Watchlist'),
  );

  // On phones the topbar is wider than the screen, so the drawing toolbar gets a toggle too.
  const drawbarButton = h('button', {
    class: 'tool-btn wl-drawbar-btn',
    title: 'Watchlist (Alt+W)',
    'aria-label': 'Watchlist',
    html: LIST_ICON,
    onclick: () => controller.setOpen(!controller.open),
  });

  let cells = new Map<string, RowCells>();
  let listKey = '';

  const loadRow = (item: WatchItem) => {
    options.load(item);
    // The panel covers the charts on narrow screens; get it out of the way.
    if (window.matchMedia?.(NARROW).matches) controller.setOpen(false);
  };

  const buildRow = (item: WatchItem, index: number): RowCells => {
    const last = h('span', { class: 'wl-last' });
    const pct = h('span', { class: 'wl-pct' });
    const abs = h('span', { class: 'wl-abs' });
    const grip = h('span', { class: 'wl-grip', title: 'Drag to reorder', html: GRIP_ICON });
    const row = h(
      'li',
      {
        class: 'wl-row',
        dataset: { key: itemKey(item) },
        // The whole row loads the symbol; the name button is the keyboard and screen reader target.
        onclick: (e: MouseEvent) => {
          if ((e.target as HTMLElement).closest('.wl-x, .wl-grip')) return;
          loadRow(item);
        },
        onkeydown: (e: KeyboardEvent) => {
          if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
            e.preventDefault();
            const to = index + (e.key === 'ArrowUp' ? -1 : 1);
            if (to < 0 || to >= controller.items().length) return;
            controller.move(index, to);
            refresh();
            list.querySelector<HTMLElement>(`[data-key="${CSS.escape(itemKey(item))}"] .wl-name`)?.focus();
          } else if ((e.key === 'Delete' || e.key === 'Backspace') && !(e.target as HTMLElement).closest('.wl-x')) {
            e.preventDefault();
            e.stopPropagation();
            controller.remove(item);
          }
        },
      },
      grip,
      h(
        'button',
        {
          class: 'wl-name',
          type: 'button',
          title: `Open ${item.symbol}. Alt+Up and Alt+Down move it, Delete removes it.`,
        },
        h('span', { class: 'wl-sym' }, item.symbol),
        h('span', { class: 'wl-src muted' }, options.sourceName(item.source)),
      ),
      last,
      h('span', { class: 'wl-chg' }, pct, abs),
      h('button', {
        class: 'wl-x',
        title: `Remove ${item.symbol}`,
        'aria-label': `Remove ${item.symbol}`,
        html: ICONS.close,
        onclick: () => controller.remove(item),
      }),
    );
    grip.addEventListener('pointerdown', (e) => startDrag(e, row, index));
    return { row, last, pct, abs, price: null };
  };

  /**
   * Pointer drag on the grip: the row moves through the list as the pointer passes other rows.
   * Moving the row in the DOM drops pointer capture, so the listeners sit on the document.
   */
  const startDrag = (e: PointerEvent, row: HTMLElement, from: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    row.classList.add('wl-dragging');
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      const rows = [...list.children] as HTMLElement[];
      const target = rows.find((r) => {
        if (r === row) return false;
        const box = r.getBoundingClientRect();
        return ev.clientY >= box.top && ev.clientY <= box.bottom;
      });
      if (!target) return;
      const box = target.getBoundingClientRect();
      list.insertBefore(row, ev.clientY < box.top + box.height / 2 ? target : target.nextSibling);
    };
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== e.pointerId) return;
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', end);
      document.removeEventListener('pointercancel', end);
      row.classList.remove('wl-dragging');
      const to = [...list.children].indexOf(row);
      if (to !== from && to >= 0) controller.move(from, to);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', end);
    document.addEventListener('pointercancel', end);
  };

  const renderList = () => {
    const items = controller.items();
    listKey = items.map(itemKey).join('|');
    cells = new Map(items.map((item, i) => [itemKey(item), buildRow(item, i)]));
    list.replaceChildren(...[...cells.values()].map((c) => c.row));
    empty.hidden = items.length > 0;
    const bases = new Set(items.map((i) => controller.basisFor(i.source)));
    notes.replaceChildren(...['24h', 'prev_close', 'prev_bar'].filter((b) => bases.has(b as never)).map((b) => h('p', {}, NOTES[b])));
  };

  const renderQuotes = () => {
    const current = options.current();
    for (const item of controller.items()) {
      const c = cells.get(itemKey(item));
      if (!c) continue;
      const q = controller.quote(item);
      const precision = options.precision(item);
      const change = q.price !== null && q.reference !== null ? computeChange(q.price, q.reference) : null;
      c.row.classList.toggle('wl-active', item.source === current.source && item.symbol === current.symbol);
      if (q.status === 'no-key' || (q.status === 'error' && q.price === null)) {
        c.last.textContent = q.status === 'no-key' ? 'Add key' : 'Error';
        c.last.className = 'wl-last muted';
        c.last.title = q.error ?? '';
        c.pct.textContent = '';
        c.abs.textContent = '';
        continue;
      }
      const text = q.price === null ? '...' : formatPrice(q.price, precision);
      const tick = c.price !== null && q.price !== null && q.price !== c.price ? (q.price > c.price ? ' tick-up' : ' tick-down') : '';
      c.last.textContent = text;
      c.last.className = `wl-last${tick}${q.status === 'paused' ? ' muted' : ''}`;
      c.last.title = q.time ? `${q.status === 'chart' ? 'From the chart, ' : ''}updated ${new Date(q.time).toLocaleTimeString()}` : '';
      if (tick) setTimeout(() => c.last.classList.remove('tick-up', 'tick-down'), 600);
      c.price = q.price;
      const dir = direction(change?.change ?? null);
      c.pct.textContent = formatPercent(change?.percent ?? null);
      c.pct.className = `wl-pct ${dir}`;
      c.abs.textContent = formatChange(change?.change ?? null, precision);
      c.abs.className = `wl-abs ${dir}`;
      c.pct.title = q.basis === '24h' ? 'Change over the last 24 hours' : q.basis === 'prev_close' ? 'Change since the previous daily close' : 'Change from the bar before the last one';
    }
  };

  // Tickers can arrive many times a second; paint at most a few times a second.
  let paintTimer: ReturnType<typeof setTimeout> | null = null;
  const schedulePaint = () => {
    if (paintTimer) return;
    paintTimer = setTimeout(() => {
      paintTimer = null;
      refresh();
    }, 200);
  };

  const refresh = () => {
    root.hidden = !controller.open;
    button.classList.toggle('active', controller.open);
    button.setAttribute('aria-pressed', String(controller.open));
    drawbarButton.classList.toggle('active', controller.open);
    if (controller.items().map(itemKey).join('|') !== listKey) renderList();
    renderQuotes();
  };

  // Showing, hiding and list changes paint at once; quote updates are batched.
  controller.onChange(() => {
    if (root.hidden === controller.open || controller.items().map(itemKey).join('|') !== listKey) refresh();
    else schedulePaint();
  });
  refresh();

  document.addEventListener('keydown', (e) => {
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyW' && !topModal() && !isTypingTarget(e.target)) {
      e.preventDefault();
      controller.setOpen(!controller.open);
    }
  });

  return {
    root,
    button,
    drawbarButton,
    /** Repaint now, e.g. after the focused chart changed symbol. */
    refresh,
    /** Adds a symbol picked in symbol search. */
    addPicked(sourceId: string, meta: SymbolMeta) {
      if (controller.add({ source: sourceId, symbol: meta.symbol })) {
        options.toast(`Added ${meta.symbol} to the watchlist`);
        if (!controller.open) controller.setOpen(true);
      } else {
        options.toast(controller.items().length >= MAX_ITEMS ? `The watchlist holds up to ${MAX_ITEMS} symbols` : `${meta.symbol} is already in the watchlist`, 'error');
      }
    },
  };
}
