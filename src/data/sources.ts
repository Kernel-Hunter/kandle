import { AlpacaSource } from './alpaca';
import { BinanceSource } from './binance';
import { BybitSource } from './bybit';
import { CoinbaseSource } from './coinbase';
import { CsvSource } from './csv';
import { keyStore } from './keys';
import { KrakenSource } from './kraken';
import { OkxSource } from './okx';
import { PolygonSource } from './polygon';
import { TwelveDataSource } from './twelvedata';
import type { DataSource, MarketType, SymbolMeta } from './types';
import type { KeyValueStorage } from '../store/layout';
import { APP } from '../config';

/** Keyless crypto exchanges first, then providers that need the user's own free key, then imported files. */
export const SOURCES: readonly DataSource[] = [
  new BinanceSource(),
  new CoinbaseSource(),
  new BybitSource(),
  new OkxSource(),
  new KrakenSource(),
  new TwelveDataSource(),
  new AlpacaSource(),
  new PolygonSource(),
  new CsvSource(),
];

/** Markets a source covers; sources that do not say are crypto exchanges. */
export function sourceMarkets(source: DataSource): readonly MarketType[] {
  return source.markets ?? ['crypto'];
}

/** True when the source needs a key and every key field has a value saved in this browser. */
export function hasKey(source: DataSource): boolean {
  if (!source.auth) return true;
  return keyStore().has(source.id, source.auth.fields.map((f) => f.id));
}

export function getSource(id: string): DataSource {
  return SOURCES.find((s) => s.id === id) ?? SOURCES[0];
}

const SYMBOL_CACHE_TTL = 24 * 60 * 60 * 1000;
const memoryCache = new Map<string, Promise<SymbolMeta[]>>();

const cacheKey = (source: DataSource) => `${APP.id}:symbols:${source.id}`;

/** The stored symbol list if it is fresh, without touching the network. */
export function cachedSymbols(source: DataSource, storage: KeyValueStorage, now = Date.now()): SymbolMeta[] | null {
  if (source.local) return null;
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
  // Imported data changes with every import, and reading it is cheap.
  if (source.local) return source.listSymbols();
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
