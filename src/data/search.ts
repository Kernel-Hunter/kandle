import type { SymbolMeta } from './types';

const POPULAR_QUOTES = ['USDT', 'USD', 'USDC', 'FDUSD', 'EUR', 'BTC'];

const normalize = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Ranks symbols for a query: exact match first, then base-asset matches, then prefix
 * matches, then substring matches. Ties prefer common quote currencies.
 */
export function searchSymbols(symbols: SymbolMeta[], query: string, limit = 80): SymbolMeta[] {
  const q = normalize(query);
  const quoteRank = (s: SymbolMeta) => {
    const i = POPULAR_QUOTES.indexOf(s.quote.toUpperCase());
    return i === -1 ? POPULAR_QUOTES.length : i;
  };
  if (!q) {
    return symbols
      // Imported datasets have no quote currency and are always listed.
      .filter((s) => quoteRank(s) < 3 || !s.quote)
      .sort((a, b) => quoteRank(a) - quoteRank(b) || a.symbol.localeCompare(b.symbol))
      .slice(0, limit);
  }
  const scored: Array<{ s: SymbolMeta; score: number }> = [];
  for (const s of symbols) {
    const id = normalize(s.symbol);
    const base = normalize(s.base);
    let score: number;
    if (id === q) score = 0;
    else if (base === q) score = 1;
    else if (id.startsWith(q)) score = 2;
    else if (base.startsWith(q)) score = 3;
    else if (id.includes(q)) score = 4;
    else continue;
    scored.push({ s, score });
  }
  scored.sort((a, b) => a.score - b.score || quoteRank(a.s) - quoteRank(b.s) || a.s.symbol.length - b.s.symbol.length || a.s.symbol.localeCompare(b.s.symbol));
  return scored.slice(0, limit).map((x) => x.s);
}

/** Label for a symbol: "BTC/USDT" for pairs, the ticker alone for stocks, ETFs, indices and imported data. */
export function displayName(meta: SymbolMeta): string {
  if (meta.market === 'stock' || meta.market === 'etf' || meta.market === 'index' || !meta.quote) return meta.base;
  return `${meta.base}/${meta.quote}`;
}
