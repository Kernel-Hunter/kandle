/**
 * Embed links: a share link with `?embed=1` before the fragment, for an iframe on another
 * site. The chart stays in `#s=` in the same format as a share link (src/share/codec.ts); the
 * query only says how to show it, so it is the only part a server sees and it says nothing
 * about the chart. `theme=light` or `theme=dark` fixes the colors; without it the embed
 * follows the viewer's system setting.
 */
import { APP } from '../config';
import { getSource } from '../data/sources';
import { getTimeframe } from '../data/timeframes';
import type { Theme } from '../store/layout';
import { SHARE_HASH, shareUrl, type SharedChart } from './codec';

export const EMBED_PARAM = 'embed';
export const THEME_PARAM = 'theme';

export const SCRIPTS_NOT_RUN = `Open in ${APP.name} to run scripts.`;

export interface EmbedParams {
  embed: boolean;
  /** Null follows prefers-color-scheme. */
  theme: Theme | null;
}

/** Reads the query of a page address (`location.search`). Anything but embed=1 is the normal app. */
export function parseEmbedParams(search: string): EmbedParams {
  const params = new URLSearchParams(search);
  const theme = params.get(THEME_PARAM);
  return { embed: params.get(EMBED_PARAM) === '1', theme: theme === 'light' || theme === 'dark' ? theme : null };
}

/**
 * True when the page runs inside a frame. The full app refuses to run there: GitHub Pages
 * cannot send headers that forbid framing, so another site could lay its own page over
 * buttons such as Run scripts or Keep it. Reading `top` across origins can throw, which
 * counts as framed.
 */
export function isFramed(win: { readonly top: unknown; readonly self: unknown } = window): boolean {
  try {
    return win.top !== win.self;
  } catch {
    return true;
  }
}

/** The app's address: `page` without its query and fragment. */
export function appPage(page: string): string {
  return page.split('#')[0].split('?')[0];
}

/** An embed URL for a share payload (the part after `#s=`). */
export function embedUrl(page: string, payload: string, theme: Theme | null = null): string {
  const query = `?${EMBED_PARAM}=1${theme ? `&${THEME_PARAM}=${theme}` : ''}`;
  return `${appPage(page)}${query}${SHARE_HASH}${payload}`;
}

/** The normal share link for the chart an embed shows, for its Open in Kandle link. */
export function openInAppUrl(page: string, hash: string): string {
  const app = appPage(page);
  return hash.startsWith(SHARE_HASH) ? shareUrl(app, hash.slice(SHARE_HASH.length)) : app;
}

// ---------------------------------------------------------------- iframe snippet

export type EmbedWidth = number | '100%';

export interface EmbedSize {
  label: string;
  width: EmbedWidth;
  height: number;
}

export const EMBED_SIZES: readonly EmbedSize[] = [
  { label: 'Medium, 640 × 400', width: 640, height: 400 },
  { label: 'Small, 480 × 300', width: 480, height: 300 },
  { label: 'Large, 960 × 540', width: 960, height: 540 },
  { label: 'Full width, 400 high', width: '100%', height: 400 },
];

const SIZE_RANGE = { min: 100, max: 4000 } as const;

/** Escapes text for a double or single quoted HTML attribute. */
export function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The iframe's title, which screen readers announce: "Kandle chart: ETHUSDT 4H on Binance". */
export function embedTitle(chart: Pick<SharedChart, 'source' | 'symbol' | 'timeframe'>): string {
  return `${APP.name} chart: ${chart.symbol} ${getTimeframe(chart.timeframe)?.label ?? chart.timeframe} on ${getSource(chart.source).name}`;
}

/** The HTML to paste into a page. Every value is escaped, so a symbol or URL cannot add markup. */
export function iframeSnippet(options: { url: string; title: string; width: EmbedWidth; height: number }): string {
  const { url, title, width, height } = options;
  return `<iframe src="${escapeAttribute(url)}" title="${escapeAttribute(title)}" width="${escapeAttribute(String(width))}" height="${escapeAttribute(String(height))}" style="border:0" loading="lazy"></iframe>`;
}

export interface EmbedOptions {
  theme: Theme | null;
  width: EmbedWidth;
  height: number;
}

export const DEFAULT_EMBED_OPTIONS: Readonly<EmbedOptions> = Object.freeze({ theme: null, width: EMBED_SIZES[0].width, height: EMBED_SIZES[0].height });

function pixels(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < SIZE_RANGE.min || value > SIZE_RANGE.max) {
    throw new Error(`${what} must be a whole number of pixels from ${SIZE_RANGE.min} to ${SIZE_RANGE.max}`);
  }
  return value;
}

/** Reads theme, width and height from automation; missing ones get the defaults. */
export function parseEmbedOptions(raw: { theme?: unknown; width?: unknown; height?: unknown } | null | undefined): EmbedOptions {
  const options: EmbedOptions = { ...DEFAULT_EMBED_OPTIONS };
  if (!raw) return options;
  if (raw.theme !== undefined && raw.theme !== null && raw.theme !== 'auto') {
    if (raw.theme !== 'light' && raw.theme !== 'dark') throw new Error('theme must be light, dark or auto');
    options.theme = raw.theme;
  }
  if (raw.width !== undefined && raw.width !== null) options.width = raw.width === '100%' ? '100%' : pixels(raw.width, 'width');
  if (raw.height !== undefined && raw.height !== null) options.height = pixels(raw.height, 'height');
  return options;
}
