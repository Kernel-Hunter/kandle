import type { TimeframeId } from './timeframes';

/** One OHLCV bar. `time` is the bar open time in milliseconds since the epoch (UTC). */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SymbolMeta {
  /** Identifier used by the exchange API, e.g. BTCUSDT or BTC-USD. */
  symbol: string;
  base: string;
  quote: string;
  pricePrecision: number;
  volumePrecision: number;
}

export interface FetchCandlesOptions {
  /** Only return bars whose open time is strictly before this timestamp (ms). */
  before?: number;
  /** Maximum number of bars to return. Adapters may clamp it to their API limit. */
  limit?: number;
}

export type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'closed';

export interface SubscribeOptions {
  /** The most recent bar already on the chart. Trade-based feeds use it to keep volume continuous. */
  seed?: Candle;
  onStatus?: (status: StreamStatus) => void;
}

/**
 * A market data provider. Adding a new exchange means implementing this interface
 * and registering it in `sources.ts`.
 */
export interface DataSource {
  readonly id: string;
  readonly name: string;
  readonly timeframes: readonly TimeframeId[];
  listSymbols(): Promise<SymbolMeta[]>;
  /** Metadata for one symbol, cheaper than loading the whole list. */
  getSymbol(symbol: string): Promise<SymbolMeta | null>;
  /** Returns bars sorted by ascending time. An empty array means there is no older history. */
  fetchCandles(symbol: string, timeframe: TimeframeId, options?: FetchCandlesOptions): Promise<Candle[]>;
  /** Streams updates for the current (and following) bars. Returns an unsubscribe function. */
  subscribe(
    symbol: string,
    timeframe: TimeframeId,
    onCandle: (candle: Candle) => void,
    options?: SubscribeOptions,
  ): () => void;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((ev: Event) => unknown) | null;
  onmessage: ((ev: MessageEvent) => unknown) | null;
  onclose: ((ev: CloseEvent) => unknown) | null;
  onerror: ((ev: Event) => unknown) | null;
  send(data: string): void;
  close(): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;
