import './styles.css';
import { App } from './app';
import { APP } from './config';
import { ShareError, decodeShareHash, isShareHash } from './share/codec';
import { EMBED_PARAM, isFramed, parseEmbedParams } from './share/embed';
import { keyGate, keyedSources } from './share/keyGate';
import { openSharedView, type SharedView } from './share/view';
import { browserStorage, type KeyValueStorage } from './store/layout';
import { h } from './ui/dom';
import { watchForUpdates } from './update';

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app element');

/**
 * Opens a #s= share link as a temporary view over the saved chart. A link that cannot be read
 * leaves the saved chart alone and says why.
 */
async function openLink(storage: KeyValueStorage): Promise<{ view: SharedView | null; error: string | null }> {
  if (!isShareHash(window.location.hash)) return { view: null, error: null };
  try {
    const { chart, notes } = await decodeShareHash(window.location.hash);
    // The link picks the source but the key is the viewer's: those charts wait for a click.
    keyGate().hold(keyedSources(chart));
    return { view: openSharedView(storage, chart, notes), error: null };
  } catch (error) {
    history.replaceState(null, '', window.location.pathname + window.location.search);
    const detail = error instanceof ShareError ? error.message : 'The link could not be read.';
    return { view: null, error: `Could not open the shared chart. ${detail} Your own chart is shown instead.` };
  }
}

// A new link pasted into the address bar of an open tab only changes the hash.
window.addEventListener('hashchange', () => {
  if (isShareHash(window.location.hash)) window.location.reload();
});

const failed = (error: unknown) => {
  console.error(error);
  root.textContent = `${APP.name} failed to start: ${error instanceof Error ? error.message : String(error)}`;
};

/** In a frame the full app does not start; it offers itself in a tab of its own instead. */
function showFramed(el: HTMLElement): void {
  el.replaceChildren(
    h(
      'div',
      { class: 'framed' },
      h('p', { class: 'framed-title' }, `${APP.name} opens in its own tab.`),
      h('a', { class: 'btn btn-primary', href: window.location.href, target: '_blank', rel: 'noopener' }, `Open ${APP.name}`),
      h('p', { class: 'muted' }, `To show a chart on another page, use an embed link (?${EMBED_PARAM}=1) from Share, then Embed. Those are made for pages.`),
    ),
  );
}

document.title = APP.name;
const embed = parseEmbedParams(window.location.search);
if (embed.embed) {
  // An iframe on another site: the chart only, and nothing read from or written to browser storage.
  import('./embed')
    .then(({ startEmbed }) => startEmbed(root, embed))
    .catch(failed);
} else if (isFramed()) {
  showFramed(root);
} else {
  const storage = browserStorage();
  openLink(storage)
    .then(async ({ view, error }) => {
      const app = new App(root, view?.storage ?? storage, view);
      await app.start();
      if (error) app.toast(error, 'error');
      // A tab left open learns about a new deploy; embeds and framed pages never check.
      watchForUpdates(() => app.offerUpdate());
    })
    .catch(failed);
}
