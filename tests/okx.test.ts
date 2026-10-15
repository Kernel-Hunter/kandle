import { describe, expect, it } from 'vitest';
import { OkxSource, classifyOkx, okxBar, parseOkxCandle, parseOkxInstruments, parseOkxStream } from '../src/data/okx';
import { RateLimitError } from '../src/data/http';
import { fakeFetch, fakeSockets } from './helpers';

// Captured from GET /api/v5/market/candles?instId=BTC-USDT&bar=1H&limit=3 (newest first).
const CANDLES = {
  code: '0',
  msg: '',
  data: [
    ['1792069200000', '80552.8', '80658.1', '80092.5', '80405', '337.77695056', '27148755.0', '27148755.0', '0'],
    ['1792065600000', '80984.4', '81174.6', '80538.7', '80552.8', '465.75508997', '37656060.1', '37656060.1', '1'],
    ['1792062000000', '81033', '81185.1', '80840.4', '80984.4', '300', '1', '1', '1'],
  ],
};

describe('OKX parsing', () => {
  it('parses candle rows', () => {
    expect(parseOkxCandle(CANDLES.data[0])).toEqual({ time: 1792069200000, open: 80552.8, high: 80658.1, low: 80092.5, close: 80405, volume: 337.77695056 });
  });

  it('uses UTC day and week bars', () => {
    expect(okxBar('1D')).toBe('1Dutc');
    expect(okxBar('1W')).toBe('1Wutc');
    expect(okxBar('4h')).toBe('4H');
  });

  it('keeps live instruments', () => {
    const json = {
      code: '0',
      data: [
        { instId: 'BTC-USDT', baseCcy: 'BTC', quoteCcy: 'USDT', state: 'live', tickSz: '0.1', lotSz: '0.00000001' },
        { instId: 'NEW-USDT', baseCcy: 'NEW', quoteCcy: 'USDT', state: 'preopen', tickSz: '0.1', lotSz: '1' },
      ],
    };
    expect(parseOkxInstruments(json)).toEqual([{ symbol: 'BTC-USDT', base: 'BTC', quote: 'USDT', pricePrecision: 1, volumePrecision: 8, market: 'crypto' }]);
  });

  it('reads pushes for its channel only and ignores events', () => {
    const push = { arg: { channel: 'candle1m', instId: 'BTC-USDT' }, data: [['1792071360000', '1', '2', '0.5', '1.5', '4', '0', '0', '0']] };
    expect(parseOkxStream(push, 'candle1m', 'BTC-USDT')).toHaveLength(1);
    expect(parseOkxStream(push, 'candle5m', 'BTC-USDT')).toEqual([]);
    expect(parseOkxStream({ event: 'subscribe', arg: push.arg }, 'candle1m', 'BTC-USDT')).toEqual([]);
  });

  it('classifies error codes', () => {
    expect(classifyOkx(200, { code: '50011', msg: 'Too Many Requests' })?.kind).toBe('rate');
    expect(classifyOkx(200, { code: '51001', data: [], msg: "Instrument ID doesn't exist." })?.kind).toBe('not-found');
    expect(classifyOkx(200, CANDLES)).toBeNull();
  });
});

describe('OkxSource', () => {
  it('loads recent bars, then pages through history-candles with after=before', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: CANDLES }));
    const source = new OkxSource({ fetch });
    const recent = await source.fetchCandles('btc-usdt', '1h', { limit: 1000 });
    expect(recent.map((c) => c.time)).toEqual([1792062000000, 1792065600000, 1792069200000]);
    expect(calls[0].pathname).toBe('/api/v5/market/candles');
    expect(calls[0].searchParams.get('limit')).toBe('300');
    expect(calls[0].searchParams.get('instId')).toBe('BTC-USDT');

    const older = await source.fetchCandles('BTC-USDT', '1h', { before: 1792065600000 });
    expect(calls[1].pathname).toBe('/api/v5/market/history-candles');
    expect(calls[1].searchParams.get('after')).toBe('1792065600000');
    expect(older.map((c) => c.time)).toEqual([1792062000000]);
  });

  it('surfaces rate limits with the retry message', async () => {
    const { fetch } = fakeFetch(() => ({ status: 429, body: { code: '50011', msg: 'Too Many Requests' } }));
    const err = await new OkxSource({ fetch, now: () => 0 }).fetchCandles('BTC-USDT', '1m').catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.message).toMatch(/^Free plan limit reached, try again in \d+ s$/);
  });

  it('subscribes on the business endpoint and answers keepalive', () => {
    const { factory, last } = fakeSockets();
    const got: number[] = [];
    new OkxSource({ webSocketFactory: factory }).subscribe('BTC-USDT', '1D', (c) => got.push(c.time));
    last().open();
    expect(last().url).toBe('wss://ws.okx.com:8443/ws/v5/business');
    expect(last().messages()).toEqual([{ op: 'subscribe', args: [{ channel: 'candle1Dutc', instId: 'BTC-USDT' }] }]);
    last().receive('pong');
    last().receive({ arg: { channel: 'candle1Dutc', instId: 'BTC-USDT' }, data: [['1792022400000', '1', '1', '1', '1', '1', '0', '0', '0']] });
    expect(got).toEqual([1792022400000]);
  });
});
