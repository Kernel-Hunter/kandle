import { aggregateCandles } from './coinbase';
import { bucketStart, type TimeframeId } from './timeframes';
import { defaultWebSocketFactory, openManagedSocket } from './socket';
import { RateLimiter, TtlCache, requestJson, type Problem } from './http';
import type { Candle, DataSource, FetchCandlesOptions, FetchLike, SubscribeOptions, SymbolMeta, WebSocketFactory } from './types';

/**
 * Kraken spot market data. No key needed.
 *
 * Kraken's public OHLC endpoint only returns the most recent 720 bars of each interval and has
 * no way to page further back, so history on Kraken is shorter than on the other exchanges.
 */

/** Kraken intervals in minutes. Weekly bars are built from daily ones: Kraken's start on Thursday. */
const INTERVALS: Record<TimeframeId, number> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '1h': 60,
  '4h': 240,
  '1D': 1440,
  '1W': 1440,
};

export const KRAKEN_MAX_BARS = 720;

export function krakenInterval(timeframe: TimeframeId): number {
  return INTERVALS[timeframe];
}

/** Kraken still uses XBT and XDG in REST names; its v2 websocket and most people say BTC and DOGE. */
export function krakenAssetName(asset: string): string {
  if (asset === 'XBT') return 'BTC';
  if (asset === 'XDG') return 'DOGE';
  return asset;
}

/** The v2 websocket symbol for a REST pair, from its v1 `wsname` (e.g. "XBT/USD" -> "BTC/USD"). */
export function krakenWsSymbol(wsname: string): string {
  return wsname.split('/').map(krakenAssetName).join('/');
}

/** One OHLC row: [time (s), open, high, low, close, vwap, volume, count]. */
export function parseKrakenOhlc(row: unknown): Candle {
  if (!Array.isArray(row) || row.length < 7) throw new Error('Unexpected OHLC row from Kraken');
  const candle: Candle = {
    time: Number(row[0]) * 1000,
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[6]),
  };
  if (!Object.values(candle).every(Number.isFinite)) throw new Error('OHLC row from Kraken contains non-numeric values');
  return candle;
}

interface KrakenPair {
  altname: string;
  wsname?: string;
  base: string;
  quote: string;
  pair_decimals?: number;
  lot_decimals?: number;
  status?: string;
}

export function parseKrakenPairs(json: unknown): SymbolMeta[] {
  const result = (json as { result?: Record<string, KrakenPair> })?.result;
  if (!result || typeof result !== 'object') throw new Error('Unexpected AssetPairs payload from Kraken');
  const out: SymbolMeta[] = [];
  for (const [key, p] of Object.entries(result)) {
    // ".d" pairs are the dark pool; they have no public candles.
    if (key.endsWith('.d') || !p.wsname || (p.status && p.status !== 'online')) continue;
    const [base, quote] = krakenWsSymbol(p.wsname).split('/');
    out.push({
      symbol: p.altname,
      base,
      quote,
      pricePrecision: typeof p.pair_decimals === 'number' ? p.pair_decimals : 2,
      volumePrecision: typeof p.lot_decimals === 'number' ? p.lot_decimals : 4,
      market: 'crypto',
    });
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** Kraken answers HTTP 200 with { error: ["EQuery:Unknown asset pair"] } on failure. */
export function classifyKraken(status: number, body: unknown): Problem | null {
  if (status === 429) return { kind: 'rate' };
  const errors = (body as { error?: unknown })?.error;
  if (Array.isArray(errors) && errors.length > 0) {
    const text = errors.map(String).join('; ');
    if (/rate limit|too many/i.test(text)) return { kind: 'rate' };
    if (/unknown asset pair/i.test(text)) return { kind: 'not-found', message: 'Kraken does not list this pair.' };
    return { kind: 'bad-request', message: `Kraken: ${text}` };
  }
  return null;
}

/** A v2 websocket ohlc message: { channel: 'ohlc', type, data: [{ symbol, open, ..., interval_begin }] }. */
export function parseKrakenStream(message: unknown, wsSymbol: string, interval: number): Candle[] {
  const msg = message as { channel?: string; data?: Array<Record<string, unknown>> };
  if (!msg || msg.channel !== 'ohlc' || !Array.isArray(msg.data)) return [];
  const out: Candle[] = [];
  for (const k of msg.data) {
    if (k.symbol !== wsSymbol || Number(k.interval) !== interval) continue;
    const candle: Candle = {
      time: Date.parse(String(k.interval_begin)),
      open: Number(k.open),
      high: Number(k.high),
      low: Number(k.low),
      close: Number(k.close),
      volume: Number(k.volume),
    };
    if (Object.values(candle).every(Number.isFinite)) out.push(candle);
  }
  return out.sort((a, b) => a.time - b.time);
}

export interface KrakenOptions {
  fetch?: FetchLike;
  webSocketFactory?: WebSocketFactory;
  restBase?: string;
  wsUrl?: string;
  now?: () => number;
}

export class KrakenSource implements DataSource {
  readonly id = 'kraken';
  readonly name = 'Kraken';
  readonly timeframes: readonly TimeframeId[] = ['1m', '5m', '15m', '1h', '4h', '1D', '1W'];
  readonly markets = ['crypto'] as const;
  readonly freshness = 'live' as const;
  readonly note = 'History is limited to the latest 720 bars per timeframe.';

  private readonly fetchFn: FetchLike;
  private readonly wsFactory: WebSocketFactory;
  private readonly restBase: string;
  private readonly wsUrl: string;
  private readonly limiter: RateLimiter;
  /** OHLC pages are served whole, so scrolling back reuses the last response. */
  private readonly cache: TtlCache<unknown>;
  private readonly wsNames = new Map<string, string>();

  constructor(options: KrakenOptions = {}) {
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.wsFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.restBase = options.restBase ?? 'https://api.kraken.com';
    this.wsUrl = options.wsUrl ?? 'wss://ws.kraken.com/v2';
    this.limiter = new RateLimiter({ now: options.now });
    this.cache = new TtlCache(20_000, 20, options.now);
  }

  private get(path: string, cache = false): Promise<unknown> {
    return requestJson({
      url: `${this.restBase}${path}`,
      provider: 'Kraken',
      fetch: this.fetchFn,
      limiter: this.limiter,
      classify: classifyKraken,
      cache: cache ? this.cache : undefined,
    });
  }

  private remember(list: SymbolMeta[]): SymbolMeta[] {
    for (const s of list) this.wsNames.set(s.symbol, `${s.base}/${s.quote}`);
    return list;
  }

  async listSymbols(): Promise<SymbolMeta[]> {
    return this.remember(parseKrakenPairs(await this.get('/0/public/AssetPairs')));
  }

  async getSymbol(symbol: string): Promise<SymbolMeta | null> {
    try {
      const json = await this.get(`/0/public/AssetPairs?pair=${encodeURIComponent(symbol)}`);
      return this.remember(parseKrakenPairs(json))[0] ?? null;
    } catch {
      return null;
    }
  }

  async fetchCandles(symbol: string, timeframe: TimeframeId, options: FetchCandlesOptions = {}): Promise<Candle[]> {
    const params = new URLSearchParams({ pair: symbol, interval: String(krakenInterval(timeframe)) });
    const path = `/0/public/OHLC?${params.toString()}`;
    // The first page is always fresh; older pages come out of the same cached response.
    const json = (await this.get(path, options.before !== undefined)) as { result?: Record<string, unknown> };
    if (options.before === undefined) this.cache.set(`${this.restBase}${path}`, json);
    const result = json?.result;
    const rows = result ? Object.entries(result).find(([k, v]) => k !== 'last' && Array.isArray(v))?.[1] : undefined;
    if (!Array.isArray(rows)) throw new Error('Unexpected OHLC payload from Kraken');
    let candles = rows.map(parseKrakenOhlc).sort((a, b) => a.time - b.time);
    if (timeframe === '1W') candles = aggregateCandles(candles, '1W');
    const before = options.before;
    if (before !== undefined) candles = candles.filter((c) => c.time < before);
    const limit = Math.max(1, options.limit ?? KRAKEN_MAX_BARS);
    return candles.slice(-limit);
  }

  /** The v2 websocket name of a pair, e.g. XBTUSD -> BTC/USD. */
  async wsSymbolFor(symbol: string): Promise<string> {
    const known = this.wsNames.get(symbol);
    if (known) return known;
    const meta = await this.getSymbol(symbol);
    return meta ? `${meta.base}/${meta.quote}` : symbol;
  }

  subscribe(symbol: string, timeframe: TimeframeId, onCandle: (candle: Candle) => void, options: SubscribeOptions = {}): () => void {
    const interval = krakenInterval(timeframe);
    let stop: (() => void) | null = null;
    let cancelled = false;
    // Weekly bars are rebuilt from the daily bars of the current week.
    const days = new Map<number, Candle>();
    const emit = (candle: Candle) => {
      if (timeframe !== '1W') {
        onCandle(candle);
        return;
      }
      days.set(candle.time, candle);
      const week = bucketStart('1W', candle.time);
      const inWeek = [...days.values()].filter((d) => bucketStart('1W', d.time) === week).sort((a, b) => a.time - b.time);
      for (const t of days.keys()) if (t < week) days.delete(t);
      const [weekly] = aggregateCandles(inWeek, '1W');
      if (weekly) onCandle(weekly);
    };
    void this.wsSymbolFor(symbol).then((wsSymbol) => {
      if (cancelled) return;
      stop = openManagedSocket({
        url: this.wsUrl,
        factory: this.wsFactory,
        onStatus: options.onStatus,
        onOpen: (ws) =>
          ws.send(JSON.stringify({ method: 'subscribe', params: { channel: 'ohlc', symbol: [wsSymbol], interval, snapshot: true } })),
        onMessage: (data) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            return;
          }
          for (const candle of parseKrakenStream(parsed, wsSymbol, interval)) emit(candle);
        },
      });
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }
}
