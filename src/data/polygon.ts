import { aggregateCandles } from './coinbase';
import { type TimeframeId } from './timeframes';
import { ProviderError, RateLimiter, TtlCache, missingKeyError, requestJson, type Problem } from './http';
import { keyStore, type KeyValues } from './keys';
import { dayStartInZone, sessionLookback } from './live';
import type { Candle, DataSource, FetchCandlesOptions, FetchLike, MarketType, SourceAuth, SubscribeOptions, SymbolMeta } from './types';

/**
 * Polygon.io (now also branded Massive) aggregates with the user's own key. The free plan has
 * end-of-day data, two years of history and 5 requests a minute, and no websocket, so charts
 * from this source do not update live and are labelled as delayed.
 */

const NEW_YORK = 'America/New_York';

const RANGES: Record<TimeframeId, { multiplier: number; timespan: string }> = {
  '1m': { multiplier: 1, timespan: 'minute' },
  '5m': { multiplier: 5, timespan: 'minute' },
  '15m': { multiplier: 15, timespan: 'minute' },
  '1h': { multiplier: 1, timespan: 'hour' },
  '4h': { multiplier: 4, timespan: 'hour' },
  '1D': { multiplier: 1, timespan: 'day' },
  // Polygon weeks start on Sunday; build Monday weeks from days like the other sources.
  '1W': { multiplier: 1, timespan: 'day' },
};

export const POLYGON_PER_MINUTE = 5;

export function polygonRange(timeframe: TimeframeId): { multiplier: number; timespan: string } {
  return RANGES[timeframe];
}

/** Market type from a ticker prefix: C: forex, X: crypto, I: index, otherwise stock. */
export function polygonMarket(ticker: string): MarketType {
  if (ticker.startsWith('C:')) return 'forex';
  if (ticker.startsWith('X:')) return 'crypto';
  if (ticker.startsWith('I:')) return 'index';
  return 'stock';
}

export function parsePolygonAggs(json: unknown, timeframe: TimeframeId, ticker: string): Candle[] {
  const body = json as { results?: Array<{ t: number; o: number; h: number; l: number; c: number; v?: number }>; resultsCount?: number };
  if (!body || typeof body !== 'object') throw new Error('Unexpected aggregates payload from Polygon');
  if (!Array.isArray(body.results)) return [];
  const daily = timeframe === '1D' || timeframe === '1W';
  const market = polygonMarket(ticker);
  // Stock days follow the New York calendar; forex and crypto days are UTC.
  const zone = market === 'forex' || market === 'crypto' ? 'UTC' : NEW_YORK;
  const out: Candle[] = [];
  for (const r of body.results) {
    const candle: Candle = {
      time: daily ? dayStartInZone(Number(r.t), zone) : Number(r.t),
      open: Number(r.o),
      high: Number(r.h),
      low: Number(r.l),
      close: Number(r.c),
      volume: Number(r.v ?? 0),
    };
    if (Object.values(candle).every(Number.isFinite)) out.push(candle);
  }
  return out.sort((a, b) => a.time - b.time);
}

interface PolygonTicker {
  ticker: string;
  name?: string;
  market?: string;
  type?: string;
  currency_name?: string;
  primary_exchange?: string;
  base_currency_symbol?: string;
  currency_symbol?: string;
}

export function polygonMeta(t: PolygonTicker): SymbolMeta {
  let market: MarketType = 'stock';
  if (t.market === 'fx') market = 'forex';
  else if (t.market === 'crypto') market = 'crypto';
  else if (t.market === 'indices') market = 'index';
  else if (t.type === 'ETF' || t.type === 'ETN' || t.type === 'ETV') market = 'etf';
  const pair = market === 'forex' || market === 'crypto';
  const code = t.ticker.replace(/^[A-Z]:/, '');
  const base = pair ? (t.base_currency_symbol ?? code.slice(0, -3)) : code;
  const quote = pair ? (t.currency_symbol ?? code.slice(-3)) : (t.currency_name ?? 'usd').toUpperCase();
  return {
    symbol: t.ticker,
    base,
    quote,
    pricePrecision: market === 'forex' ? (quote === 'JPY' ? 3 : 5) : 2,
    volumePrecision: market === 'crypto' ? 4 : 0,
    market,
    name: t.name,
    exchange: t.primary_exchange,
  };
}

export function parsePolygonTickers(json: unknown): SymbolMeta[] {
  const results = (json as { results?: PolygonTicker[] })?.results;
  if (results === undefined) return [];
  if (!Array.isArray(results)) throw new Error('Unexpected tickers payload from Polygon');
  return results.filter((t) => t && typeof t.ticker === 'string').map(polygonMeta);
}

/** Polygon errors: { status: 'ERROR' | 'NOT_AUTHORIZED', error?, message? }. */
export function classifyPolygon(status: number, body: unknown): Problem | null {
  const b = body as { status?: string; error?: string; message?: string } | null;
  if (status === 429) return { kind: 'rate' };
  if (status === 401) return { kind: 'auth', message: 'Polygon rejected the API key. Check it in Data sources.' };
  if (status === 403 || b?.status === 'NOT_AUTHORIZED') {
    return { kind: 'plan', message: 'Polygon: your plan does not include this data (the free plan covers two years of end-of-day data).' };
  }
  if (status >= 400) {
    const text = b?.error ?? b?.message;
    return { kind: status === 404 ? 'not-found' : status >= 500 ? 'server' : 'bad-request', message: text ? `Polygon: ${text}` : undefined };
  }
  return null;
}

export const POLYGON_POPULAR: readonly SymbolMeta[] = [
  ...['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA'].map((s) => ({ symbol: s, base: s, quote: 'USD', pricePrecision: 2, volumePrecision: 0, market: 'stock' as const })),
  ...['SPY', 'QQQ'].map((s) => ({ symbol: s, base: s, quote: 'USD', pricePrecision: 2, volumePrecision: 0, market: 'etf' as const })),
  { symbol: 'C:EURUSD', base: 'EUR', quote: 'USD', pricePrecision: 5, volumePrecision: 0, market: 'forex' },
  { symbol: 'X:BTCUSD', base: 'BTC', quote: 'USD', pricePrecision: 2, volumePrecision: 4, market: 'crypto' },
];

export interface PolygonOptions {
  fetch?: FetchLike;
  restBase?: string;
  keys?: () => KeyValues | null;
  now?: () => number;
}

export class PolygonSource implements DataSource {
  readonly id = 'polygon';
  readonly name = 'Polygon';
  readonly timeframes: readonly TimeframeId[] = ['1m', '5m', '15m', '1h', '4h', '1D', '1W'];
  readonly markets = ['stock', 'etf', 'forex', 'crypto', 'index'] as const;
  readonly freshness = 'end-of-day' as const;
  readonly note = 'Free plan: end-of-day data, no live updates.';
  readonly auth: SourceAuth = {
    fields: [{ id: 'apiKey', label: 'API key', secret: true, placeholder: 'Paste your Polygon API key' }],
    signupUrl: 'https://polygon.io/dashboard/signup',
    plan: 'Free plan: end-of-day data, 2 years of history, 5 requests a minute. Charts are marked Delayed.',
  };

  private readonly fetchFn: FetchLike;
  private readonly restBase: string;
  private readonly keys: () => KeyValues | null;
  private readonly now: () => number;
  private readonly limiter: RateLimiter;
  private readonly cache: TtlCache<unknown>;

  constructor(options: PolygonOptions = {}) {
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.restBase = options.restBase ?? 'https://api.polygon.io';
    this.keys = options.keys ?? (() => keyStore().get(this.id));
    this.now = options.now ?? Date.now;
    this.limiter = new RateLimiter({ perMinute: POLYGON_PER_MINUTE, now: this.now });
    // End-of-day data barely changes, and the request budget is tiny, so cache for longer.
    this.cache = new TtlCache(5 * 60_000, 100, this.now);
  }

  private get(path: string): Promise<unknown> {
    const key = this.keys()?.apiKey;
    if (!key) throw missingKeyError(this.name);
    return requestJson({
      url: `${this.restBase}${path}`,
      provider: this.name,
      fetch: this.fetchFn,
      headers: { Authorization: `Bearer ${key}` },
      limiter: this.limiter,
      cache: this.cache,
      classify: classifyPolygon,
    });
  }

  async listSymbols(): Promise<SymbolMeta[]> {
    return [...POLYGON_POPULAR];
  }

  async search(query: string): Promise<SymbolMeta[]> {
    const q = query.trim();
    if (!q) return [...POLYGON_POPULAR];
    const params = new URLSearchParams({ search: q, active: 'true', limit: '30' });
    return parsePolygonTickers(await this.get(`/v3/reference/tickers?${params.toString()}`));
  }

  async getSymbol(symbol: string): Promise<SymbolMeta | null> {
    const popular = POLYGON_POPULAR.find((s) => s.symbol === symbol);
    if (popular) return popular;
    // Spend no request: the ticker itself says enough to draw the chart.
    return polygonMeta({ ticker: symbol, market: { forex: 'fx', crypto: 'crypto', index: 'indices' }[polygonMarket(symbol) as string] ?? 'stocks' });
  }

  async testConnection(): Promise<string> {
    await this.get('/v3/reference/tickers?ticker=AAPL&limit=1');
    return 'Key works (free plan data is end of day).';
  }

  async fetchCandles(symbol: string, timeframe: TimeframeId, options: FetchCandlesOptions = {}): Promise<Candle[]> {
    const bars = Math.max(1, Math.min(options.limit ?? 500, 5000));
    const { multiplier, timespan } = polygonRange(timeframe);
    const to = options.before !== undefined ? options.before - 1 : this.now();
    const from = to - sessionLookback(timeframe, bars);
    const params = new URLSearchParams({ adjusted: 'true', sort: 'desc', limit: '50000' });
    const path = `/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/${multiplier}/${timespan}/${Math.floor(from)}/${Math.floor(to)}?${params.toString()}`;
    let json: unknown;
    try {
      json = await this.get(path);
    } catch (error) {
      // Scrolling past the plan's history window is the end of the data, not a failure.
      if (options.before !== undefined && error instanceof ProviderError && error.kind === 'plan') return [];
      throw error;
    }
    let candles = parsePolygonAggs(json, timeframe, symbol);
    if (timeframe === '1W') candles = aggregateCandles(candles, '1W');
    const before = options.before;
    if (before !== undefined) candles = candles.filter((c) => c.time < before);
    return candles.slice(-bars);
  }

  subscribe(_symbol: string, _timeframe: TimeframeId, _onCandle: (candle: Candle) => void, options: SubscribeOptions = {}): () => void {
    // No live feed on the free plan. Say so instead of pretending to be connected.
    options.onStatus?.('delayed');
    return () => options.onStatus?.('closed');
  }
}
