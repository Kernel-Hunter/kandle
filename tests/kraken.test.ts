import { describe, expect, it } from 'vitest';
import {
  KrakenSource,
  classifyKraken,
  krakenAssetName,
  krakenWsSymbol,
  parseKrakenOhlc,
  parseKrakenPairs,
  parseKrakenStream,
} from '../src/data/kraken';
import { fakeFetch, fakeSockets } from './helpers';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// 2026-10-12 is a Monday.
const MONDAY = Date.UTC(2026, 9, 12);

const row = (timeMs: number, close: number) => [timeMs / 1000, String(close - 1), String(close + 1), String(close - 2), String(close), String(close), '2.5', 10];

const ohlc = (rows: unknown[]) => ({ error: [], result: { XXBTZUSD: rows, last: 1792069200 } });

describe('Kraken parsing', () => {
  it('parses OHLC rows, taking volume from index 6 (index 5 is VWAP)', () => {
    expect(parseKrakenOhlc([1789477200, '76919.8', '77099.1', '76094.4', '76575.8', '76558.4', '371.41168638', 9564])).toEqual({
      time: 1789477200000,
      open: 76919.8,
      high: 77099.1,
      low: 76094.4,
      close: 76575.8,
      volume: 371.41168638,
    });
  });

  it('maps XBT and XDG to BTC and DOGE for display and the v2 websocket', () => {
    expect(krakenAssetName('XBT')).toBe('BTC');
    expect(krakenWsSymbol('XDG/USD')).toBe('DOGE/USD');
  });

  it('lists online pairs and skips dark pool pairs', () => {
    const json = {
      error: [],
      result: {
        XXBTZUSD: { altname: 'XBTUSD', wsname: 'XBT/USD', base: 'XXBT', quote: 'ZUSD', pair_decimals: 1, lot_decimals: 8, status: 'online' },
        'XXBTZUSD.d': { altname: 'XBTUSD.d', wsname: 'XBT/USD', base: 'XXBT', quote: 'ZUSD', pair_decimals: 1, lot_decimals: 8 },
        HALTEDUSD: { altname: 'HALTEDUSD', wsname: 'HALT/USD', base: 'HALT', quote: 'ZUSD', status: 'cancel_only' },
      },
    };
    expect(parseKrakenPairs(json)).toEqual([{ symbol: 'XBTUSD', base: 'BTC', quote: 'USD', pricePrecision: 1, volumePrecision: 8, market: 'crypto' }]);
  });

  it('classifies errors from the error array', () => {
    expect(classifyKraken(200, { error: ['EQuery:Unknown asset pair'] })?.kind).toBe('not-found');
    expect(classifyKraken(200, { error: ['EGeneral:Too many requests'] })?.kind).toBe('rate');
    expect(classifyKraken(200, { error: [], result: {} })).toBeNull();
  });

  it('reads v2 ohlc pushes for the right symbol and interval', () => {
    const msg = {
      channel: 'ohlc',
      type: 'update',
      data: [
        { symbol: 'BTC/USD', open: 1, high: 2, low: 0.5, close: 1.5, volume: 3, interval_begin: '2026-10-15T13:36:00.000000000Z', interval: 1 },
        { symbol: 'ETH/USD', open: 1, high: 2, low: 0.5, close: 1.5, volume: 3, interval_begin: '2026-10-15T13:36:00.000000000Z', interval: 1 },
      ],
    };
    expect(parseKrakenStream(msg, 'BTC/USD', 1)).toEqual([{ time: Date.UTC(2026, 9, 15, 13, 36), open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 }]);
    expect(parseKrakenStream(msg, 'BTC/USD', 5)).toEqual([]);
    expect(parseKrakenStream({ channel: 'heartbeat' }, 'BTC/USD', 1)).toEqual([]);
  });
});

describe('KrakenSource', () => {
  it('serves the latest bars, then older ones from the same response, then no more', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(MONDAY + i * HOUR, 100 + i));
    const { fetch, calls } = fakeFetch(() => ({ body: ohlc(rows) }));
    const source = new KrakenSource({ fetch });
    const first = await source.fetchCandles('XBTUSD', '1h', { limit: 4 });
    expect(first.map((c) => c.close)).toEqual([106, 107, 108, 109]);
    expect(Object.fromEntries(calls[0].searchParams)).toEqual({ pair: 'XBTUSD', interval: '60' });

    const older = await source.fetchCandles('XBTUSD', '1h', { before: first[0].time, limit: 4 });
    expect(older.map((c) => c.close)).toEqual([102, 103, 104, 105]);
    const rest = await source.fetchCandles('XBTUSD', '1h', { before: older[0].time, limit: 4 });
    expect(rest.map((c) => c.close)).toEqual([100, 101]);
    expect(await source.fetchCandles('XBTUSD', '1h', { before: rest[0].time })).toEqual([]);
    // Paging reused the first response.
    expect(calls).toHaveLength(1);
  });

  it('builds Monday weeks from daily bars', async () => {
    const days = [-1, 0, 1, 2].map((i) => row(MONDAY + i * DAY, 10 + i));
    const { fetch, calls } = fakeFetch(() => ({ body: ohlc(days) }));
    const weeks = await new KrakenSource({ fetch }).fetchCandles('XBTUSD', '1W');
    expect(calls[0].searchParams.get('interval')).toBe('1440');
    expect(weeks.map((c) => c.time)).toEqual([MONDAY - 7 * DAY, MONDAY]);
    expect(weeks[1]).toMatchObject({ open: 9, close: 12, volume: 7.5 });
  });

  it('reports an unknown pair', async () => {
    const { fetch } = fakeFetch(() => ({ body: { error: ['EQuery:Unknown asset pair'] } }));
    await expect(new KrakenSource({ fetch }).fetchCandles('NOPEUSD', '1h')).rejects.toThrow('Kraken does not list this pair.');
  });

  it('subscribes with the v2 symbol and folds daily updates into the weekly bar', async () => {
    const { fetch } = fakeFetch(() => ({
      body: { error: [], result: { XXBTZUSD: { altname: 'XBTUSD', wsname: 'XBT/USD', base: 'XXBT', quote: 'ZUSD', status: 'online' } } },
    }));
    const { factory, last } = fakeSockets();
    const got: Array<{ time: number; open: number; close: number; volume: number }> = [];
    new KrakenSource({ fetch, webSocketFactory: factory }).subscribe('XBTUSD', '1W', (c) => got.push(c));
    await new Promise((r) => setTimeout(r, 0));
    last().open();
    expect(last().messages()).toEqual([{ method: 'subscribe', params: { channel: 'ohlc', symbol: ['BTC/USD'], interval: 1440, snapshot: true } }]);
    const day = (offset: number, open: number, close: number) => ({
      symbol: 'BTC/USD',
      open,
      high: Math.max(open, close),
      low: Math.min(open, close),
      close,
      volume: 1,
      interval_begin: new Date(MONDAY + offset * DAY).toISOString(),
      interval: 1440,
    });
    last().receive({ channel: 'ohlc', type: 'snapshot', data: [day(-1, 5, 6), day(0, 10, 11), day(1, 11, 12)] });
    const weekly = got[got.length - 1];
    expect(weekly).toMatchObject({ time: MONDAY, open: 10, close: 12, volume: 2 });
  });
});
