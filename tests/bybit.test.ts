import { describe, expect, it } from 'vitest';
import { BybitSource, classifyBybit, parseBybitInstruments, parseBybitKline, parseBybitStream } from '../src/data/bybit';
import { RateLimitError } from '../src/data/http';
import { fakeFetch, fakeSockets } from './helpers';

// Captured from GET /v5/market/kline?category=spot&symbol=BTCUSDT&interval=60&limit=3 (newest first).
const KLINE = {
  retCode: 0,
  retMsg: 'OK',
  result: {
    category: 'spot',
    symbol: 'BTCUSDT',
    list: [
      ['1792069200000', '80547.4', '80656.8', '80081.5', '80404', '353.791124', '28449737.45'],
      ['1792065600000', '80982.7', '81187.5', '80538', '80547.4', '644.67789', '52132546.93'],
      ['1792062000000', '81036.4', '81190.9', '80840.4', '80982.7', '410.2', '33200000.1'],
    ],
  },
};

const INSTRUMENTS = {
  retCode: 0,
  result: {
    list: [
      { symbol: 'BTCUSDT', baseCoin: 'BTC', quoteCoin: 'USDT', status: 'Trading', priceFilter: { tickSize: '0.1' }, lotSizeFilter: { basePrecision: '0.000001' } },
      { symbol: 'OLDUSDT', baseCoin: 'OLD', quoteCoin: 'USDT', status: 'Closed', priceFilter: { tickSize: '0.01' }, lotSizeFilter: { basePrecision: '0.01' } },
    ],
  },
};

describe('Bybit parsing', () => {
  it('parses kline rows', () => {
    expect(parseBybitKline(KLINE.result.list[0])).toEqual({ time: 1792069200000, open: 80547.4, high: 80656.8, low: 80081.5, close: 80404, volume: 353.791124 });
    expect(() => parseBybitKline(['1', 'x', '1', '1', '1', '1'])).toThrow();
  });

  it('keeps trading instruments with their precision', () => {
    expect(parseBybitInstruments(INSTRUMENTS)).toEqual([{ symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT', pricePrecision: 1, volumePrecision: 6, market: 'crypto' }]);
  });

  it('reads websocket pushes for its topic only', () => {
    const push = { topic: 'kline.60.BTCUSDT', type: 'snapshot', data: [{ start: 1792071360000, open: '1', high: '2', low: '0.5', close: '1.5', volume: '3', confirm: false }] };
    expect(parseBybitStream(push, 'kline.60.BTCUSDT')).toEqual([{ time: 1792071360000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 }]);
    expect(parseBybitStream(push, 'kline.1.BTCUSDT')).toEqual([]);
    expect(parseBybitStream({ op: 'pong' }, 'kline.60.BTCUSDT')).toEqual([]);
  });

  it('classifies retCode errors', () => {
    expect(classifyBybit(200, { retCode: 10006, retMsg: 'Too many visits' })?.kind).toBe('rate');
    expect(classifyBybit(200, { retCode: 10001, retMsg: 'Not supported symbols' })?.kind).toBe('not-found');
    expect(classifyBybit(403, null)?.message).toContain('region');
    expect(classifyBybit(200, KLINE)).toBeNull();
  });
});

describe('BybitSource', () => {
  it('requests history ascending and pages with an inclusive end', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: KLINE }));
    const source = new BybitSource({ fetch });
    const first = await source.fetchCandles('btcusdt', '1h', { limit: 3 });
    expect(first.map((c) => c.time)).toEqual([1792062000000, 1792065600000, 1792069200000]);
    expect(calls[0].pathname).toBe('/v5/market/kline');
    expect(Object.fromEntries(calls[0].searchParams)).toEqual({ category: 'spot', symbol: 'BTCUSDT', interval: '60', limit: '3' });

    const older = await source.fetchCandles('BTCUSDT', '1h', { before: 1792065600000 });
    expect(calls[1].searchParams.get('end')).toBe('1792065599999');
    expect(older.map((c) => c.time)).toEqual([1792062000000]);
  });

  it('clamps the limit and maps weekly bars', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { retCode: 0, result: { list: [] } } }));
    await new BybitSource({ fetch }).fetchCandles('BTCUSDT', '1W', { limit: 5000 });
    expect(calls[0].searchParams.get('limit')).toBe('1000');
    expect(calls[0].searchParams.get('interval')).toBe('W');
  });

  it('backs off after a rate limit response', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { retCode: 10006, retMsg: 'Too many visits!' } }));
    const source = new BybitSource({ fetch, now: () => 0 });
    await expect(source.fetchCandles('BTCUSDT', '1h')).rejects.toBeInstanceOf(RateLimitError);
    await expect(source.fetchCandles('BTCUSDT', '1h')).rejects.toThrow('Free plan limit reached');
    expect(calls).toHaveLength(1);
  });

  it('returns null from getSymbol for unknown symbols', async () => {
    const { fetch } = fakeFetch(() => ({ body: { retCode: 10001, retMsg: 'Not supported symbols', result: {} } }));
    expect(await new BybitSource({ fetch }).getSymbol('NOPE')).toBeNull();
  });

  it('subscribes to the kline topic and streams candles', () => {
    const { factory, last } = fakeSockets();
    const got: number[] = [];
    const stop = new BybitSource({ webSocketFactory: factory }).subscribe('BTCUSDT', '1m', (c) => got.push(c.close));
    last().open();
    expect(last().url).toBe('wss://stream.bybit.com/v5/public/spot');
    expect(last().messages()).toEqual([{ op: 'subscribe', args: ['kline.1.BTCUSDT'] }]);
    last().receive({ success: true, op: 'subscribe' });
    last().receive({ topic: 'kline.1.BTCUSDT', data: [{ start: 1, open: '1', high: '1', low: '1', close: '7', volume: '1' }] });
    expect(got).toEqual([7]);
    stop();
    expect(last().closed).toBe(true);
  });
});
