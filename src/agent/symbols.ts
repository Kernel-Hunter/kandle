import { searchSymbols } from '../data/search';
import type { SymbolMeta } from '../data/types';

const compact = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Finds a market from what an agent typed: BTCUSDT, btc/usdt, BTC-USD and so on.
 * Throws with close matches when nothing fits, so the agent can retry.
 */
export function resolveSymbol(list: readonly SymbolMeta[], input: string): SymbolMeta {
  const raw = input.trim();
  const exact = list.find((s) => s.symbol === raw);
  if (exact) return exact;
  const want = compact(raw);
  const byCompact = list.find((s) => compact(s.symbol) === want);
  if (byCompact) return byCompact;
  const parts = raw.toUpperCase().split(/[/:\-_ ]/).filter(Boolean);
  if (parts.length === 2) {
    const [base, quote] = parts;
    const pair = list.find((s) => s.base.toUpperCase() === base && s.quote.toUpperCase() === quote);
    if (pair) return pair;
  }
  const suggestions = searchSymbols([...list], raw, 5).map((s) => s.symbol);
  throw new Error(`Unknown symbol ${input}.${suggestions.length ? ` Close matches: ${suggestions.join(', ')}.` : ''}`);
}
