import { bucketStart, type TimeframeId } from './timeframes';
import { defaultWebSocketFactory, openManagedSocket } from './socket';
import { RateLimiter, TtlCache, missingKeyError, requestJson, type Problem } from './http';
import { keyStore, type KeyValues } from './keys';
import { applyTick, startPolling } from './live';
import type {
  Candle,
  DataSource,
  FetchCandlesOptions,
  FetchLike,
  MarketType,
  SourceAuth,
  SubscribeOptions,
  SymbolMeta,
  WebSocketFactory,
} from './types';

/**
 * Twelve Data: US and global stocks, ETFs, forex and crypto with the user's own free key.
 * The free plan allows 8 requests a minute and 800 a day. Live prices come over its websocket
 * where the plan allows the symbol; otherwise the adapter polls once a minute.
 */

const INTERVALS: Record<TimeframeId, string> = {
  '1m': '1min',
  '5m': '5min',
  '15m': '15min',
  '1h': '1h',
  '4h': '4h',
  '1D': '1day',
  '1W': '1week',
};

export const TWELVEDATA_MAX_OUTPUT = 5000;
export const TWELVEDATA_PER_MINUTE = 8;

export function twelveDataInterval(timeframe: TimeframeId): string {
  return INTERVALS[timeframe];
}

/** "2026-10-15 09:30:00" or "2026-10-15", already in UTC because requests ask for timezone=UTC. */
export function parseTwelveDataTime(datetime: string): number {
  const iso = datetime.length <= 10 ? `${datetime}T00:00:00Z` : `${datetime.replace(' ', 'T')}Z`;
  return Date.parse(iso);
}

/** UTC time as Twelve Data's end_date format. */
export function formatTwelveDataTime(time: number): string {
  return new Date(time).toISOString().slice(0, 19).replace('T', ' ');
}

export function twelveDataMarket(instrumentType: string | undefined): MarketType {
  const t = (instrumentType ?? '').toLowerCase();
  if (t.includes('physical currency')) return 'forex';
  if (t.includes('digital currency')) return 'crypto';
  if (t === 'etf' || t.includes('fund')) return 'etf';
  if (t.includes('index')) return 'index';
  return 'stock';
}

interface TimeSeriesValue {
  datetime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume?: string;
}

export function parseTwelveDataSeries(json: unknown, timeframe: TimeframeId): { candles: Candle[]; timeZone: string; market: MarketType } {
  const body = json as { meta?: { exchange_timezone?: string; type?: string }; values?: TimeSeriesValue[] };
  if (!body || !Array.isArray(body.values)) throw new Error('Unexpected time_series payload from Twelve Data');
  const candles: Candle[] = [];
  for (const v of body.values) {
    let time = parseTwelveDataTime(v.datetime);
    if (timeframe === '1W') time = bucketStart('1W', time);
    const candle: Candle = {
      time,
      open: Number(v.open),
      high: Number(v.high),
      low: Number(v.low),
      close: Number(v.close),
      // Forex pairs have no volume.
      volume: v.volume === undefined ? 0 : Number(v.volume),
    };
    if (Object.values(candle).every(Number.isFinite)) candles.push(candle);
  }
  candles.sort((a, b) => a.time - b.time);
  const market = twelveDataMarket(body.meta?.type);
  // Forex and crypto days run on UTC; stock days follow the exchange's calendar.
  const timeZone = market === 'forex' || market === 'crypto' ? 'UTC' : (body.meta?.exchange_timezone ?? 'America/New_York');
  return { candles, timeZone, market };
}

const US_EXCHANGES = new Set(['NASDAQ', 'NYSE', 'NYSE ARCA', 'NYSE MKT', 'AMEX', 'BATS', 'CBOE', 'OTC']);

interface SearchRow {
  symbol: string;
  instrument_name?: string;
  exchange?: string;
  instrument_type?: string;
  country?: string;
  currency?: string;
}

/** A search row as SymbolMeta. Non-US listings get an exchange suffix ("SAP:XETR") so the id is unambiguous. */
export function twelveDataMeta(row: SearchRow): SymbolMeta {
  const market = twelveDataMarket(row.instrument_type);
  const exchange = row.exchange ?? '';
  const pair = row.symbol.includes('/') ? row.symbol.split('/') : null;
  const usListing = row.country === 'United States' || US_EXCHANGES.has(exchange.toUpperCase());
  const symbol = pair || usListing || !exchange ? row.symbol : `${row.symbol}:${exchange}`;
  const quote = pair ? pair[1] : (row.currency || 'USD');
  return {
    symbol,
    base: pair ? pair[0] : row.symbol,
    quote,
    pricePrecision: market === 'forex' ? (quote === 'JPY' ? 3 : 5) : 2,
    volumePrecision: 0,
    market,
    name: row.instrument_name,
    exchange: exchange || undefined,
  };
}

export function parseTwelveDataSearch(json: unknown): SymbolMeta[] {
  const data = (json as { data?: SearchRow[] })?.data;
  if (!Array.isArray(data)) throw new Error('Unexpected symbol_search payload from Twelve Data');
  const seen = new Set<string>();
  const out: SymbolMeta[] = [];
  for (const row of data) {
    if (!row || typeof row.symbol !== 'string') continue;
    const meta = twelveDataMeta(row);
    if (seen.has(meta.symbol)) continue;
    seen.add(meta.symbol);
    out.push(meta);
  }
  return out;
}

/** Seconds until the next UTC minute or day, for credit limits that reset on the clock. */
function secondsUntilReset(message: string, now: number): number {
  if (/for the day|daily/i.test(message)) {
    const next = Math.floor(now / 86_400_000 + 1) * 86_400_000;
    return Math.ceil((next - now) / 1000);
  }
  return Math.max(1, 60 - new Date(now).getUTCSeconds());
}

/** Twelve Data puts errors in the body ({ code, message, status: 'error' }), sometimes with HTTP 200. */
export function classifyTwelveData(status: number, body: unknown, now = Date.now()): Problem | null {
  const b = body as { code?: number; message?: string; status?: string } | null;
  const code = b && b.status === 'error' && typeof b.code === 'number' ? b.code : status >= 400 ? status : 0;
  if (!code) return null;
  const text = b?.message ?? '';
  if (code === 429) return { kind: 'rate', retryAfter: secondsUntilReset(text, now) };
  if (code === 401) return { kind: 'auth', message: 'Twelve Data rejected the API key. Check it in Data sources.' };
  // The first sentence is specific and useful, e.g. "This symbol is available starting with Grow plan."
  const first = text.split(/(?<=\.)\s/)[0]?.replace(/\*\*/g, '') || `error ${code}`;
  if (code === 403) return { kind: 'plan', message: `Twelve Data: ${first}` };
  if (code === 404 || (code === 400 && /symbol/i.test(text))) return { kind: 'not-found', message: `Twelve Data: ${first}` };
  return { kind: code >= 500 ? 'server' : 'bad-request', message: `Twelve Data: ${first}` };
}

export const TWELVEDATA_POPULAR: readonly SymbolMeta[] = [
  ...['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA'].map((s) => ({ symbol: s, base: s, quote: 'USD', pricePrecision: 2, volumePrecision: 0, market: 'stock' as const })),
  ...['SPY', 'QQQ'].map((s) => ({ symbol: s, base: s, quote: 'USD', pricePrecision: 2, volumePrecision: 0, market: 'etf' as const })),
  ...['EUR/USD', 'GBP/USD', 'USD/JPY'].map((s) => {
    const [base, quote] = s.split('/');
    return { symbol: s, base, quote, pricePrecision: quote === 'JPY' ? 3 : 5, volumePrecision: 0, market: 'forex' as const };
  }),
  { symbol: 'BTC/USD', base: 'BTC', quote: 'USD', pricePrecision: 2, volumePrecision: 4, market: 'crypto' },
];

export interface TwelveDataOptions {
  fetch?: FetchLike;
  webSocketFactory?: WebSocketFactory;
  restBase?: string;
  wsUrl?: string;
  keys?: () => KeyValues | null;
  now?: () => number;
  /** How often to poll when the websocket is not available. */
  pollMs?: number;
}

export class TwelveDataSource implements DataSource {
  readonly id = 'twelvedata';
  readonly name = 'Twelve Data';
  readonly timeframes: readonly TimeframeId[] = ['1m', '5m', '15m', '1h', '4h', '1D', '1W'];
  readonly markets = ['stock', 'etf', 'forex', 'crypto'] as const;
  readonly freshness = 'live' as const;
  readonly auth: SourceAuth = {
    fields: [{ id: 'apiKey', label: 'API key', secret: true, placeholder: 'Paste your Twelve Data API key' }],
    signupUrl: 'https://twelvedata.com/register',
    plan: 'Free plan: 8 requests a minute, 800 a day. Live prices for a few trial symbols, others update once a minute.',
  };

  private readonly fetchFn: FetchLike;
  private readonly wsFactory: WebSocketFactory;
  private readonly restBase: string;
  private readonly wsUrl: string;
  private readonly keys: () => KeyValues | null;
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly limiter: RateLimiter;
  private readonly searchLimiter: RateLimiter;
  private readonly cache: TtlCache<unknown>;
  private readonly searchCache: TtlCache<unknown>;
  /** Exchange time zone per symbol, learned from time_series meta. */
  private readonly zones = new Map<string, string>();

  constructor(options: TwelveDataOptions = {}) {
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.wsFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.restBase = options.restBase ?? 'https://api.twelvedata.com';
    this.wsUrl = options.wsUrl ?? 'wss://ws.twelvedata.com/v1/quotes/price';
    this.keys = options.keys ?? (() => keyStore().get(this.id));
    this.now = options.now ?? Date.now;
    this.pollMs = options.pollMs ?? 60_000;
    this.limiter = new RateLimiter({ perMinute: TWELVEDATA_PER_MINUTE, now: this.now });
    this.searchLimiter = new RateLimiter({ now: this.now });
    this.cache = new TtlCache(30_000, 50, this.now);
    this.searchCache = new TtlCache(10 * 60_000, 100, this.now);
  }

  private apiKey(): string {
    const key = this.keys()?.apiKey;
    if (!key) throw missingKeyError(this.name);
    return key;
  }

  private get(path: string, opts: { search?: boolean } = {}): Promise<unknown> {
    // The key goes in a header, so it never ends up in URLs, caches or logs.
    const key = this.apiKey();
    return requestJson({
      url: `${this.restBase}${path}`,
      provider: this.name,
      fetch: this.fetchFn,
      headers: { Authorization: `apikey ${key}` },
      limiter: opts.search ? this.searchLimiter : this.limiter,
      cache: opts.search ? this.searchCache : this.cache,
      classify: (status, body) => classifyTwelveData(status, body, this.now()),
    });
  }

  async listSymbols(): Promise<SymbolMeta[]> {
    return [...TWELVEDATA_POPULAR];
  }

  async search(query: string): Promise<SymbolMeta[]> {
    const q = query.trim();
    if (!q) return [...TWELVEDATA_POPULAR];
    const json = await this.get(`/symbol_search?${new URLSearchParams({ symbol: q, outputsize: '30' }).toString()}`, { search: true });
    return parseTwelveDataSearch(json);
  }

  async getSymbol(symbol: string): Promise<SymbolMeta | null> {
    const popular = TWELVEDATA_POPULAR.find((s) => s.symbol === symbol);
    if (popular) return popular;
    try {
      const [bare] = symbol.split(':');
      const found = await this.search(bare);
      return found.find((s) => s.symbol === symbol) ?? null;
    } catch {
      return null;
    }
  }

  async testConnection(): Promise<string> {
    const json = (await this.get('/api_usage')) as { current_usage?: number; plan_limit?: number; plan_category?: string };
    const plan = json?.plan_category ? `${json.plan_category} plan` : 'your plan';
    if (typeof json?.current_usage === 'number' && typeof json?.plan_limit === 'number') {
      return `Key works (${plan}, ${json.current_usage} of ${json.plan_limit} requests used this minute).`;
    }
    return `Key works (${plan}).`;
  }

  async fetchCandles(symbol: string, timeframe: TimeframeId, options: FetchCandlesOptions = {}): Promise<Candle[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 500, TWELVEDATA_MAX_OUTPUT));
    const params = new URLSearchParams({ symbol, interval: twelveDataInterval(timeframe), outputsize: String(limit), timezone: 'UTC' });
    // end_date is inclusive and has second precision.
    if (options.before !== undefined) params.set('end_date', formatTwelveDataTime(options.before - 1000));
    const json = await this.get(`/time_series?${params.toString()}`);
    const { candles, timeZone } = parseTwelveDataSeries(json, timeframe);
    this.zones.set(symbol, timeZone);
    const before = options.before;
    return before === undefined ? candles : candles.filter((c) => c.time < before);
  }

  subscribe(symbol: string, timeframe: TimeframeId, onCandle: (candle: Candle) => void, options: SubscribeOptions = {}): () => void {
    let key: string;
    try {
      key = this.apiKey();
    } catch (error) {
      options.onError?.((error as Error).message);
      options.onStatus?.('closed');
      return () => undefined;
    }
    let current: Candle | null = options.seed ? { ...options.seed } : null;
    let lastDayVolume: number | null = null;
    let stopSocket: (() => void) | null = null;
    let stopPoll: (() => void) | null = null;
    let opened = false;
    let failures = 0;
    let stopped = false;

    const poll = () => {
      if (stopped || stopPoll) return;
      stopSocket?.();
      stopSocket = null;
      stopPoll = startPolling({
        intervalMs: this.pollMs,
        poll: async () => {
          const bars = await this.fetchCandles(symbol, timeframe, { limit: 2 });
          if (bars.length) current = { ...bars[bars.length - 1] };
          return bars;
        },
        onCandle,
        onStatus: options.onStatus,
        onError: options.onError,
      });
    };

    stopSocket = openManagedSocket({
      // The websocket only accepts the key as a URL parameter. It goes to Twelve Data only.
      url: `${this.wsUrl}?apikey=${encodeURIComponent(key)}`,
      factory: this.wsFactory,
      backoff: [1000, 3000],
      heartbeat: { intervalMs: 10_000, message: JSON.stringify({ action: 'heartbeat' }) },
      onStatus: (status) => {
        if (status === 'live') opened = true;
        if (status === 'reconnecting' && !opened && ++failures >= 2) {
          // The plan has no websocket access, or the key was refused: fall back to polling.
          poll();
          return;
        }
        if (!stopPoll && status !== 'closed') options.onStatus?.(status);
      },
      onOpen: (ws) => ws.send(JSON.stringify({ action: 'subscribe', params: { symbols: symbol } })),
      onMessage: (data) => {
        let msg: { event?: string; symbol?: string; price?: number; timestamp?: number; day_volume?: number; fails?: unknown[]; status?: string };
        try {
          msg = JSON.parse(data);
        } catch {
          return;
        }
        if (msg.event === 'subscribe-status') {
          if (msg.status !== 'ok' || (Array.isArray(msg.fails) && msg.fails.length > 0)) poll();
          return;
        }
        if (msg.event !== 'price' || msg.symbol !== symbol.split(':')[0]) return;
        const price = Number(msg.price);
        const time = Number(msg.timestamp) * 1000;
        if (!Number.isFinite(price) || !Number.isFinite(time)) return;
        let size = 0;
        if (typeof msg.day_volume === 'number') {
          if (lastDayVolume !== null && msg.day_volume >= lastDayVolume) size = msg.day_volume - lastDayVolume;
          lastDayVolume = msg.day_volume;
        }
        current = applyTick(current, timeframe, { price, size, time }, this.zones.get(symbol) ?? 'UTC');
        onCandle({ ...current });
      },
    });

    return () => {
      stopped = true;
      stopSocket?.();
      stopPoll?.();
      options.onStatus?.('closed');
    };
  }
}

