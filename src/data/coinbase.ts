import { bucketStart, getTimeframe, precisionFromIncrement, type TimeframeId } from './timeframes';
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

/** Coinbase returns at most 300 bars per candles request. */
export const COINBASE_MAX_BARS = 300;

const SECOND = 1000;

/**
 * Coinbase only serves 1m, 5m, 15m, 1h, 6h and 1d bars. 4h and 1W are built here
 * by aggregating 1h and 1d bars.
 */
interface Granularity {
  /** Native Coinbase granularity in seconds. */
  native: number;
  /** How many native bars fit in one requested bar. */
  factor: number;
}

const GRANULARITY: Record<TimeframeId, Granularity> = {
  '1m': { native: 60, factor: 1 },
  '5m': { native: 300, factor: 1 },
  '15m': { native: 900, factor: 1 },
  '1h': { native: 3600, factor: 1 },
  '4h': { native: 3600, factor: 4 },
  '1D': { native: 86400, factor: 1 },
  '1W': { native: 86400, factor: 7 },
};

/** Parses one row of GET /products/{id}/candles: [time (s), low, high, open, close, volume]. */
export function parseCoinbaseCandle(row: unknown): Candle {
  if (!Array.isArray(row) || row.length < 6) {
    throw new Error('Unexpected candle row from Coinbase');
  }
  const candle: Candle = {
    time: Number(row[0]) * SECOND,
    low: Number(row[1]),
    high: Number(row[2]),
    open: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  };
  if (Object.values(candle).some((v) => !Number.isFinite(v))) {
    throw new Error('Candle row from Coinbase contains non-numeric values');
  }
  return candle;
}

/** Groups ascending bars into larger bars (e.g. 1h into 4h). Input does not need to be gap free. */
export function aggregateCandles(candles: Candle[], timeframe: TimeframeId): Candle[] {
  const out: Candle[] = [];
  for (const c of candles) {
    const start = bucketStart(timeframe, c.time);
    const last = out[out.length - 1];
    if (last && last.time === start) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume += c.volume;
    } else {
      out.push({ ...c, time: start });
    }
  }
  return out;
}

interface CoinbaseProduct {
  id: string;
  base_currency: string;
  quote_currency: string;
  quote_increment?: string;
  base_increment?: string;
  status?: string;
  trading_disabled?: boolean;
}

export function parseCoinbaseProducts(json: unknown): SymbolMeta[] {
  if (!Array.isArray(json)) throw new Error('Unexpected products payload from Coinbase');
  return (json as CoinbaseProduct[])
    .filter((p) => p.status === 'online' && !p.trading_disabled)
    .map((p) => ({
      symbol: p.id,
      base: p.base_currency,
      quote: p.quote_currency,
      pricePrecision: p.quote_increment ? precisionFromIncrement(p.quote_increment) : 2,
      volumePrecision: p.base_increment ? precisionFromIncrement(p.base_increment) : 4,
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/**
 * Works out the time window for one page of history. `before` is exclusive and is moved to a
 * bar boundary so aggregated bars never get split across two pages.
 */
export function coinbasePageWindow(
  timeframe: TimeframeId,
  before: number | undefined,
  limit: number,
  now: number = Date.now(),
): { start: number; end: number; bars: number } {
  const { native, factor } = GRANULARITY[timeframe];
  const barMs = getTimeframe(timeframe)!.ms;
  const maxBars = Math.max(1, Math.floor(COINBASE_MAX_BARS / factor));
  const bars = Math.max(1, Math.min(limit, maxBars));
  // Exclusive upper bound: either the requested cursor or the end of the bar in progress.
  const end = before !== undefined ? bucketStart(timeframe, before) : bucketStart(timeframe, now) + barMs;
  const start = end - bars * factor * native * SECOND;
  return { start, end, bars };
}

export interface CoinbaseOptions {
  fetch?: FetchLike;
  webSocketFactory?: WebSocketFactory;
  restBase?: string;
  wsUrl?: string;
  now?: () => number;
}

export class CoinbaseSource implements DataSource {
  readonly id = 'coinbase';
  readonly name = 'Coinbase';
  readonly timeframes: readonly TimeframeId[] = ['1m', '5m', '15m', '1h', '4h', '1D', '1W'];

  private readonly fetchFn: FetchLike;
  private readonly wsFactory: WebSocketFactory;
  private readonly restBase: string;
  private readonly wsUrl: string;
  private readonly now: () => number;

  constructor(options: CoinbaseOptions = {}) {
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.wsFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.restBase = options.restBase ?? 'https://api.exchange.coinbase.com';
    this.wsUrl = options.wsUrl ?? 'wss://ws-feed.exchange.coinbase.com';
    this.now = options.now ?? Date.now;
  }

  private async getJson(path: string): Promise<unknown> {
    const res = await this.fetchFn(`${this.restBase}${path}`);
    if (!res.ok) throw new Error(`Coinbase responded ${res.status}`);
    return res.json();
  }

  async listSymbols(): Promise<SymbolMeta[]> {
    return parseCoinbaseProducts(await this.getJson('/products'));
  }

  async getSymbol(symbol: string): Promise<SymbolMeta | null> {
    try {
      const json = await this.getJson(`/products/${encodeURIComponent(symbol)}`);
      return parseCoinbaseProducts([json])[0] ?? null;
    } catch {
      return null;
    }
  }

  async fetchCandles(symbol: string, timeframe: TimeframeId, options: FetchCandlesOptions = {}): Promise<Candle[]> {
    const { native, factor } = GRANULARITY[timeframe];
    const { start, end } = coinbasePageWindow(timeframe, options.before, options.limit ?? COINBASE_MAX_BARS, this.now());
    const params = new URLSearchParams({
      granularity: String(native),
      start: new Date(start).toISOString(),
      // Coinbase treats `end` as inclusive, so stop one second short of the exclusive bound.
      end: new Date(end - SECOND).toISOString(),
    });
    const json = await this.getJson(`/products/${encodeURIComponent(symbol)}/candles?${params.toString()}`);
    if (!Array.isArray(json)) throw new Error('Unexpected candles payload from Coinbase');
    const rows = json
      .map(parseCoinbaseCandle)
      .filter((c) => c.time >= start && c.time < end)
      .sort((a, b) => a.time - b.time);
    return factor > 1 ? aggregateCandles(rows, timeframe) : rows;
  }

  subscribe(
    symbol: string,
    timeframe: TimeframeId,
    onCandle: (candle: Candle) => void,
    options: SubscribeOptions = {},
  ): () => void {
    let current: Candle | null = options.seed ? { ...options.seed } : null;
    return openManagedSocket({
      url: this.wsUrl,
      factory: this.wsFactory,
      onStatus: options.onStatus,
      onOpen: (ws) => {
        ws.send(JSON.stringify({ type: 'subscribe', product_ids: [symbol], channels: ['ticker'] }));
      },
      onMessage: (data) => {
        let msg: { type?: string; price?: string; last_size?: string; time?: string; product_id?: string };
        try {
          msg = JSON.parse(data);
        } catch {
          return;
        }
        if (msg.type !== 'ticker' || msg.product_id !== symbol) return;
        const tick = {
          price: Number(msg.price),
          size: Number(msg.last_size ?? 0),
          time: msg.time ? Date.parse(msg.time) : this.now(),
        };
        if (!Number.isFinite(tick.price) || !Number.isFinite(tick.time)) return;
        current = applyTrade(current, timeframe, tick);
        onCandle({ ...current });
      },
    });
  }
}

/** Folds one trade into the bar in progress, starting a new bar when the trade crosses a boundary. */
export function applyTrade(
  current: Candle | null,
  timeframe: TimeframeId,
  trade: { price: number; size: number; time: number },
): Candle {
  const start = bucketStart(timeframe, trade.time);
  if (!current || start > current.time) {
    return { time: start, open: trade.price, high: trade.price, low: trade.price, close: trade.price, volume: trade.size };
  }
  if (start < current.time) return current; // late trade for a closed bar
  return {
    ...current,
    high: Math.max(current.high, trade.price),
    low: Math.min(current.low, trade.price),
    close: trade.price,
    volume: current.volume + (Number.isFinite(trade.size) ? trade.size : 0),
  };
}
