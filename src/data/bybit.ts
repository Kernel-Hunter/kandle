import { precisionFromIncrement, type TimeframeId } from './timeframes';
import { defaultWebSocketFactory, openManagedSocket } from './socket';
import { RateLimiter, requestJson, type Problem } from './http';
import type { Candle, DataSource, FetchCandlesOptions, FetchLike, SubscribeOptions, SymbolMeta, WebSocketFactory } from './types';

/** Bybit spot market data (v5 public API). No key needed. */

const INTERVALS: Record<TimeframeId, string> = {
  '1m': '1',
  '5m': '5',
  '15m': '15',
  '1h': '60',
  '4h': '240',
  '1D': 'D',
  '1W': 'W',
};

export const BYBIT_MAX_LIMIT = 1000;

export function bybitInterval(timeframe: TimeframeId): string {
  return INTERVALS[timeframe];
}

/** One row of /v5/market/kline: [start, open, high, low, close, volume, turnover], all strings. */
export function parseBybitKline(row: unknown): Candle {
  if (!Array.isArray(row) || row.length < 6) throw new Error('Unexpected kline row from Bybit');
  const candle: Candle = {
    time: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  };
  if (!Object.values(candle).every(Number.isFinite)) throw new Error('Kline row from Bybit contains non-numeric values');
  return candle;
}

/** A websocket kline push: { topic: 'kline.60.BTCUSDT', data: [{ start, open, ... }] }. */
export function parseBybitStream(message: unknown, topic: string): Candle[] {
  const msg = message as { topic?: string; data?: Array<Record<string, unknown>> };
  if (!msg || msg.topic !== topic || !Array.isArray(msg.data)) return [];
  const out: Candle[] = [];
  for (const k of msg.data) {
    const candle: Candle = {
      time: Number(k.start),
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

interface BybitInstrument {
  symbol: string;
  baseCoin: string;
  quoteCoin: string;
  status: string;
  priceFilter?: { tickSize?: string };
  lotSizeFilter?: { basePrecision?: string };
}

export function parseBybitInstruments(json: unknown): SymbolMeta[] {
  const list = (json as { result?: { list?: BybitInstrument[] } })?.result?.list;
  if (!Array.isArray(list)) throw new Error('Unexpected instruments payload from Bybit');
  return list
    .filter((s) => s.status === 'Trading')
    .map((s) => ({
      symbol: s.symbol,
      base: s.baseCoin,
      quote: s.quoteCoin,
      pricePrecision: s.priceFilter?.tickSize ? precisionFromIncrement(s.priceFilter.tickSize) : 2,
      volumePrecision: s.lotSizeFilter?.basePrecision ? precisionFromIncrement(s.lotSizeFilter.basePrecision) : 4,
      market: 'crypto' as const,
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** Bybit reports errors in `retCode` with HTTP 200. 10006 is its rate limit code. */
export function classifyBybit(status: number, body: unknown): Problem | null {
  if (status === 403) return { kind: 'plan', message: 'Bybit refused the request. It blocks some regions.' };
  if (status === 429) return { kind: 'rate' };
  const b = body as { retCode?: number; retMsg?: string } | null;
  if (b && typeof b.retCode === 'number' && b.retCode !== 0) {
    if (b.retCode === 10006 || b.retCode === 10018) return { kind: 'rate' };
    if (b.retCode === 10001 && /symbol/i.test(b.retMsg ?? '')) return { kind: 'not-found', message: 'Bybit does not list this symbol.' };
    return { kind: 'bad-request', message: `Bybit: ${b.retMsg ?? `error ${b.retCode}`}` };
  }
  return null;
}

export interface BybitOptions {
  fetch?: FetchLike;
  webSocketFactory?: WebSocketFactory;
  restBase?: string;
  wsUrl?: string;
  now?: () => number;
}

export class BybitSource implements DataSource {
  readonly id = 'bybit';
  readonly name = 'Bybit';
  readonly timeframes: readonly TimeframeId[] = ['1m', '5m', '15m', '1h', '4h', '1D', '1W'];
  readonly markets = ['crypto'] as const;
  readonly freshness = 'live' as const;

  private readonly fetchFn: FetchLike;
  private readonly wsFactory: WebSocketFactory;
  private readonly restBase: string;
  private readonly wsUrl: string;
  private readonly limiter: RateLimiter;

  constructor(options: BybitOptions = {}) {
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.wsFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.restBase = options.restBase ?? 'https://api.bybit.com';
    this.wsUrl = options.wsUrl ?? 'wss://stream.bybit.com/v5/public/spot';
    this.limiter = new RateLimiter({ now: options.now });
  }

  private get(path: string): Promise<unknown> {
    return requestJson({ url: `${this.restBase}${path}`, provider: 'Bybit', fetch: this.fetchFn, limiter: this.limiter, classify: classifyBybit });
  }

  async listSymbols(): Promise<SymbolMeta[]> {
    return parseBybitInstruments(await this.get('/v5/market/instruments-info?category=spot'));
  }

  async getSymbol(symbol: string): Promise<SymbolMeta | null> {
    try {
      const json = await this.get(`/v5/market/instruments-info?category=spot&symbol=${encodeURIComponent(symbol.toUpperCase())}`);
      return parseBybitInstruments(json)[0] ?? null;
    } catch {
      return null;
    }
  }

  async fetchCandles(symbol: string, timeframe: TimeframeId, options: FetchCandlesOptions = {}): Promise<Candle[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 500, BYBIT_MAX_LIMIT));
    const params = new URLSearchParams({ category: 'spot', symbol: symbol.toUpperCase(), interval: bybitInterval(timeframe), limit: String(limit) });
    // `end` is inclusive on the bar start time.
    if (options.before !== undefined) params.set('end', String(options.before - 1));
    const json = (await this.get(`/v5/market/kline?${params.toString()}`)) as { result?: { list?: unknown[] } };
    const list = json?.result?.list;
    if (!Array.isArray(list)) throw new Error('Unexpected kline payload from Bybit');
    const before = options.before;
    return list
      .map(parseBybitKline)
      .filter((c) => before === undefined || c.time < before)
      .sort((a, b) => a.time - b.time);
  }

  subscribe(symbol: string, timeframe: TimeframeId, onCandle: (candle: Candle) => void, options: SubscribeOptions = {}): () => void {
    const topic = `kline.${bybitInterval(timeframe)}.${symbol.toUpperCase()}`;
    return openManagedSocket({
      url: this.wsUrl,
      factory: this.wsFactory,
      onStatus: options.onStatus,
      // Bybit closes connections that stay quiet for more than about 30 s.
      heartbeat: { intervalMs: 20_000, message: JSON.stringify({ op: 'ping' }) },
      onOpen: (ws) => ws.send(JSON.stringify({ op: 'subscribe', args: [topic] })),
      onMessage: (data) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          return;
        }
        for (const candle of parseBybitStream(parsed, topic)) onCandle(candle);
      },
    });
  }
}
