import { precisionFromIncrement, type TimeframeId } from './timeframes';
import { defaultWebSocketFactory, openManagedSocket } from './socket';
import { RateLimiter, requestJson, type Problem } from './http';
import type { Candle, DataSource, FetchCandlesOptions, FetchLike, SubscribeOptions, SymbolMeta, WebSocketFactory } from './types';

/** OKX spot market data (v5 public API). No key needed. */

const BARS: Record<TimeframeId, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1H',
  '4h': '4H',
  // The "utc" variants start days and weeks at 00:00 UTC like the other sources.
  '1D': '1Dutc',
  '1W': '1Wutc',
};

export const OKX_MAX_LIMIT = 300;

export function okxBar(timeframe: TimeframeId): string {
  return BARS[timeframe];
}

/** One candle row: [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm], all strings. */
export function parseOkxCandle(row: unknown): Candle {
  if (!Array.isArray(row) || row.length < 6) throw new Error('Unexpected candle row from OKX');
  const candle: Candle = {
    time: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  };
  if (!Object.values(candle).every(Number.isFinite)) throw new Error('Candle row from OKX contains non-numeric values');
  return candle;
}

/** A websocket push: { arg: { channel: 'candle1H', instId }, data: [[...row]] }. */
export function parseOkxStream(message: unknown, channel: string, instId: string): Candle[] {
  const msg = message as { arg?: { channel?: string; instId?: string }; data?: unknown[]; event?: string };
  if (!msg || msg.event || msg.arg?.channel !== channel || msg.arg?.instId !== instId || !Array.isArray(msg.data)) return [];
  const out: Candle[] = [];
  for (const row of msg.data) {
    try {
      out.push(parseOkxCandle(row));
    } catch {
      // Skip malformed rows.
    }
  }
  return out.sort((a, b) => a.time - b.time);
}

interface OkxInstrument {
  instId: string;
  baseCcy: string;
  quoteCcy: string;
  state: string;
  tickSz?: string;
  lotSz?: string;
}

export function parseOkxInstruments(json: unknown): SymbolMeta[] {
  const data = (json as { data?: OkxInstrument[] })?.data;
  if (!Array.isArray(data)) throw new Error('Unexpected instruments payload from OKX');
  return data
    .filter((s) => s.state === 'live')
    .map((s) => ({
      symbol: s.instId,
      base: s.baseCcy,
      quote: s.quoteCcy,
      pricePrecision: s.tickSz ? precisionFromIncrement(s.tickSz) : 2,
      volumePrecision: s.lotSz ? precisionFromIncrement(s.lotSz) : 4,
      market: 'crypto' as const,
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** OKX reports errors in `code` (a string, "0" is success). 50011 is its rate limit code. */
export function classifyOkx(status: number, body: unknown): Problem | null {
  if (status === 429) return { kind: 'rate' };
  const b = body as { code?: string; msg?: string } | null;
  if (b && typeof b.code === 'string' && b.code !== '0') {
    if (b.code === '50011') return { kind: 'rate' };
    if (b.code === '51001') return { kind: 'not-found', message: 'OKX does not list this symbol.' };
    return { kind: 'bad-request', message: `OKX: ${b.msg || `error ${b.code}`}` };
  }
  return null;
}

export interface OkxOptions {
  fetch?: FetchLike;
  webSocketFactory?: WebSocketFactory;
  restBase?: string;
  wsUrl?: string;
  now?: () => number;
}

export class OkxSource implements DataSource {
  readonly id = 'okx';
  readonly name = 'OKX';
  readonly timeframes: readonly TimeframeId[] = ['1m', '5m', '15m', '1h', '4h', '1D', '1W'];
  readonly markets = ['crypto'] as const;
  readonly freshness = 'live' as const;

  private readonly fetchFn: FetchLike;
  private readonly wsFactory: WebSocketFactory;
  private readonly restBase: string;
  private readonly wsUrl: string;
  private readonly limiter: RateLimiter;

  constructor(options: OkxOptions = {}) {
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.wsFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.restBase = options.restBase ?? 'https://www.okx.com';
    // Candle channels live on the "business" endpoint.
    this.wsUrl = options.wsUrl ?? 'wss://ws.okx.com:8443/ws/v5/business';
    this.limiter = new RateLimiter({ now: options.now });
  }

  private get(path: string): Promise<unknown> {
    return requestJson({ url: `${this.restBase}${path}`, provider: 'OKX', fetch: this.fetchFn, limiter: this.limiter, classify: classifyOkx });
  }

  async listSymbols(): Promise<SymbolMeta[]> {
    return parseOkxInstruments(await this.get('/api/v5/public/instruments?instType=SPOT'));
  }

  async getSymbol(symbol: string): Promise<SymbolMeta | null> {
    try {
      const json = await this.get(`/api/v5/public/instruments?instType=SPOT&instId=${encodeURIComponent(symbol.toUpperCase())}`);
      return parseOkxInstruments(json)[0] ?? null;
    } catch {
      return null;
    }
  }

  async fetchCandles(symbol: string, timeframe: TimeframeId, options: FetchCandlesOptions = {}): Promise<Candle[]> {
    const limit = Math.max(1, Math.min(options.limit ?? OKX_MAX_LIMIT, OKX_MAX_LIMIT));
    const params = new URLSearchParams({ instId: symbol.toUpperCase(), bar: okxBar(timeframe), limit: String(limit) });
    // /market/candles only keeps recent bars; older pages come from /market/history-candles.
    // In OKX terms `after` means "older than this timestamp", which is exactly `before` here.
    let path = '/api/v5/market/candles';
    if (options.before !== undefined) {
      params.set('after', String(options.before));
      path = '/api/v5/market/history-candles';
    }
    const json = (await this.get(`${path}?${params.toString()}`)) as { data?: unknown[] };
    if (!Array.isArray(json?.data)) throw new Error('Unexpected candles payload from OKX');
    const before = options.before;
    return json.data
      .map(parseOkxCandle)
      .filter((c) => before === undefined || c.time < before)
      .sort((a, b) => a.time - b.time);
  }

  subscribe(symbol: string, timeframe: TimeframeId, onCandle: (candle: Candle) => void, options: SubscribeOptions = {}): () => void {
    const channel = `candle${okxBar(timeframe)}`;
    const instId = symbol.toUpperCase();
    return openManagedSocket({
      url: this.wsUrl,
      factory: this.wsFactory,
      onStatus: options.onStatus,
      // OKX drops connections with no traffic for 30 s; it answers a plain "ping" with "pong".
      heartbeat: { intervalMs: 25_000, message: 'ping' },
      onOpen: (ws) => ws.send(JSON.stringify({ op: 'subscribe', args: [{ channel, instId }] })),
      onMessage: (data) => {
        if (data === 'pong') return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          return;
        }
        for (const candle of parseOkxStream(parsed, channel, instId)) onCandle(candle);
      },
    });
  }
}
