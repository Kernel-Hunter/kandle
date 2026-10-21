import { h } from './dom';

/**
 * What the top bar gives up when it runs out of room, in order. Every step but 'timeframes'
 * moves a button into the More menu; 'timeframes' swaps the row of timeframe buttons for a
 * dropdown. Hiding the button labels comes before all of them.
 */
export const TOPBAR_STEPS = ['shortcuts', 'image', 'share', 'theme', 'data', 'agent', 'layout', 'replay', 'scripts', 'alerts', 'watchlist', 'timeframes', 'chartType', 'indicators'] as const;
export type TopbarStep = (typeof TOPBAR_STEPS)[number];
export type TopbarItemId = Exclude<TopbarStep, 'timeframes'>;

/** Widths in CSS pixels, measured with every item in the bar. */
export interface TopbarSizes {
  /** Room in the bar, padding included. */
  available: number;
  /** Content width with the button labels showing. */
  withLabels: number;
  /** Content width with icons only. */
  iconsOnly: number;
  /** What each item takes in the icons-only bar, its gap included. Items missing from the bar are left out. */
  items: Partial<Record<TopbarItemId, number>>;
  /** What the timeframe dropdown saves over the row of buttons. */
  timeframes: number;
  /** What the More button adds, its gap included. */
  more: number;
}

export interface TopbarPlan {
  labels: boolean;
  /** Items shown in the More menu instead of the bar, in TOPBAR_STEPS order. */
  overflow: TopbarItemId[];
  compactTimeframes: boolean;
}

/** Decides what the top bar shows, given its measured sizes. */
export function planTopbar(sizes: TopbarSizes): TopbarPlan {
  if (sizes.withLabels <= sizes.available) return { labels: true, overflow: [], compactTimeframes: false };
  let width = sizes.iconsOnly;
  const overflow: TopbarItemId[] = [];
  let compactTimeframes = false;
  for (const step of TOPBAR_STEPS) {
    if (width <= sizes.available) break;
    if (step === 'timeframes') {
      compactTimeframes = true;
      width -= sizes.timeframes;
      continue;
    }
    const item = sizes.items[step];
    if (item === undefined) continue;
    if (overflow.length === 0) width += sizes.more;
    overflow.push(step);
    width -= item;
  }
  // The dropdown can free more room than was missing: bring back the most needed items while they fit.
  while (overflow.length > 0) {
    const last = overflow[overflow.length - 1];
    const back = sizes.items[last]! - (overflow.length === 1 ? sizes.more : 0);
    if (width + back > sizes.available) break;
    width += back;
    overflow.pop();
  }
  return { labels: false, overflow, compactTimeframes };
}

export interface TopbarItem {
  id: TopbarItemId;
  /** The button that moves into the More menu. */
  el: HTMLElement;
  /** Runs the item from the menu, where anchor is the More button. Clicks the hidden button by default. */
  run?: (anchor: HTMLElement) => void;
}

export interface TopbarFitOptions {
  bar: HTMLElement;
  /** The row of timeframe buttons and the dropdown that replaces it. */
  timeframes: HTMLElement;
  timeframeSelect: HTMLElement;
  /** Elements whose size can change after start, such as the price. */
  watch: HTMLElement[];
}

export interface TopbarFit {
  /** The More button, for the end of the bar. Hidden while nothing is in the menu. */
  more: HTMLButtonElement;
  add(...items: TopbarItem[]): void;
  /** Measures again on the next frame. */
  schedule(): void;
  plan(): TopbarPlan;
}

const MORE_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';

/** Width of an element plus the gap its flex container puts after it. */
function outerWidth(el: Element): number {
  let parent = el.parentElement;
  while (parent && getComputedStyle(parent).display === 'contents') parent = parent.parentElement;
  const gap = parent ? parseFloat(getComputedStyle(parent).columnGap) || 0 : 0;
  return el.getBoundingClientRect().width + gap;
}

function labelOf(el: HTMLElement): string {
  return el.querySelector('.tb-label')?.textContent || el.getAttribute('aria-label') || el.title || '';
}

/**
 * Keeps the top bar on one line: hides the button labels, then moves buttons into a More
 * menu and turns the timeframes into a dropdown, as the window gets narrower.
 */
export function createTopbarFit(options: TopbarFitOptions): TopbarFit {
  const { bar } = options;
  const items: TopbarItem[] = [];
  let current: TopbarPlan = { labels: true, overflow: [], compactTimeframes: false };
  let frame = 0;

  const more = h('button', {
    class: 'icon-btn tb-more',
    type: 'button',
    title: 'More tools',
    'aria-label': 'More tools',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    hidden: true,
    html: MORE_ICON,
  });
  const menu = h('div', { class: 'popover tb-menu', role: 'menu', 'aria-label': 'More tools', hidden: true });
  document.body.append(menu);

  /** Content width of the bar, padding included, read while measuring. */
  const contentWidth = () => {
    const box = bar.getBoundingClientRect();
    let right = box.left;
    for (const child of bar.children) {
      const r = child.getBoundingClientRect();
      if (r.width > 0) right = Math.max(right, r.right);
    }
    return right - box.left + (parseFloat(getComputedStyle(bar).paddingRight) || 0);
  };

  const measure = (): TopbarSizes => {
    bar.classList.add('tb-measure');
    bar.classList.remove('tb-icons', 'tb-tf-compact');
    for (const item of items) item.el.classList.remove('tb-in-menu');
    const withLabels = contentWidth();
    bar.classList.add('tb-icons');
    const iconsOnly = contentWidth();
    const widths: TopbarSizes['items'] = {};
    for (const item of items) widths[item.id] = outerWidth(item.el);
    const row = outerWidth(options.timeframes);
    bar.classList.add('tb-tf-compact');
    const dropdown = outerWidth(options.timeframeSelect);
    bar.classList.remove('tb-tf-compact', 'tb-measure');
    const gap = parseFloat(getComputedStyle(bar).columnGap) || 0;
    // The More button is hidden while measuring; its width comes from the stylesheet.
    const moreWidth = (parseFloat(getComputedStyle(more).width) || 32) + gap;
    return { available: bar.clientWidth, withLabels, iconsOnly, items: widths, timeframes: row - dropdown, more: moreWidth };
  };

  const apply = (plan: TopbarPlan) => {
    current = plan;
    bar.classList.toggle('tb-icons', !plan.labels);
    bar.classList.toggle('tb-tf-compact', plan.compactTimeframes);
    for (const item of items) item.el.classList.toggle('tb-in-menu', plan.overflow.includes(item.id));
    more.hidden = plan.overflow.length === 0;
    if (more.hidden) close();
  };

  const fit = () => {
    frame = 0;
    if (!bar.isConnected) return;
    apply(planTopbar(measure()));
  };

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(fit);
  };

  // ---------------------------------------------------------------- More menu

  const rows = () => [...menu.querySelectorAll<HTMLButtonElement>('.tb-menu-item')];

  const onDown = (e: PointerEvent) => {
    if (!menu.contains(e.target as Node) && !more.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      more.focus({ preventScroll: true });
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const list = rows();
    if (list.length === 0) return;
    e.preventDefault();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'ArrowDown' ? (at + 1) % list.length : (at - 1 + list.length) % list.length;
    list[next].focus();
  };

  function close(): void {
    if (menu.hidden) return;
    menu.hidden = true;
    more.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close);
  }

  const open = (focusFirst: boolean) => {
    // Same order as in the bar.
    const shown = items
      .filter((item) => current.overflow.includes(item.id))
      .sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    menu.replaceChildren(
      ...shown.map((item) => {
        const row = h('button', { class: 'tb-menu-item', type: 'button', role: 'menuitem' });
        // The button's own icon, label, badge or status dot.
        for (const child of item.el.childNodes) row.append(child.cloneNode(true));
        if (!row.querySelector('.tb-label')) row.append(h('span', { class: 'tb-label' }, labelOf(item.el)));
        row.classList.toggle('active', item.el.classList.contains('active') || item.el.getAttribute('aria-pressed') === 'true');
        row.addEventListener('click', () => {
          close();
          more.focus({ preventScroll: true });
          if (item.run) item.run(more);
          else item.el.click();
        });
        return row;
      }),
    );
    menu.hidden = false;
    more.setAttribute('aria-expanded', 'true');
    const r = more.getBoundingClientRect();
    menu.style.top = `${r.bottom + 6}px`;
    menu.style.maxHeight = `${window.innerHeight - r.bottom - 14}px`;
    menu.style.left = `${Math.max(8, Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))}px`;
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
    if (focusFirst) rows()[0]?.focus();
  };

  more.addEventListener('click', (e) => {
    if (menu.hidden) open(e.detail === 0);
    else close();
  });

  const observer = new ResizeObserver(schedule);
  observer.observe(bar);
  for (const el of options.watch) observer.observe(el);

  return {
    more,
    add(...added) {
      items.push(...added);
      schedule();
    },
    schedule,
    plan: () => current,
  };
}
