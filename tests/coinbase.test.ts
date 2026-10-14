import { describe, expect, it } from 'vitest';
import {
  CoinbaseSource,
  aggregateCandles,
  applyTrade,
  coinbasePageWindow,
  parseCoinbaseCandle,
  parseCoinbaseProducts,
} from '../src/data/coinbase';
import type { Candle } from '../src/data/types';
import { fakeFetch } from './helpers';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// 2026-10-12 is a Monday.
const MONDAY = Date.UTC(2026, 9, 12);

const bar = (time: number, o: number, h: number, l: number, c: number, v = 1): Candle => ({ time, open: o, high: h, low: l, close: c, volume: v });

describe('parseCoinbaseCandle', () => {
  it('maps [time, low, high, open, close, volume] and converts seconds to ms', () => {
    expect(parseCoinbaseCandle([1700000000, 95, 110, 100, 105, 7.5])).toEqual({
      time: 1700000000000,
      open: 100,
      high: 110,
      low: 95,
      close: 105,
      volume: 7.5,
    });
  });

  it('rejects malformed rows', () => {
    expect(() => parseCoinbaseCandle([1, 2])).toThrow();
    expect(() => parseCoinbaseCandle([1, 2, 3, 'x', 5, 6])).toThrow();
  });
});

describe('aggregateCandles', () => {
  it('folds 1h bars into 4h bars aligned to UTC midnight', () => {
    const hours = [0, 1, 2, 3, 4, 5].map((i) => bar(MONDAY + i * HOUR, 10 + i, 20 + i, 5 + i, 11 + i, 2));
    const out = aggregateCandles(hours, '4h');
    expect(out).toEqual([
      { time: MONDAY, open: 10, high: 23, low: 5, close: 14, volume: 8 },
      { time: MONDAY + 4 * HOUR, open: 14, high: 25, low: 9, close: 16, volume: 4 },
    ]);
  });

  it('starts weekly bars on Monday', () => {
    const days = [-1, 0, 1, 6, 7].map((i) => bar(MONDAY + i * DAY, 1, 2, 0.5, 1.5));
    const out = aggregateCandles(days, '1W');
    expect(out.map((c) => new Date(c.time).toISOString().slice(0, 10))).toEqual(['2026-10-05', '2026-10-12', '2026-10-19']);
    expect(out[1].volume).toBe(3);
  });

  it('does not mutate its input', () => {
    const input = [bar(MONDAY, 1, 2, 0, 1), bar(MONDAY + HOUR, 1, 3, 0, 2)];
    const copy = JSON.parse(JSON.stringify(input));
    aggregateCandles(input, '4h');
    expect(input).toEqual(copy);
  });
});

describe('coinbasePageWindow', () => {
  it('ends after the bar in progress on the first page', () => {
    const now = MONDAY + 90 * 60_000; // 01:30
    const w = coinbasePageWindow('1h', undefined, 300, now);
    expect(w.end).toBe(MONDAY + 2 * HOUR);
    expect(w.end - w.start).toBe(300 * HOUR);
  });

  it('caps aggregated pages so the native request stays within 300 bars', () => {
    const w = coinbasePageWindow('4h', MONDAY, 500);
    expect(w.bars).toBe(75);
    expect(w.end).toBe(MONDAY);
    expect((w.end - w.start) / HOUR).toBe(300);
  });

  it('snaps the cursor to a week boundary for weekly bars', () => {
    const w = coinbasePageWindow('1W', MONDAY + 3 * DAY, 500);
    expect(w.end).toBe(MONDAY);
    expect(new Date(w.start).getUTCDay()).toBe(1);
  });
});

describe('CoinbaseSource.fetchCandles', () => {
  it('sends granularity and an inclusive end one second before the cursor, returns ascending bars', async () => {
    const { fetch, calls } = fakeFetch(() => ({
      body: [
        [(MONDAY - HOUR) / 1000, 1, 3, 2, 2.5, 4],
        [(MONDAY - 2 * HOUR) / 1000, 1, 3, 2, 2.2, 5],
      ],
    }));
    const source = new CoinbaseSource({ fetch, restBase: 'https://example.test' });
    const candles = await source.fetchCandles('BTC-USD', '1h', { before: MONDAY, limit: 2 });
    const url = calls[0];
    expect(url.pathname).toBe('/products/BTC-USD/candles');
    expect(url.searchParams.get('granularity')).toBe('3600');
    expect(url.searchParams.get('end')).toBe(new Date(MONDAY - 1000).toISOString());
    expect(url.searchParams.get('start')).toBe(new Date(MONDAY - 2 * HOUR).toISOString());
    expect(candles.map((c) => c.time)).toEqual([MONDAY - 2 * HOUR, MONDAY - HOUR]);
  });

  it('builds 4h bars from 1h data', async () => {
    const rows = Array.from({ length: 8 }, (_, i) => [(MONDAY - (i + 1) * HOUR) / 1000, 1, 2 + i, 1.5, 1.8, 1]);
    const { fetch, calls } = fakeFetch(() => ({ body: rows }));
    const source = new CoinbaseSource({ fetch, restBase: 'https://example.test' });
    const candles = await source.fetchCandles('ETH-USD', '4h', { before: MONDAY, limit: 2 });
    expect(calls[0].searchParams.get('granularity')).toBe('3600');
    expect(candles.map((c) => c.time)).toEqual([MONDAY - 8 * HOUR, MONDAY - 4 * HOUR]);
    expect(candles.every((c) => c.volume === 4)).toBe(true);
  });

  it('surfaces HTTP errors', async () => {
    const { fetch } = fakeFetch(() => ({ status: 429, body: {} }));
    const source = new CoinbaseSource({ fetch, restBase: 'https://example.test' });
    await expect(source.fetchCandles('BTC-USD', '1m')).rejects.toThrow(/429/);
  });
});

describe('parseCoinbaseProducts', () => {
  it('keeps online products and derives precision from increments', () => {
    const products = [
      { id: 'BTC-USD', base_currency: 'BTC', quote_currency: 'USD', quote_increment: '0.01', base_increment: '0.00000001', status: 'online' },
      { id: 'DEAD-USD', base_currency: 'DEAD', quote_currency: 'USD', status: 'delisted' },
      { id: 'HALT-USD', base_currency: 'HALT', quote_currency: 'USD', status: 'online', trading_disabled: true },
    ];
    expect(parseCoinbaseProducts(products)).toEqual([
      { symbol: 'BTC-USD', base: 'BTC', quote: 'USD', pricePrecision: 2, volumePrecision: 8 },
    ]);
  });
});

describe('applyTrade', () => {
  it('updates the bar in progress and opens a new one at the boundary', () => {
    let c = applyTrade(bar(MONDAY, 10, 12, 9, 11, 5), '1h', { price: 13, size: 2, time: MONDAY + 10 * 60_000 });
    expect(c).toEqual({ time: MONDAY, open: 10, high: 13, low: 9, close: 13, volume: 7 });
    c = applyTrade(c, '1h', { price: 8, size: 1, time: MONDAY + HOUR + 1 });
    expect(c).toEqual({ time: MONDAY + HOUR, open: 8, high: 8, low: 8, close: 8, volume: 1 });
  });

  it('ignores late trades for a bar that already closed', () => {
    const current = bar(MONDAY + HOUR, 8, 8, 8, 8, 1);
    expect(applyTrade(current, '1h', { price: 100, size: 1, time: MONDAY + 5 })).toBe(current);
  });
});
