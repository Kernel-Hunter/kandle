import { BinanceSource } from './binance';
import { CoinbaseSource } from './coinbase';
import type { DataSource, SymbolMeta } from './types';
import type { KeyValueStorage } from '../store/layout';
import { APP } from '../config';

export const SOURCES: readonly DataSource[] = [new BinanceSource(), new CoinbaseSource()];

export function getSource(id: string): DataSource {
  return SOURCES.find((s) => s.id === id) ?? SOURCES[0];
}

const SYMBOL_CACHE_TTL = 24 * 60 * 60 * 1000;
const memoryCache = new Map<string, Promise<SymbolMeta[]>>();

const cacheKey = (source: DataSource) => `${APP.id}:symbols:${source.id}`;

/** The stored symbol list if it is fresh, without touching the network. */
export function cachedSymbols(source: DataSource, storage: KeyValueStorage, now = Date.now()): SymbolMeta[] | null {
  try {
    const raw = storage.getItem(cacheKey(source));
    if (!raw) return null;
    const cached = JSON.parse(raw) as { savedAt: number; symbols: SymbolMeta[] };
    if (now - cached.savedAt < SYMBOL_CACHE_TTL && Array.isArray(cached.symbols) && cached.symbols.length > 0) {
      return cached.symbols;
    }
  } catch {
    // Corrupt cache entry; treat as missing.
  }
  return null;
}

/**
 * Symbol lists are large (Binance exchangeInfo is several MB), so keep a compact copy in
 * storage for a day and share one in-flight request per source.
 */
export function loadSymbols(source: DataSource, storage: KeyValueStorage, now = Date.now()): Promise<SymbolMeta[]> {
  const existing = memoryCache.get(source.id);
  if (existing) return existing;
  const key = cacheKey(source);
  const cached = cachedSymbols(source, storage, now);
  if (cached) {
    const p = Promise.resolve(cached);
    memoryCache.set(source.id, p);
    return p;
  }
  const request = source.listSymbols().then(
    (symbols) => {
      try {
        storage.setItem(key, JSON.stringify({ savedAt: now, symbols }));
      } catch {
        // Storage full or unavailable; the in-memory copy is enough.
      }
      return symbols;
    },
    (error: unknown) => {
      memoryCache.delete(source.id);
      throw error;
    },
  );
  memoryCache.set(source.id, request);
  return request;
}
