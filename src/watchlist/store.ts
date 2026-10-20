import { APP } from '../config';
import type { KeyValueStorage } from '../store/layout';

/** One watchlist row. The source is kept per row, so a list can mix exchanges and providers. */
export interface WatchItem {
  source: string;
  symbol: string;
}

export interface WatchlistConfig {
  version: 1;
  /** Whether the panel is showing. */
  open: boolean;
  items: WatchItem[];
}

export const MAX_ITEMS = 50;

export const DEFAULT_ITEMS: readonly WatchItem[] = [
  { source: 'binance', symbol: 'BTCUSDT' },
  { source: 'binance', symbol: 'ETHUSDT' },
  { source: 'binance', symbol: 'SOLUSDT' },
];

/** Same shape the MCP tools accept: letters, digits and . _ : / - */
const SYMBOL = /^[A-Za-z0-9._:/-]{1,40}$/;

export function defaultWatchlist(open = false): WatchlistConfig {
  return { version: 1, open, items: DEFAULT_ITEMS.map((i) => ({ ...i })) };
}

export const itemKey = (item: WatchItem): string => `${item.source}:${item.symbol}`;

export function sameItem(a: WatchItem, b: WatchItem): boolean {
  return a.source === b.source && a.symbol === b.symbol;
}

/** Accepts anything (old versions, hand-edited JSON) and returns a valid list without duplicates. */
export function sanitizeWatchlist(raw: unknown, isSource: (id: string) => boolean = () => true): WatchlistConfig {
  if (!raw || typeof raw !== 'object') return defaultWatchlist();
  const r = raw as Record<string, unknown>;
  const items: WatchItem[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(r.items) ? r.items : []) {
    if (!entry || typeof entry !== 'object') continue;
    const { source, symbol } = entry as Record<string, unknown>;
    if (typeof source !== 'string' || !isSource(source) || typeof symbol !== 'string' || !SYMBOL.test(symbol)) continue;
    const item = { source, symbol };
    if (seen.has(itemKey(item))) continue;
    seen.add(itemKey(item));
    items.push(item);
    if (items.length >= MAX_ITEMS) break;
  }
  return { version: 1, open: r.open === true, items };
}

const key = () => `${APP.id}:watchlist`;

/** The saved list, or the default one on first run. `openByDefault` decides the panel on first run. */
export function loadWatchlist(storage: KeyValueStorage, isSource?: (id: string) => boolean, openByDefault = false): WatchlistConfig {
  try {
    const raw = storage.getItem(key());
    return raw === null ? defaultWatchlist(openByDefault) : sanitizeWatchlist(JSON.parse(raw), isSource);
  } catch {
    return defaultWatchlist(openByDefault);
  }
}

export function saveWatchlist(storage: KeyValueStorage, config: WatchlistConfig): boolean {
  try {
    storage.setItem(key(), JSON.stringify(sanitizeWatchlist(config)));
    return true;
  } catch {
    return false;
  }
}

/** Adds at the end, or at `index`. Returns null when the item is already listed, invalid or the list is full. */
export function addItem(items: readonly WatchItem[], item: WatchItem, index = items.length): WatchItem[] | null {
  if (!SYMBOL.test(item.symbol) || items.some((i) => sameItem(i, item)) || items.length >= MAX_ITEMS) return null;
  const next = [...items];
  next.splice(Math.max(0, Math.min(index, next.length)), 0, { source: item.source, symbol: item.symbol });
  return next;
}

/** Returns null when the item is not listed. */
export function removeItem(items: readonly WatchItem[], item: WatchItem): WatchItem[] | null {
  const next = items.filter((i) => !sameItem(i, item));
  return next.length === items.length ? null : next;
}

/** Moves the row at `from` so it ends up at index `to`. */
export function moveItem(items: readonly WatchItem[], from: number, to: number): WatchItem[] {
  if (from < 0 || from >= items.length) return [...items];
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, moved);
  return next;
}
