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

/** What kind of market a symbol trades in. Shown as a badge in symbol search. */
export type MarketType = 'crypto' | 'stock' | 'etf' | 'forex' | 'index';

export interface SymbolMeta {
  /** Identifier used by the exchange API, e.g. BTCUSDT or BTC-USD. */
  symbol: string;
  base: string;
  quote: string;
  pricePrecision: number;
  volumePrecision: number;
  /** Market type. Sources that only list one kind of market can leave it out. */
  market?: MarketType;
  /** Full instrument name, e.g. "Apple Inc", when the provider gives one. */
  name?: string;
  /** Listing venue, e.g. NASDAQ, when the provider gives one. */
  exchange?: string;
}

export interface FetchCandlesOptions {
  /** Only return bars whose open time is strictly before this timestamp (ms). */
  before?: number;
  /** Maximum number of bars to return. Adapters may clamp it to their API limit. */
  limit?: number;
}

/**
 * `polling`: updates come from repeated REST requests instead of a stream.
 * `delayed`: the provider's plan has no live updates (for example end-of-day data).
 */
export type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'closed' | 'polling' | 'delayed';

export interface SubscribeOptions {
  /** The most recent bar already on the chart. Trade-based feeds use it to keep volume continuous. */
  seed?: Candle;
  onStatus?: (status: StreamStatus) => void;
  /** A problem the user should see, such as a rejected API key or a plan limit. */
  onError?: (message: string) => void;
}

/** One credential field a provider needs, such as an API key or a secret. */
export interface KeyField {
  id: string;
  label: string;
  /** Rendered as a password field. */
  secret?: boolean;
  placeholder?: string;
}

/** How a source signs in, for sources that need the user's own key. */
export interface SourceAuth {
  fields: readonly KeyField[];
  /** Where the user gets a free key. */
  signupUrl: string;
  /** One line about the free plan, shown in the Data sources dialog. */
  plan: string;
}

/** How fresh the data is on the plan the app targets (the free plan for keyed sources). */
export type DataFreshness = 'live' | 'delayed' | 'end-of-day';

/**
 * A market data provider. Adding a new exchange means implementing this interface
 * and registering it in `sources.ts`.
 */
export interface DataSource {
  readonly id: string;
  readonly name: string;
  readonly timeframes: readonly TimeframeId[];
  /** Markets this source covers. Missing means crypto only. */
  readonly markets?: readonly MarketType[];
  /** Present when the source needs the user's own API key. */
  readonly auth?: SourceAuth;
  readonly freshness?: DataFreshness;
  /** Short note shown next to the source, e.g. history limits. */
  readonly note?: string;
  /** Full symbol list for local search. Sources with `search` may return a short popular list. */
  listSymbols(): Promise<SymbolMeta[]>;
  /** Provider-side search, for sources whose full list is too large or needs a key. */
  search?(query: string): Promise<SymbolMeta[]>;
  /** Checks that the saved key works. Resolves to a short success message, throws with the reason. */
  testConnection?(): Promise<string>;
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
