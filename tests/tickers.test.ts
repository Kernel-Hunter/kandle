import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BYBIT_TOPICS_PER_REQUEST,
  binanceTickerFeed,
  bybitTickerFeed,
  coinbaseTickerFeed,
  computeChange,
  krakenTickerFeed,
  okxTickerFeed,
  parseBinanceTickers,
  parseBybitTickers,
  parseCoinbaseSnapshot,
  parseCoinbaseTicker,
  parseKrakenTickers,
  parseOkxTickers,
  type Ticker,
} from '../src/data/tickers';
import { fakeFetch, fakeSockets } from './helpers';

// Payloads recorded from the public endpoints on 2026-10-20 (trimmed to the fields that matter
// plus a few others, so parsers are shown to ignore what they do not use).

const BINANCE_MINI = {
  stream: 'btcusdt@miniTicker',
  data: { e: '24hrMiniTicker', E: 1792514872016, s: 'BTCUSDT', c: '82770.70000000', o: '81973.58000000', h: '83439.00000000', l: '81200.00000000', v: '13742.92025000', q: '1127713086.44093500' },
};
const BINANCE_REST = [
  { symbol: 'BTCUSDT', priceChange: '637.90000000', priceChangePercent: '0.778', lastPrice: '82608.34000000', openPrice: '81970.44000000', highPrice: '83439.00000000', lowPrice: '81200.00000000', openTime: 1792428431006, closeTime: 1792514831006 },
  { symbol: 'ETHUSDT', priceChange: '43.86000000', priceChangePercent: '1.827', lastPrice: '2445.01000000', openPrice: '2401.15000000', highPrice: '2478.00000000', lowPrice: '2372.62000000', openTime: 1792428431011, closeTime: 1792514831011 },
];
const COINBASE_TICKER = {
  type: 'ticker', sequence: 138046258721, product_id: 'BTC-USD', price: '82669.1', open_24h: '81893.31', volume_24h: '5115.17405954', low_24h: '81080.64', high_24h: '83344.25',
  best_bid: '82661.73', best_ask: '82669.10', side: 'buy', time: '2026-10-20T16:47:51.510393Z', trade_id: 1108476879, last_size: '0.00058779',
};
const COINBASE_REST_TICKER = { ask: '82704.78', bid: '82704.77', volume: '5126.1', trade_id: 1108490000, price: '82704.77', size: '0.001', time: '2026-10-20T17:17:22.211702660Z' };
const COINBASE_STATS = { open: '81826.75', high: '83344.25', low: '81080.64', last: '82735.67', volume: '5084.34683989', volume_30day: '165260.94129772' };
const BYBIT_PUSH = {
  topic: 'tickers.BTCUSDT', ts: 1792514871276, type: 'snapshot', cs: 115805065879,
  data: { symbol: 'BTCUSDT', lastPrice: '82761.1', highPrice24h: '83446.1', lowPrice24h: '81183.9', prevPrice24h: '81972.8', volume24h: '11397.659132', turnover24h: '934328026.57458825', price24hPcnt: '0.0096', usdIndexPrice: '82665.325928' },
};
const BYBIT_REST = {
  retCode: 0, retMsg: 'OK', time: 1792514832516,
  result: { category: 'spot', list: [{ symbol: 'BTCUSDT', bid1Price: '82604.3', ask1Price: '82604.4', lastPrice: '82604.3', prevPrice24h: '81972.8', price24hPcnt: '0.0077', highPrice24h: '83446.1', lowPrice24h: '81183.9' }] },
};
// The tickers channel carries the same rows as GET /api/v5/market/ticker, wrapped in `arg`.
const OKX_ROW = { instType: 'SPOT', instId: 'BTC-USDT', last: '82775.1', lastSz: '0.01629999', askPx: '82775.2', bidPx: '82775.1', open24h: '81960', high24h: '83439.9', low24h: '81200', ts: '1792514862369', sodUtc0: '81941.9', sodUtc8: '82610.4' };
const OKX_PUSH = { arg: { channel: 'tickers', instId: 'BTC-USDT' }, data: [OKX_ROW] };
const OKX_REST = { code: '0', msg: '', data: [OKX_ROW] };
const KRAKEN_SNAPSHOT = {
  channel: 'ticker', type: 'snapshot',
  data: [{ symbol: 'ETH/USD', bid: 2450.03, bid_qty: 12.80930878, ask: 2450.04, ask_qty: 25.65825379, last: 2450.03, volume: 23916.77083377, vwap: 2412.35, low: 2370.41, high: 2475.0, change: 51.99, change_pct: 2.17, trades: 48699, timestamp: '2026-10-20T16:47:54.899338Z' }],
};

describe('computeChange', () => {
  it('measures against the reference price', () => {
    expect(computeChange(110, 100)).toEqual({ change: 10, percent: 10 });
    const down = computeChange(95, 100);
    expect(down.change).toBe(-5);
    expect(down.percent).toBeCloseTo(-5, 12);
    expect(computeChange(5, 0)).toEqual({ change: 5, percent: null });
  });

  it('matches the percent Binance reports', () => {
    const [btc, eth] = parseBinanceTickers(BINANCE_REST);
    expect(computeChange(btc.price, btc.reference).percent!.toFixed(3)).toBe('0.778');
    expect(computeChange(eth.price, eth.reference).percent!.toFixed(3)).toBe('1.827');
  });
});

describe('ticker parsers', () => {
  it('reads Binance miniTicker events, their envelope and REST rows', () => {
    expect(parseBinanceTickers(BINANCE_MINI)).toEqual([{ symbol: 'BTCUSDT', price: 82770.7, reference: 81973.58, time: 1792514872016 }]);
    expect(parseBinanceTickers(BINANCE_MINI.data)).toHaveLength(1);
    expect(parseBinanceTickers(BINANCE_REST).map((t) => [t.symbol, t.price, t.reference])).toEqual([
      ['BTCUSDT', 82608.34, 81970.44],
      ['ETHUSDT', 2445.01, 2401.15],
    ]);
    expect(parseBinanceTickers({ result: null, id: 1 })).toEqual([]);
    expect(parseBinanceTickers({ e: '24hrMiniTicker', s: 'X', c: 'abc', o: '1', E: 1 })).toEqual([]);
  });

  it('reads Coinbase ticker messages and the REST snapshot', () => {
    expect(parseCoinbaseTicker(COINBASE_TICKER)).toEqual([{ symbol: 'BTC-USD', price: 82669.1, reference: 81893.31, time: Date.parse('2026-10-20T16:47:51.510393Z') }]);
    expect(parseCoinbaseTicker({ type: 'subscriptions', channels: [] })).toEqual([]);
    expect(parseCoinbaseTicker({ ...COINBASE_TICKER, open_24h: undefined })).toEqual([]);
    // The stats `last` lags, so the price comes from /ticker and only the open from /stats.
    expect(parseCoinbaseSnapshot('BTC-USD', COINBASE_REST_TICKER, COINBASE_STATS)).toEqual({ symbol: 'BTC-USD', price: 82704.77, reference: 81826.75, time: Date.parse('2026-10-20T17:17:22.211Z') });
    expect(parseCoinbaseSnapshot('BTC-USD', null, COINBASE_STATS)).toBeNull();
  });

  it('reads Bybit pushes and REST lists, computing the change from prevPrice24h', () => {
    const [t] = parseBybitTickers(BYBIT_PUSH);
    expect(t).toEqual({ symbol: 'BTCUSDT', price: 82761.1, reference: 81972.8, time: 1792514871276 });
    // Bybit rounds price24hPcnt to 0.0096; the exact figure is 0.9617 %.
    expect(computeChange(t.price, t.reference).percent!.toFixed(4)).toBe('0.9617');
    expect(parseBybitTickers(BYBIT_REST)).toEqual([{ symbol: 'BTCUSDT', price: 82604.3, reference: 81972.8, time: 1792514832516 }]);
    expect(parseBybitTickers({ success: true, op: 'subscribe' })).toEqual([]);
    expect(parseBybitTickers({ topic: 'kline.1.BTCUSDT', data: BYBIT_PUSH.data })).toEqual([]);
  });

  it('reads OKX pushes and REST rows using open24h', () => {
    const expected = [{ symbol: 'BTC-USDT', price: 82775.1, reference: 81960, time: 1792514862369 }];
    expect(parseOkxTickers(OKX_PUSH)).toEqual(expected);
    expect(parseOkxTickers(OKX_REST)).toEqual(expected);
    expect(parseOkxTickers({ event: 'subscribe', arg: { channel: 'tickers', instId: 'BTC-USDT' } })).toEqual([]);
    expect(parseOkxTickers({ arg: { channel: 'candle1H', instId: 'BTC-USDT' }, data: [OKX_ROW] })).toEqual([]);
    expect(parseOkxTickers({ code: '51001', msg: 'not found', data: [] })).toEqual([]);
  });

  it('reads Kraken v2 tickers, deriving the reference from the 24 h change', () => {
    const [t] = parseKrakenTickers(KRAKEN_SNAPSHOT);
    expect(t.symbol).toBe('ETH/USD');
    expect(t.price).toBe(2450.03);
    expect(t.reference).toBeCloseTo(2398.04, 8);
    expect(computeChange(t.price, t.reference).percent!.toFixed(2)).toBe('2.17');
    expect(parseKrakenTickers({ channel: 'heartbeat' })).toEqual([]);
  });
});

describe('ticker feeds', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('Binance uses one combined stream and batches the REST snapshot for symbols it has not covered', async () => {
    const ws = fakeSockets();
    const http = fakeFetch(() => ({ body: [BINANCE_REST[1]] }));
    const got: Ticker[] = [];
    const stop = binanceTickerFeed({ webSocketFactory: ws.factory, fetch: http.fetch }).watch(['BTCUSDT', 'ETHUSDT', 'bad symbol'], (t) => got.push(t));
    expect(ws.sockets).toHaveLength(1);
    expect(ws.last().url).toBe('wss://data-stream.binance.vision/stream?streams=btcusdt@miniTicker/ethusdt@miniTicker');
    ws.last().open();
    ws.last().receive(BINANCE_MINI);
    ws.last().receive({ ...BINANCE_MINI, data: { ...BINANCE_MINI.data, s: 'DOGEUSDT' } });
    await vi.advanceTimersByTimeAsync(2600);
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0].pathname).toBe('/api/v3/ticker/24hr');
    expect(JSON.parse(http.calls[0].searchParams.get('symbols')!)).toEqual(['ETHUSDT']);
    expect(got.map((t) => t.symbol)).toEqual(['BTCUSDT', 'ETHUSDT']);
    stop();
    expect(ws.last().closed).toBe(true);
    ws.last().receive(BINANCE_MINI);
    expect(got).toHaveLength(2);
  });

  it('skips the snapshot when the stream covered every symbol, and never opens a socket for an empty list', async () => {
    const ws = fakeSockets();
    const http = fakeFetch(() => ({ body: [] }));
    const feed = binanceTickerFeed({ webSocketFactory: ws.factory, fetch: http.fetch });
    feed.watch([], () => undefined)();
    expect(ws.sockets).toHaveLength(0);
    const stop = feed.watch(['BTCUSDT'], () => undefined);
    ws.last().open();
    ws.last().receive(BINANCE_MINI);
    await vi.advanceTimersByTimeAsync(3000);
    expect(http.calls).toHaveLength(0);
    stop();
  });

  it('Coinbase subscribes every product in one message and resubscribes after a reconnect', () => {
    const ws = fakeSockets();
    const got: Ticker[] = [];
    const stop = coinbaseTickerFeed({ webSocketFactory: ws.factory, fetch: fakeFetch(() => ({ body: {} })).fetch }).watch(['BTC-USD', 'ETH-USD'], (t) => got.push(t));
    ws.last().open();
    expect(ws.last().messages()).toEqual([{ type: 'subscribe', product_ids: ['BTC-USD', 'ETH-USD'], channels: ['ticker'] }]);
    ws.last().receive(COINBASE_TICKER);
    expect(got[0].price).toBe(82669.1);
    ws.last().drop();
    vi.advanceTimersByTime(600);
    expect(ws.sockets).toHaveLength(2);
    ws.last().open();
    expect(ws.last().messages()).toHaveLength(1);
    stop();
  });

  it('Bybit splits subscriptions into groups of 10 topics', () => {
    const ws = fakeSockets();
    const symbols = Array.from({ length: 12 }, (_, i) => `COIN${i}USDT`);
    const stop = bybitTickerFeed({ webSocketFactory: ws.factory }).watch(symbols, () => undefined);
    ws.last().open();
    const sent = ws.last().messages() as Array<{ op: string; args: string[] }>;
    expect(sent.map((m) => m.args.length)).toEqual([BYBIT_TOPICS_PER_REQUEST, 2]);
    expect(sent[0].args[0]).toBe('tickers.COIN0USDT');
    stop();
  });

  it('OKX subscribes the tickers channel on the public endpoint', () => {
    const ws = fakeSockets();
    const got: Ticker[] = [];
    const stop = okxTickerFeed({ webSocketFactory: ws.factory }).watch(['BTC-USDT'], (t) => got.push(t));
    expect(ws.last().url).toBe('wss://ws.okx.com:8443/ws/v5/public');
    ws.last().open();
    expect(ws.last().messages()).toEqual([{ op: 'subscribe', args: [{ channel: 'tickers', instId: 'BTC-USDT' }] }]);
    ws.last().receive('pong');
    ws.last().receive(OKX_PUSH);
    expect(got).toHaveLength(1);
    stop();
  });

  it('Kraken maps REST pair names to websocket names and back', async () => {
    const ws = fakeSockets();
    const got: Ticker[] = [];
    const names: Record<string, string> = { ETHUSD: 'ETH/USD', XBTUSD: 'BTC/USD' };
    const stop = krakenTickerFeed(async (s) => names[s], { webSocketFactory: ws.factory }).watch(['ETHUSD', 'XBTUSD'], (t) => got.push(t));
    await vi.advanceTimersByTimeAsync(0);
    ws.last().open();
    expect(ws.last().messages()).toEqual([{ method: 'subscribe', params: { channel: 'ticker', symbol: ['ETH/USD', 'BTC/USD'], snapshot: true } }]);
    ws.last().receive(KRAKEN_SNAPSHOT);
    expect(got.map((t) => t.symbol)).toEqual(['ETHUSD']);
    stop();
    expect(ws.last().closed).toBe(true);
  });

  it('Kraken opens nothing when stopped before the names resolve', async () => {
    const ws = fakeSockets();
    const stop = krakenTickerFeed(async (s) => s, { webSocketFactory: ws.factory }).watch(['XBTUSD'], () => undefined);
    stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(ws.sockets).toHaveLength(0);
  });
});
