import { aggregateCandles } from './coinbase';
import { type TimeframeId } from './timeframes';
import { defaultWebSocketFactory, openManagedSocket } from './socket';
import { RateLimiter, TtlCache, missingKeyError, requestJson, type Problem } from './http';
import { keyStore, type KeyValues } from './keys';
import { applyTick, dayStartInZone, sessionLookback, startPolling, type Tick } from './live';
import { searchSymbols } from './search';
import type {
  Candle,
  DataSource,
  FetchCandlesOptions,
  FetchLike,
  SourceAuth,
  StreamStatus,
  SubscribeOptions,
  SymbolMeta,
  WebSocketFactory,
  WebSocketLike,
} from './types';

/**
 * Alpaca market data: US stocks and ETFs with the user's own key pair. The free plan uses the
 * IEX exchange feed, which is live but covers only trades on IEX, so volume is lower than the
 * consolidated tape.
 */

const NEW_YORK = 'America/New_York';

const TIMEFRAMES: Record<TimeframeId, string> = {
  '1m': '1Min',
  '5m': '5Min',
  '15m': '15Min',
  '1h': '1Hour',
  '4h': '4Hour',
  '1D': '1Day',
  // Built from daily bars so weeks start on Monday like everywhere else in the app.
  '1W': '1Day',
};

export const ALPACA_MAX_LIMIT = 10_000;
/** Earliest IEX history Alpaca serves. */
const HISTORY_START = Date.UTC(2016, 0, 1);

export function alpacaTimeframe(timeframe: TimeframeId): string {
  return TIMEFRAMES[timeframe];
}

interface AlpacaBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** Bars from /v2/stocks/{symbol}/bars. Daily bars are moved to UTC midnight of the trading date. */
export function parseAlpacaBars(json: unknown, timeframe: TimeframeId): Candle[] {
  const bars = (json as { bars?: AlpacaBar[] | null })?.bars;
  if (bars === null) return [];
  if (!Array.isArray(bars)) throw new Error('Unexpected bars payload from Alpaca');
  const daily = timeframe === '1D' || timeframe === '1W';
  const out: Candle[] = [];
  for (const b of bars) {
    const t = Date.parse(b.t);
    const candle: Candle = { time: daily ? dayStartInZone(t, NEW_YORK) : t, open: Number(b.o), high: Number(b.h), low: Number(b.l), close: Number(b.c), volume: Number(b.v) };
    if (Object.values(candle).every(Number.isFinite)) out.push(candle);
  }
  return out.sort((a, b) => a.time - b.time);
}

/** Alpaca errors: 401 with an HTML body, otherwise JSON { message } or { code, message }. */
export function classifyAlpaca(status: number, body: unknown): Problem | null {
  if (status < 400) return null;
  const message = (body as { message?: string } | null)?.message;
  if (status === 429) return { kind: 'rate' };
  if (status === 401) return { kind: 'auth', message: 'Alpaca rejected the key pair. Check the key ID and secret in Data sources.' };
  if (status === 403) {
    if (message && /subscription|permit/i.test(message)) return { kind: 'plan', message: `Alpaca: ${message}` };
    return { kind: 'auth', message: 'Alpaca refused the key pair. Check the key ID and secret in Data sources.' };
  }
  if (status === 422 || status === 404) return { kind: 'not-found', message: `Alpaca: ${message ?? 'unknown symbol'}` };
  return null;
}

interface AlpacaAsset {
  symbol: string;
  name?: string;
  exchange?: string;
  status?: string;
  tradable?: boolean;
}

export function parseAlpacaAssets(json: unknown): SymbolMeta[] {
  if (!Array.isArray(json)) throw new Error('Unexpected assets payload from Alpaca');
  return (json as AlpacaAsset[])
    .filter((a) => a && typeof a.symbol === 'string' && a.status !== 'inactive' && a.exchange !== 'OTC' && a.exchange !== 'CRYPTO')
    .map((a) => ({
      symbol: a.symbol,
      base: a.symbol,
      quote: 'USD',
      pricePrecision: 2,
      volumePrecision: 0,
      market: /\bETF\b|\bETN\b/i.test(a.name ?? '') ? ('etf' as const) : ('stock' as const),
      name: a.name,
      exchange: a.exchange,
    }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export const ALPACA_POPULAR: readonly SymbolMeta[] = [
  ...['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AMD', 'NFLX'].map((s) => ({ symbol: s, base: s, quote: 'USD', pricePrecision: 2, volumePrecision: 0, market: 'stock' as const })),
  ...['SPY', 'QQQ', 'IWM', 'DIA'].map((s) => ({ symbol: s, base: s, quote: 'USD', pricePrecision: 2, volumePrecision: 0, market: 'etf' as const })),
];

// ---------------------------------------------------------------- shared live stream

interface StreamSub {
  symbol: string;
  onTrade: (tick: Tick) => void;
  onStatus: (status: StreamStatus) => void;
  /** The stream cannot serve this subscription. `canPoll` is false when the key itself was refused. */
  onFail: (message: string, canPoll: boolean) => void;
}

const STREAM_ERRORS: Record<number, string> = {
  402: 'Alpaca rejected the key pair for live data. Check it in Data sources.',
  406: 'Alpaca allows one live connection per key on the free plan. Another tab or app is using it, so this chart updates once a minute.',
  409: 'Your Alpaca plan does not include this live feed, so this chart updates once a minute.',
};

/**
 * The free plan allows a single websocket per key, so every chart shares one connection and
 * subscribes its own symbols on it.
 */
export class AlpacaStream {
  private readonly subs = new Set<StreamSub>();
  private stop: (() => void) | null = null;
  private ws: WebSocketLike | null = null;
  private authed = false;
  private failed: { message: string; canPoll: boolean } | null = null;

  constructor(
    private readonly url: string,
    private readonly key: KeyValues,
    private readonly factory: WebSocketFactory,
  ) {}

  matches(key: KeyValues): boolean {
    return key.keyId === this.key.keyId && key.secretKey === this.key.secretKey;
  }

  add(sub: StreamSub): () => void {
    if (this.failed) {
      sub.onFail(this.failed.message, this.failed.canPoll);
      return () => undefined;
    }
    this.subs.add(sub);
    if (!this.stop) this.connect();
    else if (this.authed) {
      this.send({ action: 'subscribe', trades: [sub.symbol] });
      sub.onStatus('live');
    }
    return () => {
      if (!this.subs.delete(sub)) return;
      if (![...this.subs].some((s) => s.symbol === sub.symbol) && this.authed) this.send({ action: 'unsubscribe', trades: [sub.symbol] });
      if (this.subs.size === 0) this.close();
    };
  }

  private symbols(): string[] {
    return [...new Set([...this.subs].map((s) => s.symbol))];
  }

  private send(message: unknown): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(message));
  }

  private connect(): void {
    this.stop = openManagedSocket({
      url: this.url,
      factory: this.factory,
      onStatus: (status) => {
        if (status !== 'live') {
          this.authed = false;
          for (const s of this.subs) s.onStatus(status);
        }
      },
      onOpen: (ws) => {
        this.ws = ws;
        // Credentials go in the first message, never in the URL.
        ws.send(JSON.stringify({ action: 'auth', key: this.key.keyId, secret: this.key.secretKey }));
      },
      onMessage: (data) => {
        let items: Array<{ T?: string; msg?: string; code?: number; S?: string; p?: number; s?: number; t?: string }>;
        try {
          const parsed = JSON.parse(data);
          items = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          return;
        }
        for (const item of items) {
          if (item.T === 'success' && item.msg === 'authenticated') {
            this.authed = true;
            const symbols = this.symbols();
            if (symbols.length) this.send({ action: 'subscribe', trades: symbols });
            for (const s of this.subs) s.onStatus('live');
          } else if (item.T === 'error') {
            this.fail(STREAM_ERRORS[item.code ?? 0] ?? `Alpaca live data: ${item.msg ?? 'error'}`, item.code);
            return;
          } else if (item.T === 't' && item.S) {
            const tick: Tick = { price: Number(item.p), size: Number(item.s ?? 0), time: item.t ? Date.parse(item.t) : Date.now() };
            if (!Number.isFinite(tick.price) || !Number.isFinite(tick.time)) continue;
            for (const s of this.subs) if (s.symbol === item.S) s.onTrade(tick);
          }
        }
      },
    });
  }

  private fail(message: string, code?: number): void {
    // Errors about one symbol leave the connection usable; the rest end it.
    if (code !== 402 && code !== 406 && code !== 409 && code !== 404) return;
    this.failed = { message, canPoll: code !== 402 };
    const subs = [...this.subs];
    this.close();
    for (const s of subs) s.onFail(message, code !== 402);
  }

  close(): void {
    this.subs.clear();
    this.authed = false;
    const stop = this.stop;
    this.stop = null;
    this.ws = null;
    stop?.();
  }
}

// ---------------------------------------------------------------- source

export interface AlpacaOptions {
  fetch?: FetchLike;
  webSocketFactory?: WebSocketFactory;
  dataBase?: string;
  /** Trading API hosts used for the asset list, paper first. */
  tradingBases?: string[];
  wsUrl?: string;
  keys?: () => KeyValues | null;
  now?: () => number;
  pollMs?: number;
}

export class AlpacaSource implements DataSource {
  readonly id = 'alpaca';
  readonly name = 'Alpaca';
  readonly timeframes: readonly TimeframeId[] = ['1m', '5m', '15m', '1h', '4h', '1D', '1W'];
  readonly markets = ['stock', 'etf'] as const;
  readonly freshness = 'live' as const;
  readonly note = 'Free plan: IEX exchange feed, so volume covers IEX trades only.';
  readonly auth: SourceAuth = {
    fields: [
      { id: 'keyId', label: 'API key ID', placeholder: 'PK...' },
      { id: 'secretKey', label: 'Secret key', secret: true, placeholder: 'Paste your secret key' },
    ],
    signupUrl: 'https://app.alpaca.markets/signup',
    plan: 'Free plan: US stocks and ETFs from the IEX feed, live, 200 requests a minute. A paper trading account is enough.',
  };

  private readonly fetchFn: FetchLike;
  private readonly wsFactory: WebSocketFactory;
  private readonly dataBase: string;
  private readonly tradingBases: string[];
  private readonly wsUrl: string;
  private readonly keys: () => KeyValues | null;
  private readonly now: () => number;
  private readonly pollMs: number;
  private readonly limiter: RateLimiter;
  private readonly cache: TtlCache<unknown>;
  private assets: Promise<SymbolMeta[]> | null = null;
  private stream: AlpacaStream | null = null;

  constructor(options: AlpacaOptions = {}) {
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.wsFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.dataBase = options.dataBase ?? 'https://data.alpaca.markets';
    this.tradingBases = options.tradingBases ?? ['https://paper-api.alpaca.markets', 'https://api.alpaca.markets'];
    this.wsUrl = options.wsUrl ?? 'wss://stream.data.alpaca.markets/v2/iex';
    this.keys = options.keys ?? (() => keyStore().get(this.id));
    this.now = options.now ?? Date.now;
    this.pollMs = options.pollMs ?? 60_000;
    this.limiter = new RateLimiter({ perMinute: 200, now: this.now });
    this.cache = new TtlCache(30_000, 50, this.now);
  }

  private credentials(): KeyValues {
    const k = this.keys();
    if (!k?.keyId || !k?.secretKey) throw missingKeyError(this.name);
    return k;
  }

  private get(url: string): Promise<unknown> {
    const k = this.credentials();
    return requestJson({
      url,
      provider: this.name,
      fetch: this.fetchFn,
      // Keys travel in headers to Alpaca's own hosts only.
      headers: { 'APCA-API-KEY-ID': k.keyId, 'APCA-API-SECRET-KEY': k.secretKey },
      limiter: this.limiter,
      cache: this.cache,
      cacheKey: `${k.keyId}:${url}`,
      classify: classifyAlpaca,
    });
  }

  async listSymbols(): Promise<SymbolMeta[]> {
    return [...ALPACA_POPULAR];
  }

  /** The asset list comes from the trading API (paper accounts work), once per session. */
  private loadAssets(): Promise<SymbolMeta[]> {
    this.assets ??= (async () => {
      let lastError: unknown;
      for (const base of this.tradingBases) {
        try {
          return parseAlpacaAssets(await this.get(`${base}/v2/assets?status=active&asset_class=us_equity`));
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError;
    })().catch((error: unknown) => {
      this.assets = null;
      throw error;
    });
    return this.assets;
  }

  async search(query: string): Promise<SymbolMeta[]> {
    const q = query.trim();
    if (!q) return [...ALPACA_POPULAR];
    try {
      const all = await this.loadAssets();
      return searchSymbols(all, q, 50);
    } catch (error) {
      // Without the asset list, still let people open a ticker they typed.
      if (/^[A-Za-z.]{1,6}$/.test(q)) return [{ symbol: q.toUpperCase(), base: q.toUpperCase(), quote: 'USD', pricePrecision: 2, volumePrecision: 0, market: 'stock' }];
      throw error;
    }
  }

  async getSymbol(symbol: string): Promise<SymbolMeta | null> {
    const popular = ALPACA_POPULAR.find((s) => s.symbol === symbol);
    if (popular) return popular;
    if (this.assets) {
      const found = (await this.assets.catch(() => [])).find((s) => s.symbol === symbol);
      if (found) return found;
    }
    return { symbol, base: symbol, quote: 'USD', pricePrecision: 2, volumePrecision: 0, market: 'stock' };
  }

  async testConnection(): Promise<string> {
    await this.get(`${this.dataBase}/v2/stocks/AAPL/bars/latest?feed=iex`);
    return 'Key works (IEX feed).';
  }

  private async page(symbol: string, timeframe: TimeframeId, start: number, end: number | undefined, limit: number): Promise<Candle[]> {
    const params = new URLSearchParams({
      timeframe: alpacaTimeframe(timeframe),
      start: new Date(start).toISOString(),
      limit: String(limit),
      sort: 'desc',
      feed: 'iex',
      adjustment: 'split',
    });
    if (end !== undefined) params.set('end', new Date(end).toISOString());
    const json = await this.get(`${this.dataBase}/v2/stocks/${encodeURIComponent(symbol)}/bars?${params.toString()}`);
    return parseAlpacaBars(json, timeframe);
  }

  async fetchCandles(symbol: string, timeframe: TimeframeId, options: FetchCandlesOptions = {}): Promise<Candle[]> {
    const bars = Math.max(1, Math.min(options.limit ?? 500, 2000));
    const weekly = timeframe === '1W';
    const limit = Math.min(ALPACA_MAX_LIMIT, weekly ? bars * 5 : bars);
    // `end` is inclusive, so stop one second short of the exclusive cursor.
    const end = options.before !== undefined ? options.before - 1000 : undefined;
    const reference = end ?? this.now();
    const start = Math.max(HISTORY_START, reference - sessionLookback(timeframe, bars));
    if (end !== undefined && end <= HISTORY_START) return [];
    let candles = await this.page(symbol, timeframe, start, end, limit);
    // A quiet stock can have no bars in the window; look all the way back once before giving up.
    if (candles.length === 0 && start > HISTORY_START) candles = await this.page(symbol, timeframe, HISTORY_START, end, limit);
    if (weekly) candles = aggregateCandles(candles, '1W');
    const before = options.before;
    if (before !== undefined) candles = candles.filter((c) => c.time < before);
    return candles.slice(-bars);
  }

  subscribe(symbol: string, timeframe: TimeframeId, onCandle: (candle: Candle) => void, options: SubscribeOptions = {}): () => void {
    let key: KeyValues;
    try {
      key = this.credentials();
    } catch (error) {
      options.onError?.((error as Error).message);
      options.onStatus?.('closed');
      return () => undefined;
    }
    let current: Candle | null = options.seed ? { ...options.seed } : null;
    let stopPoll: (() => void) | null = null;
    let removed = false;

    if (!this.stream || !this.stream.matches(key)) {
      this.stream?.close();
      this.stream = new AlpacaStream(this.wsUrl, key, this.wsFactory);
    }
    const remove = this.stream.add({
      symbol: symbol.toUpperCase(),
      onTrade: (tick) => {
        current = applyTick(current, timeframe, tick, NEW_YORK);
        onCandle({ ...current });
      },
      onStatus: (status) => {
        if (!stopPoll) options.onStatus?.(status);
      },
      onFail: (message, canPoll) => {
        if (removed || stopPoll) return;
        options.onError?.(message);
        if (!canPoll) {
          options.onStatus?.('closed');
          return;
        }
        stopPoll = startPolling({
          intervalMs: this.pollMs,
          poll: () => this.fetchCandles(symbol, timeframe, { limit: 2 }),
          onCandle,
          onStatus: options.onStatus,
          onError: options.onError,
        });
      },
    });

    return () => {
      removed = true;
      remove();
      stopPoll?.();
      options.onStatus?.('closed');
    };
  }
}
