import { describe, expect, it } from 'vitest';
import { PolygonSource, classifyPolygon, parsePolygonAggs, parsePolygonTickers, polygonMarket } from '../src/data/polygon';
import { ProviderError, RateLimitError } from '../src/data/http';
import { fakeFetch } from './helpers';

const key = () => ({ apiKey: 'poly-test-key' });
const NOW = Date.UTC(2026, 9, 15, 20, 0);

// Shape of GET /v2/aggs/ticker/AAPL/range/1/hour/{from}/{to}?sort=desc.
const AGGS = {
  ticker: 'AAPL',
  queryCount: 2,
  resultsCount: 2,
  adjusted: true,
  results: [
    { v: 2_000_000, vw: 343.1, o: 343.17, c: 343.04, h: 344.84, l: 342.24, t: Date.UTC(2026, 9, 14, 19), n: 30000 },
    { v: 1_500_000, vw: 342.6, o: 342, c: 343.17, h: 343.5, l: 341.9, t: Date.UTC(2026, 9, 14, 18), n: 25000 },
  ],
  status: 'DELAYED',
  request_id: 'abc',
};

describe('Polygon parsing', () => {
  it('parses aggregates ascending', () => {
    const out = parsePolygonAggs(AGGS, '1h', 'AAPL');
    expect(out.map((c) => c.time)).toEqual([Date.UTC(2026, 9, 14, 18), Date.UTC(2026, 9, 14, 19)]);
    expect(out[1]).toEqual({ time: Date.UTC(2026, 9, 14, 19), open: 343.17, high: 344.84, low: 342.24, close: 343.04, volume: 2_000_000 });
  });

  it('moves stock daily bars to the trading date, forex days stay UTC', () => {
    const day = { results: [{ o: 1, h: 1, l: 1, c: 1, v: 1, t: Date.UTC(2026, 9, 14, 4) }] };
    expect(parsePolygonAggs(day, '1D', 'AAPL')[0].time).toBe(Date.UTC(2026, 9, 14));
    expect(parsePolygonAggs({ results: [{ o: 1, h: 1, l: 1, c: 1, t: Date.UTC(2026, 9, 14) }] }, '1D', 'C:EURUSD')[0]).toMatchObject({ time: Date.UTC(2026, 9, 14), volume: 0 });
  });

  it('treats a response without results as no data', () => {
    expect(parsePolygonAggs({ ticker: 'AAPL', resultsCount: 0, status: 'OK' }, '1h', 'AAPL')).toEqual([]);
  });

  it('maps ticker prefixes and search results to markets', () => {
    expect(polygonMarket('C:EURUSD')).toBe('forex');
    expect(polygonMarket('X:BTCUSD')).toBe('crypto');
    expect(polygonMarket('I:SPX')).toBe('index');
    const out = parsePolygonTickers({
      results: [
        { ticker: 'AAPL', name: 'Apple Inc.', market: 'stocks', type: 'CS', currency_name: 'usd', primary_exchange: 'XNAS' },
        { ticker: 'SPY', name: 'SPDR S&P 500', market: 'stocks', type: 'ETF', currency_name: 'usd' },
        { ticker: 'C:EURUSD', name: 'Euro - United States Dollar', market: 'fx', currency_symbol: 'USD', base_currency_symbol: 'EUR' },
        { ticker: 'I:SPX', name: 'S&P 500', market: 'indices' },
      ],
    });
    expect(out.map((s) => [s.symbol, s.market, s.base, s.quote])).toEqual([
      ['AAPL', 'stock', 'AAPL', 'USD'],
      ['SPY', 'etf', 'SPY', 'USD'],
      ['C:EURUSD', 'forex', 'EUR', 'USD'],
      ['I:SPX', 'index', 'SPX', 'USD'],
    ]);
  });

  it('classifies errors', () => {
    expect(classifyPolygon(401, { status: 'ERROR', error: 'Unknown API Key' })?.kind).toBe('auth');
    expect(classifyPolygon(403, { status: 'NOT_AUTHORIZED', message: 'You are not entitled to this data.' })?.kind).toBe('plan');
    expect(classifyPolygon(429, { status: 'ERROR', error: "You've exceeded the maximum requests per minute" })?.kind).toBe('rate');
    expect(classifyPolygon(200, AGGS)).toBeNull();
  });
});

describe('PolygonSource', () => {
  it('sends the key as a bearer header and asks for the newest bars in a window', async () => {
    const { fetch, calls, headersOf } = fakeFetch(() => ({ body: AGGS }));
    const out = await new PolygonSource({ fetch, keys: key, now: () => NOW }).fetchCandles('AAPL', '1h', { limit: 2 });
    expect(out).toHaveLength(2);
    expect(calls[0].origin).toBe('https://api.polygon.io');
    expect(calls[0].pathname).toMatch(/^\/v2\/aggs\/ticker\/AAPL\/range\/1\/hour\/\d+\/\d+$/);
    expect(calls[0].pathname.endsWith(`/${NOW}`)).toBe(true);
    expect(calls[0].searchParams.get('sort')).toBe('desc');
    expect(calls[0].search).not.toContain('poly-test-key');
    expect(headersOf(0)).toEqual({ Authorization: 'Bearer poly-test-key' });
  });

  it('pages before a cursor and treats the plan history limit as the end', async () => {
    const before = Date.UTC(2026, 9, 14, 19);
    const ok = fakeFetch(() => ({ body: AGGS }));
    const older = await new PolygonSource({ fetch: ok.fetch, keys: key, now: () => NOW }).fetchCandles('AAPL', '1h', { before });
    expect(ok.calls[0].pathname.endsWith(`/${before - 1}`)).toBe(true);
    expect(older.map((c) => c.time)).toEqual([Date.UTC(2026, 9, 14, 18)]);

    const limited = fakeFetch(() => ({ status: 403, body: { status: 'NOT_AUTHORIZED', message: 'You are not entitled to this data.' } }));
    const source = new PolygonSource({ fetch: limited.fetch, keys: key, now: () => NOW });
    expect(await source.fetchCandles('AAPL', '1D', { before: Date.UTC(2023, 0, 1) })).toEqual([]);
    await expect(source.fetchCandles('I:SPX', '1D')).rejects.toThrow('your plan does not include this data');
  });

  it('stays within 5 requests a minute', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: AGGS }));
    const source = new PolygonSource({ fetch, keys: key, now: () => NOW });
    for (let i = 0; i < 5; i++) await source.fetchCandles('AAPL', '1h', { before: NOW - i * 3_600_000 });
    const err = await source.fetchCandles('MSFT', '1h').catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.message).toBe('Free plan limit reached, try again in 60 s');
    expect(calls).toHaveLength(5);
  });

  it('turns a 429 into a backoff message', async () => {
    const { fetch } = fakeFetch(() => ({ status: 429, body: { status: 'ERROR', error: "You've exceeded the maximum requests per minute" } }));
    await expect(new PolygonSource({ fetch, keys: key, now: () => 0 }).fetchCandles('AAPL', '1h')).rejects.toThrow(/^Free plan limit reached, try again in 15 s$/);
  });

  it('needs a key and checks it', async () => {
    const none = fakeFetch(() => ({ body: AGGS }));
    const err = await new PolygonSource({ fetch: none.fetch, keys: () => null }).fetchCandles('AAPL', '1h').catch((e) => e);
    expect((err as ProviderError).kind).toBe('no-key');
    expect(none.calls).toHaveLength(0);
    const bad = fakeFetch(() => ({ status: 401, body: { status: 'ERROR', request_id: 'x', error: 'Unknown API Key' } }));
    await expect(new PolygonSource({ fetch: bad.fetch, keys: key }).testConnection()).rejects.toThrow('Polygon rejected the API key');
  });

  it('labels the chart as delayed instead of streaming', () => {
    const statuses: string[] = [];
    const stop = new PolygonSource({ keys: key }).subscribe('AAPL', '1h', () => undefined, { onStatus: (s) => statuses.push(s) });
    stop();
    expect(statuses).toEqual(['delayed', 'closed']);
  });

  it('describes tickers without spending a request', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: {} }));
    const meta = await new PolygonSource({ fetch, keys: key }).getSymbol('C:GBPUSD');
    expect(meta).toMatchObject({ symbol: 'C:GBPUSD', base: 'GBP', quote: 'USD', market: 'forex' });
    expect(calls).toHaveLength(0);
  });
});
