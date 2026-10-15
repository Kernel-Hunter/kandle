import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TwelveDataSource,
  classifyTwelveData,
  formatTwelveDataTime,
  parseTwelveDataSearch,
  parseTwelveDataSeries,
  parseTwelveDataTime,
  twelveDataMarket,
} from '../src/data/twelvedata';
import { ProviderError, RateLimitError } from '../src/data/http';
import type { Candle } from '../src/data/types';
import { fakeFetch, fakeSockets } from './helpers';

// Shape captured from GET /time_series?symbol=AAPL&interval=1h&timezone=UTC (newest first).
const SERIES = {
  meta: { symbol: 'AAPL', interval: '1h', currency: 'USD', exchange_timezone: 'America/New_York', exchange: 'NASDAQ', mic_code: 'XNGS', type: 'Common Stock' },
  values: [
    { datetime: '2026-10-15 13:30:00', open: '346.95', high: '347.72', low: '345.44', close: '347.255', volume: '90603' },
    { datetime: '2026-10-14 19:30:00', open: '343.17001', high: '344.84', low: '342.23999', close: '343.040009', volume: '5000000' },
    { datetime: '2026-10-14 18:30:00', open: '342', high: '343.5', low: '341.9', close: '343.17', volume: '4000000' },
  ],
  status: 'ok',
};

const FOREX = {
  meta: { symbol: 'EUR/USD', interval: '1day', currency_base: 'Euro', currency_quote: 'US Dollar', type: 'Physical Currency' },
  values: [{ datetime: '2026-10-01', open: '1.13272', high: '1.13358', low: '1.13263', close: '1.13341' }],
  status: 'ok',
};

const BAD_KEY = {
  code: 401,
  message: '**apikey** parameter is incorrect or not specified. You can get your free API key instantly following this link: https://twelvedata.com/pricing.',
  status: 'error',
};

const OUT_OF_CREDITS = {
  code: 429,
  message: 'You have run out of API credits for the current minute. 9 API credits were used, with the current limit being 8. Wait for the next minute or consider switching to a higher tier plan.',
  status: 'error',
};

const key = () => ({ apiKey: 'test-key-123' });

describe('Twelve Data parsing', () => {
  it('parses UTC datetimes and formats end_date', () => {
    expect(parseTwelveDataTime('2026-10-15 13:30:00')).toBe(Date.UTC(2026, 9, 15, 13, 30));
    expect(parseTwelveDataTime('2026-10-15')).toBe(Date.UTC(2026, 9, 15));
    expect(formatTwelveDataTime(Date.UTC(2026, 9, 15, 13, 29, 59))).toBe('2026-10-15 13:29:59');
  });

  it('parses a stock series in ascending order with its exchange time zone', () => {
    const { candles, timeZone, market } = parseTwelveDataSeries(SERIES, '1h');
    expect(candles.map((c) => c.time)).toEqual([Date.UTC(2026, 9, 14, 18, 30), Date.UTC(2026, 9, 14, 19, 30), Date.UTC(2026, 9, 15, 13, 30)]);
    expect(candles[2]).toEqual({ time: Date.UTC(2026, 9, 15, 13, 30), open: 346.95, high: 347.72, low: 345.44, close: 347.255, volume: 90603 });
    expect(timeZone).toBe('America/New_York');
    expect(market).toBe('stock');
  });

  it('gives forex bars zero volume and UTC days', () => {
    const { candles, timeZone, market } = parseTwelveDataSeries(FOREX, '1D');
    expect(candles[0].volume).toBe(0);
    expect(timeZone).toBe('UTC');
    expect(market).toBe('forex');
  });

  it('maps instrument types to market badges', () => {
    expect(twelveDataMarket('Common Stock')).toBe('stock');
    expect(twelveDataMarket('ETF')).toBe('etf');
    expect(twelveDataMarket('Physical Currency')).toBe('forex');
    expect(twelveDataMarket('Digital Currency')).toBe('crypto');
    expect(twelveDataMarket('Index')).toBe('index');
  });

  it('parses search results and tags non-US listings with their exchange', () => {
    const json = {
      data: [
        { symbol: 'AAPL', instrument_name: 'Apple Inc', exchange: 'NASDAQ', instrument_type: 'Common Stock', country: 'United States', currency: 'USD' },
        { symbol: 'AAPL', instrument_name: 'Apple Inc', exchange: 'NASDAQ', instrument_type: 'Common Stock', country: 'United States', currency: 'USD' },
        { symbol: 'SAP', instrument_name: 'SAP SE', exchange: 'XETR', instrument_type: 'Common Stock', country: 'Germany', currency: 'EUR' },
        { symbol: 'EUR/USD', instrument_name: 'Euro / US Dollar', exchange: 'PHYSICAL CURRENCY', instrument_type: 'Physical Currency', country: '', currency: '' },
      ],
      status: 'ok',
    };
    const out = parseTwelveDataSearch(json);
    expect(out.map((s) => s.symbol)).toEqual(['AAPL', 'SAP:XETR', 'EUR/USD']);
    expect(out[0]).toMatchObject({ market: 'stock', name: 'Apple Inc', exchange: 'NASDAQ', quote: 'USD' });
    expect(out[1]).toMatchObject({ base: 'SAP', quote: 'EUR' });
    expect(out[2]).toMatchObject({ base: 'EUR', quote: 'USD', market: 'forex', pricePrecision: 5 });
  });

  it('classifies body errors, including ones sent with HTTP 200', () => {
    expect(classifyTwelveData(401, BAD_KEY)).toMatchObject({ kind: 'auth' });
    const now = Date.UTC(2026, 9, 15, 13, 0, 45);
    expect(classifyTwelveData(200, OUT_OF_CREDITS, now)).toEqual({ kind: 'rate', retryAfter: 15 });
    expect(classifyTwelveData(200, { code: 429, message: 'You have run out of API credits for the day.', status: 'error' }, Date.UTC(2026, 9, 15, 23, 0))).toEqual({
      kind: 'rate',
      retryAfter: 3600,
    });
    expect(classifyTwelveData(200, { code: 403, message: 'This symbol is available starting with Grow plan. Upgrade.', status: 'error' })).toEqual({
      kind: 'plan',
      message: 'Twelve Data: This symbol is available starting with Grow plan.',
    });
    expect(classifyTwelveData(200, { code: 400, message: 'symbol not found: ZZZ.', status: 'error' })?.kind).toBe('not-found');
    expect(classifyTwelveData(200, SERIES)).toBeNull();
  });
});

describe('TwelveDataSource', () => {
  it('sends the key only in the Authorization header to Twelve Data', async () => {
    const { fetch, calls, headersOf } = fakeFetch(() => ({ body: SERIES }));
    const source = new TwelveDataSource({ fetch, keys: key });
    await source.fetchCandles('AAPL', '1h', { limit: 3 });
    expect(calls[0].origin).toBe('https://api.twelvedata.com');
    expect(calls[0].pathname).toBe('/time_series');
    expect(calls[0].search).not.toContain('test-key-123');
    expect(headersOf(0)).toEqual({ Authorization: 'apikey test-key-123' });
    expect(Object.fromEntries(calls[0].searchParams)).toEqual({ symbol: 'AAPL', interval: '1h', outputsize: '3', timezone: 'UTC' });
  });

  it('pages with an inclusive end_date one second before the cursor', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: SERIES }));
    const source = new TwelveDataSource({ fetch, keys: key });
    const before = Date.UTC(2026, 9, 14, 19, 30);
    const out = await source.fetchCandles('AAPL', '1h', { before });
    expect(calls[0].searchParams.get('end_date')).toBe('2026-10-14 19:29:59');
    expect(out.map((c) => c.time)).toEqual([Date.UTC(2026, 9, 14, 18, 30)]);
  });

  it('asks for a key before making any request', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: SERIES }));
    const err = await new TwelveDataSource({ fetch, keys: () => null }).fetchCandles('AAPL', '1h').catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe('no-key');
    expect(err.message).toBe('Add your Twelve Data API key in Data sources to load this chart.');
    expect(calls).toHaveLength(0);
  });

  it('reports a rejected key clearly', async () => {
    const { fetch } = fakeFetch(() => ({ status: 401, body: BAD_KEY }));
    await expect(new TwelveDataSource({ fetch, keys: key }).fetchCandles('AAPL', '1h')).rejects.toThrow('Twelve Data rejected the API key. Check it in Data sources.');
    await expect(new TwelveDataSource({ fetch, keys: key }).testConnection()).rejects.toThrow('rejected the API key');
  });

  it('stays inside 8 requests a minute and says how long to wait', async () => {
    const now = Date.UTC(2026, 9, 15, 13, 0, 0);
    const { fetch, calls } = fakeFetch(() => ({ body: SERIES }));
    const source = new TwelveDataSource({ fetch, keys: key, now: () => now });
    for (let i = 0; i < 8; i++) await source.fetchCandles('AAPL', '1h', { before: now - i * 3_600_000 });
    const err = await source.fetchCandles('AAPL', '1h', { before: now - 99 * 3_600_000 }).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.message).toBe('Free plan limit reached, try again in 60 s');
    expect(calls).toHaveLength(8);
  });

  it('backs off until the next minute after a 429 in the body', async () => {
    const now = Date.UTC(2026, 9, 15, 13, 0, 40);
    const { fetch, calls } = fakeFetch(() => ({ body: OUT_OF_CREDITS }));
    const source = new TwelveDataSource({ fetch, keys: key, now: () => now });
    await expect(source.fetchCandles('AAPL', '1h')).rejects.toThrow('Free plan limit reached, try again in 20 s');
    await expect(source.fetchCandles('MSFT', '1h')).rejects.toThrow('try again in 20 s');
    expect(calls).toHaveLength(1);
  });

  it('caches identical requests for a short while', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: SERIES }));
    const source = new TwelveDataSource({ fetch, keys: key });
    await source.fetchCandles('AAPL', '1h', { limit: 3 });
    await source.fetchCandles('AAPL', '1h', { limit: 3 });
    expect(calls).toHaveLength(1);
  });

  it('searches through symbol_search and shows popular symbols for an empty query', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { data: [{ symbol: 'MSFT', instrument_name: 'Microsoft', exchange: 'NASDAQ', instrument_type: 'Common Stock', country: 'United States', currency: 'USD' }], status: 'ok' } }));
    const source = new TwelveDataSource({ fetch, keys: key });
    expect((await source.search('')).length).toBeGreaterThan(5);
    expect(calls).toHaveLength(0);
    expect((await source.search('micro'))[0].symbol).toBe('MSFT');
    expect(calls[0].pathname).toBe('/symbol_search');
  });

  it('reports usage on a successful connection test', async () => {
    const { fetch } = fakeFetch(() => ({ body: { current_usage: 2, plan_limit: 8, plan_category: 'basic' } }));
    expect(await new TwelveDataSource({ fetch, keys: key }).testConnection()).toBe('Key works (basic plan, 2 of 8 requests used this minute).');
  });

  describe('live updates', () => {
    afterEach(() => vi.useRealTimers());

    it('builds bars from websocket prices on the session grid', async () => {
      const { fetch } = fakeFetch(() => ({ body: SERIES }));
      const { factory, last } = fakeSockets();
      const source = new TwelveDataSource({ fetch, keys: key, webSocketFactory: factory });
      await source.fetchCandles('AAPL', '1h');
      const seed: Candle = { time: Date.UTC(2026, 9, 15, 13, 30), open: 346.95, high: 347.72, low: 345.44, close: 347.255, volume: 90603 };
      const got: Candle[] = [];
      const stop = source.subscribe('AAPL', '1h', (c) => got.push(c), { seed });
      last().open();
      expect(last().url).toBe('wss://ws.twelvedata.com/v1/quotes/price?apikey=test-key-123');
      expect(last().messages()[0]).toEqual({ action: 'subscribe', params: { symbols: 'AAPL' } });
      last().receive({ event: 'subscribe-status', status: 'ok', success: [{ symbol: 'AAPL' }], fails: [] });
      last().receive({ event: 'price', symbol: 'AAPL', price: 348, timestamp: Date.UTC(2026, 9, 15, 14, 10) / 1000, day_volume: 100 });
      last().receive({ event: 'price', symbol: 'AAPL', price: 349, timestamp: Date.UTC(2026, 9, 15, 14, 40) / 1000, day_volume: 130 });
      expect(got[0]).toMatchObject({ time: seed.time, close: 348, high: 348 });
      // 14:40 starts the 14:30 bar, not a 14:00 bar.
      expect(got[1]).toEqual({ time: Date.UTC(2026, 9, 15, 14, 30), open: 349, high: 349, low: 349, close: 349, volume: 30 });
      stop();
    });

    it('falls back to polling once a minute when the plan has no websocket for the symbol', async () => {
      vi.useFakeTimers();
      const { fetch, calls } = fakeFetch(() => ({ body: SERIES }));
      const { factory, last } = fakeSockets();
      const statuses: string[] = [];
      const got: number[] = [];
      const stop = new TwelveDataSource({ fetch, keys: key, webSocketFactory: factory, pollMs: 60_000 }).subscribe('AAPL', '1h', (c) => got.push(c.time), {
        onStatus: (s) => statuses.push(s),
      });
      last().open();
      last().receive({ event: 'subscribe-status', status: 'error', success: [], fails: [{ symbol: 'AAPL' }] });
      expect(last().closed).toBe(true);
      expect(statuses).toContain('polling');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls[0].searchParams.get('outputsize')).toBe('2');
      expect(got.length).toBeGreaterThan(0);
      stop();
    });

    it('falls back to polling when the websocket refuses to connect', async () => {
      vi.useFakeTimers();
      const { fetch } = fakeFetch(() => ({ body: SERIES }));
      const { factory, sockets } = fakeSockets();
      const statuses: string[] = [];
      const stop = new TwelveDataSource({ fetch, keys: key, webSocketFactory: factory }).subscribe('AAPL', '1h', () => undefined, { onStatus: (s) => statuses.push(s) });
      sockets[0].drop();
      await vi.advanceTimersByTimeAsync(1000);
      sockets[1].drop();
      expect(statuses[statuses.length - 1]).toBe('polling');
      stop();
    });

    it('reports a missing key instead of connecting', () => {
      const { factory, sockets } = fakeSockets();
      const errors: string[] = [];
      new TwelveDataSource({ keys: () => null, webSocketFactory: factory }).subscribe('AAPL', '1h', () => undefined, { onError: (m) => errors.push(m) });
      expect(sockets).toHaveLength(0);
      expect(errors[0]).toContain('Add your Twelve Data API key');
    });
  });
});
