import { defaultWebSocketFactory, openManagedSocket } from './socket';
import type { FetchLike, StreamStatus, WebSocketFactory, WebSocketLike } from './types';

/**
 * Last price and 24 hour change for many symbols at once, for the watchlist. Each keyless
 * exchange streams every symbol over one websocket. A symbol the stream has not covered after
 * a short wait gets one REST snapshot, batched where the exchange allows it.
 */

/** A price and the price its change is measured from. */
export interface Ticker {
  symbol: string;
  price: number;
  /** For crypto exchanges the price 24 hours ago (the open of the rolling 24 h window). */
  reference: number;
  /** Exchange time of the update, ms. */
  time: number;
}

export interface Change {
  change: number;
  /** null when the reference is 0. */
  percent: number | null;
}

export function computeChange(price: number, reference: number): Change {
  const change = price - reference;
  return { change, percent: reference !== 0 ? (change / reference) * 100 : null };
}

const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN);

function ticker(symbol: unknown, price: unknown, reference: unknown, time: unknown): Ticker | null {
  if (typeof symbol !== 'string' || !symbol) return null;
  const t: Ticker = { symbol, price: num(price), reference: num(reference), time: num(time) };
  return Number.isFinite(t.price) && Number.isFinite(t.reference) && Number.isFinite(t.time) ? t : null;
}

// ---------------------------------------------------------------- parsers

/**
 * Binance 24 h tickers: a miniTicker stream event (`o` is the open of the rolling window), the
 * combined-stream envelope around it, or a row of GET /api/v3/ticker/24hr.
 */
export function parseBinanceTickers(message: unknown): Ticker[] {
  if (Array.isArray(message)) return message.flatMap(parseBinanceTickers);
  if (!message || typeof message !== 'object') return [];
  const m = message as Record<string, unknown>;
  if (m.data && typeof m.data === 'object') return parseBinanceTickers(m.data);
  if (m.e === '24hrMiniTicker' || m.e === '24hrTicker') {
    const t = ticker(m.s, m.c, m.o, m.E);
    return t ? [t] : [];
  }
  if (typeof m.symbol === 'string' && 'lastPrice' in m) {
    const t = ticker(m.symbol, m.lastPrice, m.openPrice, m.closeTime);
    return t ? [t] : [];
  }
  return [];
}

/** A Coinbase `ticker` channel message; `open_24h` is the price 24 hours ago. */
export function parseCoinbaseTicker(message: unknown): Ticker[] {
  const m = message as Record<string, unknown> | null;
  if (!m || m.type !== 'ticker') return [];
  const t = ticker(m.product_id, m.price, m.open_24h, typeof m.time === 'string' ? Date.parse(m.time) : Number.NaN);
  return t ? [t] : [];
}

/**
 * Coinbase REST snapshot: GET /products/{id}/ticker for the last trade and GET /products/{id}/stats
 * for the open 24 hours ago. The `last` field of stats lags the market by up to a minute, so it is
 * not used.
 */
export function parseCoinbaseSnapshot(symbol: string, tickerJson: unknown, statsJson: unknown): Ticker | null {
  const t = tickerJson as Record<string, unknown> | null;
  const s = statsJson as Record<string, unknown> | null;
  if (!t || !s || typeof t !== 'object' || typeof s !== 'object') return null;
  return ticker(symbol, t.price, s.open, typeof t.time === 'string' ? Date.parse(t.time) : Number.NaN);
}

/**
 * Bybit spot tickers: a `tickers.SYMBOL` stream push or GET /v5/market/tickers. `prevPrice24h`
 * is the price 24 hours ago; `price24hPcnt` is rounded to 0.01 %, so the change is worked out here.
 */
export function parseBybitTickers(message: unknown, fallbackTime = Date.now()): Ticker[] {
  const m = message as { topic?: string; ts?: number; data?: unknown; result?: { list?: unknown[] }; time?: number } | null;
  if (!m || typeof m !== 'object') return [];
  const rows = Array.isArray(m.result?.list) ? m.result.list : typeof m.topic === 'string' && m.topic.startsWith('tickers.') ? [m.data] : [];
  const time = num(m.ts ?? m.time);
  const out: Ticker[] = [];
  for (const row of rows) {
    const r = row as Record<string, unknown> | null;
    const t = r && ticker(r.symbol, r.lastPrice, r.prevPrice24h, Number.isFinite(time) ? time : fallbackTime);
    if (t) out.push(t);
  }
  return out;
}

/** OKX tickers, from the `tickers` channel or GET /api/v5/market/ticker(s). `open24h` is the price 24 hours ago. */
export function parseOkxTickers(message: unknown): Ticker[] {
  const m = message as { arg?: { channel?: string }; data?: unknown[]; event?: string; code?: string } | null;
  if (!m || typeof m !== 'object' || m.event || !Array.isArray(m.data)) return [];
  if (m.arg && m.arg.channel !== 'tickers') return [];
  if (!m.arg && m.code !== undefined && m.code !== '0') return [];
  const out: Ticker[] = [];
  for (const row of m.data) {
    const r = row as Record<string, unknown> | null;
    const t = r && ticker(r.instId, r.last, r.open24h, r.ts);
    if (t) out.push(t);
  }
  return out;
}

/**
 * Kraken v2 `ticker` channel (snapshot and update). `change` is the 24 hour change in the quote
 * currency, so the reference price is `last - change`. Symbols are websocket names like BTC/USD.
 */
export function parseKrakenTickers(message: unknown, now = Date.now()): Ticker[] {
  const m = message as { channel?: string; data?: unknown[] } | null;
  if (!m || m.channel !== 'ticker' || !Array.isArray(m.data)) return [];
  const out: Ticker[] = [];
  for (const row of m.data) {
    const r = row as Record<string, unknown> | null;
    if (!r) continue;
    const last = num(r.last);
    const change = num(r.change);
    const time = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : now;
    const t = ticker(r.symbol, last, last - change, Number.isFinite(time) ? time : now);
    if (t) out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------- feeds

export interface TickerFeed {
  /** Streams tickers for `symbols` until the returned function is called. */
  watch(symbols: readonly string[], onTicker: (t: Ticker) => void, onStatus?: (status: StreamStatus) => void): () => void;
}

export interface TickerFeedOptions {
  fetch?: FetchLike;
  webSocketFactory?: WebSocketFactory;
  now?: () => number;
  /** How long the stream gets to cover a symbol before a REST snapshot is asked for. */
  snapshotDelayMs?: number;
}

interface StreamSpec {
  url: string;
  subscribe?: (ws: WebSocketLike) => void;
  heartbeat?: { intervalMs: number; message: string };
  parse: (message: unknown) => Ticker[];
  /** One REST request (or a few) for symbols the stream has not covered yet. */
  snapshot?: (symbols: string[]) => Promise<Ticker[]>;
}

function runStream(spec: StreamSpec, symbols: readonly string[], options: TickerFeedOptions, onTicker: (t: Ticker) => void, onStatus?: (s: StreamStatus) => void): () => void {
  if (symbols.length === 0) return () => undefined;
  const wanted = new Set(symbols);
  const seen = new Set<string>();
  let stopped = false;
  const deliver = (t: Ticker) => {
    if (stopped || !wanted.has(t.symbol)) return;
    seen.add(t.symbol);
    onTicker(t);
  };
  const stopSocket = openManagedSocket({
    url: spec.url,
    factory: options.webSocketFactory ?? defaultWebSocketFactory,
    heartbeat: spec.heartbeat,
    onStatus: (s) => !stopped && onStatus?.(s),
    onOpen: (ws) => spec.subscribe?.(ws),
    onMessage: (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      for (const t of spec.parse(parsed)) deliver(t);
    },
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (spec.snapshot) {
    const snapshot = spec.snapshot;
    timer = setTimeout(() => {
      timer = null;
      const missing = symbols.filter((s) => !seen.has(s));
      if (stopped || missing.length === 0) return;
      snapshot(missing).then(
        (list) => {
          // A stream update that arrived meanwhile is newer than the snapshot.
          for (const t of list) if (!seen.has(t.symbol)) deliver(t);
        },
        () => undefined,
      );
    }, options.snapshotDelayMs ?? 2500);
  }
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    stopSocket();
  };
}

async function getJson(fetchFn: FetchLike, url: string): Promise<unknown> {
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`${new URL(url).host} responded ${res.status}`);
  return res.json();
}

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

/** Spot symbols are plain letters and digits on Binance and Bybit. */
const PLAIN = /^[A-Z0-9]{2,30}$/;

/** Binance: one combined miniTicker stream for every symbol, REST snapshot batched in one request. */
export function binanceTickerFeed(options: TickerFeedOptions = {}): TickerFeed {
  const fetchFn = options.fetch ?? defaultFetch;
  return {
    watch(symbols, onTicker, onStatus) {
      const list = symbols.filter((s) => PLAIN.test(s));
      const streams = list.map((s) => `${s.toLowerCase()}@miniTicker`).join('/');
      return runStream(
        {
          url: `wss://data-stream.binance.vision/stream?streams=${streams}`,
          parse: parseBinanceTickers,
          // type=MINI drops fields the watchlist does not use. Weight is 2 per symbol up to 20.
          snapshot: async (missing) =>
            parseBinanceTickers(await getJson(fetchFn, `https://data-api.binance.vision/api/v3/ticker/24hr?type=MINI&symbols=${encodeURIComponent(JSON.stringify(missing))}`)),
        },
        list,
        options,
        onTicker,
        onStatus,
      );
    },
  };
}

/** Coinbase: one `ticker` subscription for every product, REST requests one product at a time for the rest. */
export function coinbaseTickerFeed(options: TickerFeedOptions = {}): TickerFeed {
  const fetchFn = options.fetch ?? defaultFetch;
  return {
    watch(symbols, onTicker, onStatus) {
      const list = symbols.filter((s) => /^[A-Z0-9]{1,15}-[A-Z0-9]{1,15}$/.test(s));
      return runStream(
        {
          url: 'wss://ws-feed.exchange.coinbase.com',
          subscribe: (ws) => ws.send(JSON.stringify({ type: 'subscribe', product_ids: list, channels: ['ticker'] })),
          parse: parseCoinbaseTicker,
          snapshot: async (missing) => {
            const out: Ticker[] = [];
            // Sequential, well inside Coinbase's 10 public requests a second.
            for (const s of missing) {
              const base = `https://api.exchange.coinbase.com/products/${encodeURIComponent(s)}`;
              const [last, stats] = await Promise.all([getJson(fetchFn, `${base}/ticker`).catch(() => null), getJson(fetchFn, `${base}/stats`).catch(() => null)]);
              const t = parseCoinbaseSnapshot(s, last, stats);
              if (t) out.push(t);
            }
            return out;
          },
        },
        list,
        options,
        onTicker,
        onStatus,
      );
    },
  };
}

/** Bybit allows 10 topics per subscribe request on spot. */
export const BYBIT_TOPICS_PER_REQUEST = 10;

export function bybitTickerFeed(options: TickerFeedOptions = {}): TickerFeed {
  const fetchFn = options.fetch ?? defaultFetch;
  const now = options.now ?? Date.now;
  return {
    watch(symbols, onTicker, onStatus) {
      const list = symbols.filter((s) => PLAIN.test(s));
      return runStream(
        {
          url: 'wss://stream.bybit.com/v5/public/spot',
          heartbeat: { intervalMs: 20_000, message: JSON.stringify({ op: 'ping' }) },
          subscribe: (ws) => {
            for (let i = 0; i < list.length; i += BYBIT_TOPICS_PER_REQUEST) {
              ws.send(JSON.stringify({ op: 'subscribe', args: list.slice(i, i + BYBIT_TOPICS_PER_REQUEST).map((s) => `tickers.${s}`) }));
            }
          },
          parse: (m) => parseBybitTickers(m, now()),
          // One request returns every spot ticker, cheaper than one per symbol.
          snapshot: async () => parseBybitTickers(await getJson(fetchFn, 'https://api.bybit.com/v5/market/tickers?category=spot'), now()),
        },
        list,
        options,
        onTicker,
        onStatus,
      );
    },
  };
}

export function okxTickerFeed(options: TickerFeedOptions = {}): TickerFeed {
  const fetchFn = options.fetch ?? defaultFetch;
  return {
    watch(symbols, onTicker, onStatus) {
      const list = symbols.filter((s) => /^[A-Z0-9]{1,15}-[A-Z0-9]{1,15}$/.test(s));
      return runStream(
        {
          // Tickers are on the public endpoint; candles use the business one.
          url: 'wss://ws.okx.com:8443/ws/v5/public',
          heartbeat: { intervalMs: 25_000, message: 'ping' },
          subscribe: (ws) => ws.send(JSON.stringify({ op: 'subscribe', args: list.map((instId) => ({ channel: 'tickers', instId })) })),
          parse: parseOkxTickers,
          snapshot: async () => parseOkxTickers(await getJson(fetchFn, 'https://www.okx.com/api/v5/market/tickers?instType=SPOT')),
        },
        list,
        options,
        onTicker,
        onStatus,
      );
    },
  };
}

/**
 * Kraken: the v2 ticker channel sends a snapshot on subscribe, so no REST call is needed (its
 * REST Ticker only has today's UTC open, which would measure a different change).
 * `wsSymbol` maps a REST pair name (XBTUSD) to its websocket name (BTC/USD).
 */
export function krakenTickerFeed(wsSymbol: (symbol: string) => Promise<string>, options: TickerFeedOptions = {}): TickerFeed {
  const now = options.now ?? Date.now;
  return {
    watch(symbols, onTicker, onStatus) {
      let stop: (() => void) | null = null;
      let cancelled = false;
      void Promise.all(symbols.map((s) => wsSymbol(s).then((ws) => [ws, s] as const, () => [s, s] as const))).then((pairs) => {
        if (cancelled) return;
        const back = new Map(pairs);
        stop = runStream(
          {
            url: 'wss://ws.kraken.com/v2',
            subscribe: (ws) => ws.send(JSON.stringify({ method: 'subscribe', params: { channel: 'ticker', symbol: [...back.keys()], snapshot: true } })),
            parse: (m) =>
              parseKrakenTickers(m, now()).flatMap((t) => {
                const symbol = back.get(t.symbol);
                return symbol ? [{ ...t, symbol }] : [];
              }),
          },
          symbols,
          options,
          onTicker,
          onStatus,
        );
      });
      return () => {
        cancelled = true;
        stop?.();
      };
    },
  };
}
