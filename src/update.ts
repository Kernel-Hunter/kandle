/**
 * Tells a tab that stays open when a newer build of the app is deployed. The build writes its id
 * into index.html (<meta name="kandle-build">) and into version.json next to it (vite.config.ts);
 * when they differ, this tab is out of date. A reload is enough to update, since nothing caches
 * the app, so the banner only offers one. Embeds never check (src/main.ts).
 */
import { APP } from './config';
import { h, ICONS } from './ui/dom';

const CHECK_EVERY_MS = 30 * 60_000;
/** Switching tabs back and forth checks at most this often. */
const MIN_GAP_MS = 60_000;

/** The build id of the running page, or null in development. */
export function currentBuild(doc: Document = document): string | null {
  return doc.querySelector<HTMLMetaElement>('meta[name="kandle-build"]')?.content || null;
}

/** The build id of the latest deploy, or null when it cannot be read (offline, for example). */
export async function latestBuild(base: string = document.baseURI, fetcher: typeof fetch = fetch): Promise<string | null> {
  try {
    // The query and no-store skip every cache on the way (GitHub Pages sends max-age=600).
    const url = new URL('version.json', base);
    url.searchParams.set('t', String(Date.now()));
    const res = await fetcher(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = (await res.json()) as { build?: unknown };
    return typeof data.build === 'string' && data.build ? data.build : null;
  } catch {
    return null;
  }
}

/**
 * Calls `onUpdate` once, when a build newer than this page is found. Checks when the tab becomes
 * visible again, every 30 minutes and when the connection comes back.
 */
export function watchForUpdates(onUpdate: () => void): void {
  const mine = currentBuild();
  if (!mine) return;
  let found = false;
  let running = false;
  let last = 0;
  const check = async (force = false) => {
    if (found || running || !navigator.onLine) return;
    if (!force && Date.now() - last < MIN_GAP_MS) return;
    running = true;
    last = Date.now();
    const latest = await latestBuild();
    running = false;
    if (found || !latest || latest === mine) return;
    found = true;
    clearInterval(timer);
    onUpdate();
  };
  const timer = setInterval(() => void check(true), CHECK_EVERY_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void check();
  });
  window.addEventListener('online', () => void check());
}

export interface UpdateBannerOptions {
  /** Saves what is waiting to be saved and returns what a reload would still lose, as sentences. */
  beforeReload(): string[];
  reload?: () => void;
}

/** "Kandle was updated" with Reload. If a reload would lose something, it says what first. */
export function createUpdateBanner(options: UpdateBannerOptions): HTMLElement {
  const reload = options.reload ?? (() => window.location.reload());
  const text = h('span', { class: 'ub-text' }, `${APP.name} was updated.`);
  const reloadBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Reload');
  const closeBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Close', 'aria-label': 'Close', html: ICONS.close });
  const actions = h('span', { class: 'ub-actions' }, reloadBtn, closeBtn);
  const banner = h('div', { class: 'toast update-banner', role: 'status' }, h('div', { class: 'ub-row' }, text, actions));
  closeBtn.addEventListener('click', () => banner.remove());
  reloadBtn.addEventListener('click', () => {
    const lost = options.beforeReload();
    if (lost.length === 0) return reload();
    // Say what the reload would lose and let the user choose.
    const anyway = h('button', { class: 'btn btn-primary', type: 'button', onclick: reload }, 'Reload anyway');
    const later = h('button', { class: 'btn', type: 'button', onclick: () => banner.remove() }, 'Not now');
    banner.replaceChildren(
      h('div', { class: 'ub-row' }, h('span', { class: 'ub-text' }, `${APP.name} was updated. If you reload now:`)),
      h('ul', { class: 'ub-lost' }, ...lost.map((l) => h('li', {}, l))),
      h('div', { class: 'ub-row ub-end' }, later, anyway),
    );
  });
  return banner;
}
