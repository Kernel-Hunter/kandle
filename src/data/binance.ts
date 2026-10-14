import { precisionFromIncrement, type TimeframeId } from './timeframes';
import { defaultWebSocketFactory, openManagedSocket } from './socket';
import type {
  Candle,
  DataSource,
  FetchCandlesOptions,
  FetchLike,
  SubscribeOptions,
  SymbolMeta,
  WebSocketFactory,
} from './types';

const INTERVALS: Record<TimeframeId, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1h',
  '4h': '4h',
  '1D': '1d',
  '1W': '1w',
};

export const BINANCE_MAX_LIMIT = 1000;

export function binanceInterval(timeframe: TimeframeId): string {
  return INTERVALS[timeframe];
}

/** Parses one row of GET /api/v3/klines: [openTime, open, high, low, close, volume, closeTime, ...]. */
export function parseBinanceKline(row: unknown): Candle {
  if (!Array.isArray(row) || row.length < 6) {
    throw new Error('Unexpected kline row from Binance');
  }
  const candle: Candle = {
    time: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  };
  if (Object.values(candle).some((v) => !Number.isFinite(v))) {
    throw new Error('Kline row from Binance contains non-numeric values');
  }
  return candle;
}

/** Parses a websocket kline event ({ e: 'kline', k: {...} }). Returns null for other messages. */
export function parseBinanceStreamKline(message: unknown): Candle | null {
  if (!message || typeof message !== 'object') return null;
  const msg = message as { e?: string; k?: Record<string, unknown>; data?: unknown };
  if (msg.data) return parseBinanceStreamKline(msg.data);
  if (msg.e !== 'kline' || !msg.k) return null;
  const k = msg.k;
  const candle: Candle = {
    time: Number(k.t),
    open: Number(k.o),
    high: Number(k.h),
    low: Number(k.l),
    close: Number(k.c),
    volume: Number(k.v),
  };
  return Object.values(candle).every(Number.isFinite) ? candle : null;
}

interface BinanceFilter {
  filterType: string;
  tickSize?: string;
  stepSize?: string;
}

interface BinanceSymbolInfo {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  isSpotTradingAllowed?: boolean;
  filters?: BinanceFilter[];
}

export function parseBinanceExchangeInfo(json: unknown): SymbolMeta[] {
  const symbols = (json as { symbols?: BinanceSymbolInfo[] })?.symbols;
  if (!Array.isArray(symbols)) throw new Error('Unexpected exchangeInfo payload from Binance');
  return symbols
    .filter((s) => s.status === 'TRADING' && s.isSpotTradingAllowed !== false)
    .map((s) => {
      const price = s.filters?.find((f) => f.filterType === 'PRICE_FILTER')?.tickSize;
      const lot = s.filters?.find((f) => f.filterType === 'LOT_SIZE')?.stepSize;
      return {
        symbol: s.symbol,
        base: s.baseAsset,
        quote: s.quoteAsset,
        pricePrecision: price ? precisionFromIncrement(price) : 2,
        volumePrecision: lot ? precisionFromIncrement(lot) : 2,
      };
    });
}

export interface BinanceOptions {
  fetch?: FetchLike;
  webSocketFactory?: WebSocketFactory;
  /** REST hosts, tried in order. The market-data mirror works in more regions than the main host. */
  restBases?: string[];
  wsBase?: string;
}

export class BinanceSource implements DataSource {
  readonly id = 'binance';
  readonly name = 'Binance';
  readonly timeframes: readonly TimeframeId[] = ['1m', '5m', '15m', '1h', '4h', '1D', '1W'];

  private readonly fetchFn: FetchLike;
  private readonly wsFactory: WebSocketFactory;
  private readonly restBases: string[];
  private readonly wsBase: string;

  constructor(options: BinanceOptions = {}) {
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.wsFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.restBases = options.restBases ?? ['https://data-api.binance.vision', 'https://api.binance.com'];
    this.wsBase = options.wsBase ?? 'wss://data-stream.binance.vision/ws';
  }

  private async getJson(path: string): Promise<unknown> {
    let lastError: unknown;
    for (const base of this.restBases) {
      try {
        const res = await this.fetchFn(`${base}${path}`);
        if (!res.ok) throw new Error(`Binance responded ${res.status}`);
        return await res.json();
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Binance request failed');
  }

  async listSymbols(): Promise<SymbolMeta[]> {
    const json = await this.getJson('/api/v3/exchangeInfo?permissions=SPOT&symbolStatus=TRADING');
    return parseBinanceExchangeInfo(json);
  }

  async getSymbol(symbol: string): Promise<SymbolMeta | null> {
    try {
      const json = await this.getJson(`/api/v3/exchangeInfo?symbol=${encodeURIComponent(symbol.toUpperCase())}`);
      return parseBinanceExchangeInfo(json)[0] ?? null;
    } catch {
      return null;
    }
  }

  async fetchCandles(symbol: string, timeframe: TimeframeId, options: FetchCandlesOptions = {}): Promise<Candle[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 500, BINANCE_MAX_LIMIT));
    const params = new URLSearchParams({
      symbol: symbol.toUpperCase(),
      interval: binanceInterval(timeframe),
      limit: String(limit),
    });
    if (options.before !== undefined) {
      // endTime is inclusive on the bar open time, so step back one millisecond.
      params.set('endTime', String(options.before - 1));
    }
    const json = await this.getJson(`/api/v3/klines?${params.toString()}`);
    if (!Array.isArray(json)) throw new Error('Unexpected klines payload from Binance');
    const candles = json.map(parseBinanceKline);
    const before = options.before;
    return candles
      .filter((c) => before === undefined || c.time < before)
      .sort((a, b) => a.time - b.time);
  }

  subscribe(
    symbol: string,
    timeframe: TimeframeId,
    onCandle: (candle: Candle) => void,
    options: SubscribeOptions = {},
  ): () => void {
    const stream = `${symbol.toLowerCase()}@kline_${binanceInterval(timeframe)}`;
    return openManagedSocket({
      url: `${this.wsBase}/${stream}`,
      factory: this.wsFactory,
      onStatus: options.onStatus,
      onMessage: (data) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          return;
        }
        const candle = parseBinanceStreamKline(parsed);
        if (candle) onCandle(candle);
      },
    });
  }
}
