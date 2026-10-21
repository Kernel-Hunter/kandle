/**
 * The Share button and its popover, the banner over a shared chart, and the helpers that read
 * and restore the visible range. Links are made in src/share/codec.ts; the temporary view
 * that keeps a shared chart from overwriting the user's own lives in src/share/view.ts.
 */
import type { Chart } from 'klinecharts';
import { APP } from '../config';
import { getSource } from '../data/sources';
import { getTimeframe } from '../data/timeframes';
import { h } from '../ui/dom';
import { createModal } from '../ui/modal';
import {
  DEFAULT_INCLUDE,
  SOFT_LINK_LIMIT,
  ShareError,
  encodeShared,
  pickShared,
  shareUrl,
  type ChartSnapshot,
  type ShareInclude,
  type SharedRange,
  type SharedScript,
} from './codec';
import { keyGate } from './keyGate';
import { DEFAULT_EMBED_OPTIONS, EMBED_SIZES, appPage, embedTitle, embedUrl, iframeSnippet, type EmbedOptions } from './embed';
import type { SharedView } from './view';
import './share.css';

export const SHARE_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5.5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/><path d="M8.2 10.8l7.6-4.1M8.2 13.2l7.6 4.1"/></svg>';

export interface ShareLink {
  url: string;
  include: ShareInclude;
  /** What was left out and why, and a warning for long links. */
  notes: string[];
}

/** The page address a link starts from: this page without its fragment. */
export function currentPage(): string {
  return window.location.href.split('#')[0];
}

/** Builds a link. Throws ShareError for charts that cannot be shared. */
export async function makeShareLink(snapshot: ChartSnapshot, include: ShareInclude, page: string = currentPage()): Promise<ShareLink> {
  const { chart, notes } = pickShared(snapshot, include);
  const url = shareUrl(page, await encodeShared(chart));
  if (url.length > SOFT_LINK_LIMIT) {
    notes.push(`The link is ${url.length.toLocaleString('en-US')} characters; chat apps and some browsers cut links over ${SOFT_LINK_LIMIT.toLocaleString('en-US')}.${chart.scripts?.length ? ' Leave scripts out to make it shorter.' : ''}`);
  }
  return { url, include, notes };
}

export interface EmbedLink extends ShareLink {
  /** The normal share link for the same chart, which the embed's Open in Kandle link opens. */
  openUrl: string;
  /** The iframe to paste into a page. */
  html: string;
}

export const EMBED_SCRIPTS_NOTE = 'Scripts are never included in embeds, so they were left out.';

/**
 * Builds an embed link and its iframe. Scripts are always left out: an embed has nobody to
 * ask before running them. Throws ShareError for charts that cannot be shared.
 */
export async function makeEmbedLink(snapshot: ChartSnapshot, include: ShareInclude, options: EmbedOptions = DEFAULT_EMBED_OPTIONS, page: string = currentPage()): Promise<EmbedLink> {
  const used = { ...include, scripts: false };
  const { chart, notes } = pickShared(snapshot, used);
  if (include.scripts && snapshot.scripts.length > 0) notes.push(EMBED_SCRIPTS_NOTE);
  const keyed = new Set([chart.source, ...(chart.layout?.panes.map((p) => p.source) ?? [])].map(getSource).filter((s) => s.auth).map((s) => s.name));
  if (keyed.size > 0) notes.push(`Charts from ${[...keyed].join(' and ')} need the viewer's own API key, so the embed shows a note with a link to ${APP.name} in their place.`);
  const payload = await encodeShared(chart);
  const url = embedUrl(page, payload, options.theme);
  const html = iframeSnippet({ url, title: embedTitle(chart), width: options.width, height: options.height });
  return { url, include: used, notes, openUrl: shareUrl(appPage(page), payload), html };
}

// ---------------------------------------------------------------- visible range

type RangeChart = Pick<Chart, 'getDataList' | 'getVisibleRange' | 'getBarSpace'>;

/** The bar at the right edge and the bar spacing; the time is null while the latest bar is on screen. */
export function readRange(chart: RangeChart): SharedRange | null {
  const bars = chart.getDataList();
  if (bars.length === 0) return null;
  const barSpace = chart.getBarSpace().bar;
  const { realTo } = chart.getVisibleRange();
  if (realTo > bars.length) return { time: null, barSpace };
  // realTo is one past the bar whose right side touches the edge, rounded up.
  const right = bars[Math.max(0, Math.min(bars.length - 1, realTo - 2))];
  return { time: right.timestamp, barSpace };
}

type ScrollChart = Pick<Chart, 'getDataList' | 'setBarSpace' | 'scrollToRealTime' | 'scrollToDataIndex' | 'scrollToTimestamp'>;

/** Restores a shared range, loading older bars (up to a few pages) when it starts before them. */
export async function applyRange(chart: ScrollChart, range: SharedRange, pageWaitMs = 4000): Promise<void> {
  chart.setBarSpace(range.barSpace);
  if (range.time === null) {
    chart.scrollToRealTime();
    return;
  }
  for (let page = 0; page < 6; page++) {
    const bars = chart.getDataList();
    if (bars.length === 0 || bars[0].timestamp <= range.time) break;
    const before = bars.length;
    // Showing the first bar makes the chart ask for older ones.
    chart.scrollToDataIndex(0);
    const started = Date.now();
    while (chart.getDataList().length === before && Date.now() - started < pageWaitMs) await new Promise((r) => setTimeout(r, 100));
    if (chart.getDataList().length === before) break;
  }
  chart.scrollToTimestamp(range.time);
}

// ---------------------------------------------------------------- clipboard

async function copyText(text: string, fallback: HTMLInputElement | HTMLTextAreaElement): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers, or no permission: select the field and use the old command.
    fallback.focus();
    fallback.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------- Share popover

export interface ShareControlOptions {
  snapshot(): ChartSnapshot;
  toast(message: string, kind?: 'info' | 'error'): void;
  /** Where to open when the anchor is not showing (the button sits in the More menu). */
  fallbackAnchor?(): HTMLElement | null;
}

export interface ShareControl {
  el: HTMLElement;
  button: HTMLButtonElement;
  /** Opens the popover under anchor (the button by default), or closes it when open. */
  toggle(anchor?: HTMLElement): void;
  close(): void;
}

const INCLUDE_LABELS: Record<keyof ShareInclude, string> = {
  chart: 'Chart type, scale and view',
  indicators: 'Indicators',
  drawings: 'Drawings',
  scripts: 'Scripts',
  layout: 'Other charts in the layout',
};

const EMBED_NO_SCRIPTS = 'Scripts are never included in embeds';

/** The Share button: a popover to pick what the link carries, its length, and Copy, or an iframe to embed the chart. */
export function createShareControl(options: ShareControlOptions): ShareControl {
  const include: ShareInclude = { ...DEFAULT_INCLUDE };
  let mode: 'link' | 'embed' = 'link';
  const embed: EmbedOptions = { ...DEFAULT_EMBED_OPTIONS };
  const button = h('button', { class: 'icon-btn', type: 'button', title: 'Share a link to this chart (Alt+K)', 'aria-label': 'Share chart link', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', html: SHARE_ICON });

  const boxes = new Map<keyof ShareInclude, { input: HTMLInputElement; count: HTMLElement; row: HTMLElement }>();
  const rows = (Object.keys(INCLUDE_LABELS) as Array<keyof ShareInclude>).map((key) => {
    const input = h('input', { type: 'checkbox', onchange: () => {
      include[key] = input.checked;
      void refresh();
    } }) as HTMLInputElement;
    const count = h('span', { class: 'muted' });
    const row = h('label', { class: 'sh-option' }, input, h('span', {}, INCLUDE_LABELS[key]), count);
    boxes.set(key, { input, count, row });
    return row;
  });
  const modeBtns = (['link', 'embed'] as const).map((m) =>
    h('button', { class: 'seg-btn', type: 'button', dataset: { mode: m }, 'aria-pressed': 'false', onclick: () => setMode(m) }, m === 'link' ? 'Link' : 'Embed'),
  );
  const field = h('input', { class: 'sh-url', type: 'text', readonly: true, 'aria-label': 'Link to this chart', spellcheck: 'false' }) as HTMLInputElement;
  const length = h('span', { class: 'sh-length muted', 'aria-live': 'polite' });
  const copyBtn = h('button', { class: 'btn btn-primary sh-copy', type: 'button' }, 'Copy link') as HTMLButtonElement;
  const copyUrlBtn = h('button', { class: 'btn', type: 'button', hidden: true }, 'Copy URL') as HTMLButtonElement;
  const notes = h('div', { class: 'sh-notes' });

  const sizeSelect = h(
    'select',
    { class: 'sh-select', 'aria-label': 'Embed size', onchange: () => {
      const size = EMBED_SIZES[Number(sizeSelect.value)] ?? EMBED_SIZES[0];
      embed.width = size.width;
      embed.height = size.height;
      void refresh();
    } },
    ...EMBED_SIZES.map((size, i) => h('option', { value: String(i) }, size.label)),
  ) as HTMLSelectElement;
  const themeSelect = h(
    'select',
    { class: 'sh-select', 'aria-label': 'Embed theme', onchange: () => {
      embed.theme = themeSelect.value === 'light' || themeSelect.value === 'dark' ? themeSelect.value : null;
      void refresh();
    } },
    h('option', { value: '' }, "Viewer's theme"),
    h('option', { value: 'light' }, 'Light'),
    h('option', { value: 'dark' }, 'Dark'),
  ) as HTMLSelectElement;
  const code = h('textarea', { class: 'sh-code', readonly: true, rows: 4, 'aria-label': 'HTML to paste into a page', spellcheck: 'false' }) as HTMLTextAreaElement;
  const embedBox = h('div', { class: 'sh-embed', hidden: true }, h('div', { class: 'sh-embed-row' }, sizeSelect, themeSelect), code);
  const privacy = h('p', { class: 'sh-privacy muted' });

  const popover = h(
    'div',
    { class: 'popover sh-menu', hidden: true, role: 'dialog', 'aria-label': 'Share a link to this chart' },
    h('div', { class: 'sh-head' }, h('div', { class: 'popover-title' }, 'Share this chart'), h('div', { class: 'seg sh-modes', role: 'group', 'aria-label': 'Share as' }, ...modeBtns)),
    h('div', { class: 'sh-options' }, ...rows),
    embedBox,
    field,
    h('div', { class: 'sh-actions' }, length, h('span', { class: 'sh-buttons' }, copyUrlBtn, copyBtn)),
    notes,
    privacy,
  );
  const wrap = h('div', { class: 'popover-wrap sh-wrap' }, button, popover);

  let link: ShareLink | null = null;
  let build = 0;
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;

  const setNotes = (list: string[], error = false) => {
    notes.replaceChildren(...list.map((n) => h('p', { class: error ? 'sh-note sh-error' : 'sh-note' }, n)));
  };

  const copyLabel = () => (mode === 'embed' ? 'Copy code' : 'Copy link');

  function setMode(next: 'link' | 'embed'): void {
    // Copy waits for the new link rather than copying the other mode's.
    if (next !== mode) link = null;
    mode = next;
    for (const b of modeBtns) {
      const on = b.dataset.mode === mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
    embedBox.hidden = mode !== 'embed';
    copyUrlBtn.hidden = mode !== 'embed';
    clearTimeout(copiedTimer);
    copyBtn.textContent = copyLabel();
    field.setAttribute('aria-label', mode === 'embed' ? 'Embed URL' : 'Link to this chart');
    privacy.textContent =
      mode === 'embed'
        ? `The embed shows the chart with a link to open it in ${APP.name}. Scripts are never included, and it saves nothing in the viewer's browser.`
        : 'The chart is stored after the # in the link, which browsers do not send to any server. Exchange, symbol and timeframe are always included.';
    void refresh();
  }

  async function refresh(): Promise<void> {
    const mine = ++build;
    const snap = options.snapshot();
    const counts: Partial<Record<keyof ShareInclude, number>> = {
      indicators: snap.indicators.length,
      drawings: snap.drawings.length,
      scripts: snap.scripts.length,
      layout: snap.layout.count > 1 ? snap.layout.count - 1 : 0,
    };
    for (const [key, box] of boxes) {
      box.input.checked = include[key];
      const n = counts[key];
      box.count.textContent = n === undefined ? '' : `(${n})`;
      // Nothing to share: show the box off and leave the choice as it was.
      const empty = key === 'layout' && n === 0;
      const noScripts = key === 'scripts' && mode === 'embed';
      box.input.disabled = empty || noScripts;
      if (empty || noScripts) box.input.checked = false;
      box.row.title = empty ? 'Only one chart is showing' : noScripts ? EMBED_NO_SCRIPTS : '';
    }
    try {
      const embedded = mode === 'embed' ? await makeEmbedLink(snap, { ...include, scripts: false }, embed) : null;
      const made = embedded ?? (await makeShareLink(snap, include));
      if (mine !== build) return;
      link = made;
      field.value = made.url;
      code.value = embedded?.html ?? '';
      length.textContent = mode === 'embed' ? '' : `${made.url.length.toLocaleString('en-US')} characters`;
      length.classList.toggle('sh-long', mode === 'link' && made.url.length > SOFT_LINK_LIMIT);
      copyBtn.disabled = false;
      copyUrlBtn.disabled = false;
      setNotes(made.notes);
    } catch (error) {
      if (mine !== build) return;
      link = null;
      field.value = '';
      code.value = '';
      length.textContent = '';
      copyBtn.disabled = true;
      copyUrlBtn.disabled = true;
      setNotes([error instanceof ShareError ? error.message : `Could not make a link: ${error instanceof Error ? error.message : String(error)}`], true);
    }
  }

  const copy = async (button: HTMLButtonElement, label: string, text: string, from: HTMLInputElement | HTMLTextAreaElement) => {
    const ok = await copyText(text, from);
    clearTimeout(copiedTimer);
    copyBtn.textContent = copyLabel();
    copyUrlBtn.textContent = 'Copy URL';
    button.textContent = ok ? 'Copied' : 'Copy failed';
    copiedTimer = setTimeout(() => (button.textContent = label), 1600);
    if (!ok) options.toast('Could not copy. Select the text and copy it by hand.', 'error');
  };
  copyBtn.addEventListener('click', () => {
    if (!link) return;
    if (mode === 'embed') void copy(copyBtn, 'Copy code', code.value, code);
    else void copy(copyBtn, 'Copy link', link.url, field);
  });
  copyUrlBtn.addEventListener('click', () => {
    if (link) void copy(copyUrlBtn, 'Copy URL', link.url, field);
  });
  field.addEventListener('focus', () => field.select());
  code.addEventListener('focus', () => code.select());

  const onDown = (e: PointerEvent) => {
    if (!wrap.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  function close(): void {
    if (popover.hidden) return;
    popover.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onDown);
    document.removeEventListener('keydown', onKey, true);
  }
  const open = (anchor: HTMLElement = button) => {
    popover.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    setMode(mode);
    // Fixed to the window and kept inside it, so it also opens from the More menu on a phone.
    const visible = anchor.getClientRects().length > 0 ? anchor : (options.fallbackAnchor?.() ?? anchor);
    const r = visible.getBoundingClientRect();
    const width = popover.offsetWidth;
    popover.style.left = `${Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8))}px`;
    popover.style.top = `${r.bottom + 6}px`;
    popover.style.maxHeight = `${window.innerHeight - r.bottom - 14}px`;
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey, true);
    requestAnimationFrame(() => copyBtn.focus({ preventScroll: true }));
  };

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    if (popover.hidden) open();
    else close();
  });

  return { el: wrap, button, toggle: (anchor) => (popover.hidden ? open(anchor) : close()), close };
}

// ---------------------------------------------------------------- banner over a shared chart

export interface SharedBannerOptions {
  view: SharedView;
  toast(message: string, kind?: 'info' | 'error'): void;
  /** Adds a script to the chart the way the editor does. Resolves to an error message or null. */
  runScript(script: SharedScript): Promise<string | null>;
}

/** Leaves the shared view: drops the #s= part so a reload opens the user's own chart. */
function clearHash(): void {
  history.replaceState(null, '', window.location.pathname + window.location.search);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** "Shared chart" bar with Keep it and Back to my chart, and a prompt before shared scripts run. */
export function createSharedBanner(options: SharedBannerOptions): HTMLElement {
  const { view } = options;
  const chart = view.chart;
  const tf = getTimeframe(chart.timeframe)?.label ?? chart.timeframe;
  const title = h('span', { class: 'sb-title' }, h('strong', {}, 'Shared chart'), h('span', { class: 'muted' }, `${chart.symbol} ${tf} on ${getSource(chart.source).name}`));
  const keepBtn = h('button', { class: 'btn btn-primary', type: 'button', title: 'Save this chart as yours. Your own drawings and scripts stay; chart settings and indicators are replaced.' }, 'Keep it');
  const backBtn = h('button', { class: 'btn', type: 'button', title: 'Close the shared chart and open your own, unchanged' }, 'Back to my chart');
  const main = h('div', { class: 'sb-row' }, h('span', { class: 'sb-icon', html: SHARE_ICON }), title, h('span', { class: 'sb-actions' }, keepBtn, backBtn));
  const banner = h('div', { class: 'shared-banner', role: 'region', 'aria-label': 'Shared chart' }, main);

  const pending = view.pendingScripts();
  if (pending.length > 0) {
    const showBtn = h('button', { class: 'btn', type: 'button' }, 'Show code');
    const runBtn = h('button', { class: 'btn', type: 'button' }, pending.length === 1 ? 'Run script' : 'Run scripts');
    const row = h(
      'div',
      { class: 'sb-row sb-scripts' },
      h('span', { class: 'sb-text' }, `This link has ${plural(pending.length, 'script')}. Scripts run in your browser like code you paste into the editor, so read them first if you do not know the sender.`),
      h('span', { class: 'sb-actions' }, showBtn, runBtn),
    );
    banner.append(row);
    showBtn.addEventListener('click', () => {
      const modal = createModal(`Scripts in this link`, { onClose: () => setTimeout(() => modal.root.remove(), 0) });
      modal.body.append(...pending.map((s, i) => h('div', { class: 'sb-code' }, h('div', { class: 'popover-title' }, `Script ${i + 1}`), h('pre', {}, s.source))));
      modal.open();
    });
    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true;
      const scripts = view.pendingScripts();
      view.markScriptsHandled();
      row.remove();
      let failed = 0;
      for (const s of scripts) {
        const error = await options.runScript(s);
        if (error) {
          failed++;
          options.toast(`A shared script could not run: ${error}`, 'error');
        }
      }
      if (failed < scripts.length) options.toast(`Added ${plural(scripts.length - failed, 'script')} to the chart`);
    });
  }

  keepBtn.addEventListener('click', () => {
    const result = view.keep();
    clearHash();
    // The chart is the user's own now, so keyed sources load as they always do.
    keyGate().releaseAll();
    if (!result.saved) options.toast('Could not save to browser storage', 'error');
    if (result.skippedScripts > 0) options.toast(`${plural(result.skippedScripts, 'script')} from the link did not run, so ${result.skippedScripts === 1 ? 'it was' : 'they were'} not saved`);
    if (result.reload) {
      // Own drawings or scripts that were hidden come back with the saved chart.
      window.location.reload();
      return;
    }
    banner.remove();
    options.toast('Saved as your chart');
  });
  backBtn.addEventListener('click', () => {
    view.discard();
    clearHash();
    window.location.reload();
  });
  return banner;
}
