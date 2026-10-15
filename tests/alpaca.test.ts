import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlpacaSource, classifyAlpaca, parseAlpacaAssets, parseAlpacaBars } from '../src/data/alpaca';
import { ProviderError, RateLimitError } from '../src/data/http';
import type { Candle } from '../src/data/types';
import { fakeFetch, fakeSockets } from './helpers';

const keys = () => ({ keyId: 'PKTEST', secretKey: 'secret-test' });
const NOW = Date.UTC(2026, 9, 15, 18, 0);

const BARS = {
  bars: [
    { t: '2026-10-15T17:00:00Z', o: 347, h: 348, l: 346, c: 347.5, v: 1200, n: 30, vw: 347.2 },
    { t: '2026-10-15T16:00:00Z', o: 346, h: 347.2, l: 345.8, c: 347, v: 1500, n: 40, vw: 346.5 },
  ],
  symbol: 'AAPL',
  next_page_token: null,
};

describe('Alpaca parsing', () => {
  it('parses bars ascending', () => {
    const out = parseAlpacaBars(BARS, '1h');
    expect(out.map((c) => c.time)).toEqual([Date.UTC(2026, 9, 15, 16), Date.UTC(2026, 9, 15, 17)]);
    expect(out[1]).toEqual({ time: Date.UTC(2026, 9, 15, 17), open: 347, high: 348, low: 346, close: 347.5, volume: 1200 });
  });

  it('moves daily bars from New York midnight to UTC midnight of the trading date', () => {
    const out = parseAlpacaBars({ bars: [{ t: '2026-10-14T04:00:00Z', o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }] }, '1D');
    expect(out[0].time).toBe(Date.UTC(2026, 9, 14));
  });

  it('treats bars: null as no data', () => {
    expect(parseAlpacaBars({ bars: null, next_page_token: null }, '1h')).toEqual([]);
  });

  it('lists assets with ETF badges and skips OTC', () => {
    const out = parseAlpacaAssets([
      { symbol: 'SPY', name: 'SPDR S&P 500 ETF Trust', exchange: 'ARCA', status: 'active' },
      { symbol: 'AAPL', name: 'Apple Inc. Common Stock', exchange: 'NASDAQ', status: 'active' },
      { symbol: 'PINK', name: 'Pink sheet', exchange: 'OTC', status: 'active' },
    ]);
    expect(out.map((s) => [s.symbol, s.market])).toEqual([
      ['AAPL', 'stock'],
      ['SPY', 'etf'],
    ]);
  });

  it('classifies errors, including the HTML 401 page', () => {
    expect(classifyAlpaca(401, null)?.kind).toBe('auth');
    expect(classifyAlpaca(403, { message: 'forbidden' })?.kind).toBe('auth');
    expect(classifyAlpaca(403, { message: 'subscription does not permit querying recent SIP data' })?.kind).toBe('plan');
    expect(classifyAlpaca(422, { message: 'invalid symbol: ???' })?.kind).toBe('not-found');
    expect(classifyAlpaca(429, { message: 'too many requests.' })?.kind).toBe('rate');
    expect(classifyAlpaca(200, BARS)).toBeNull();
  });
});

describe('AlpacaSource', () => {
  it('sends the key pair in headers, asks for the IEX feed newest first, and pages with end', async () => {
    const { fetch, calls, headersOf } = fakeFetch(() => ({ body: BARS }));
    const source = new AlpacaSource({ fetch, keys, now: () => NOW });
    const out = await source.fetchCandles('AAPL', '1h', { limit: 2 });
    expect(out).toHaveLength(2);
    expect(calls[0].origin).toBe('https://data.alpaca.markets');
    expect(calls[0].pathname).toBe('/v2/stocks/AAPL/bars');
    expect(headersOf(0)).toEqual({ 'APCA-API-KEY-ID': 'PKTEST', 'APCA-API-SECRET-KEY': 'secret-test' });
    expect(calls[0].search).not.toContain('secret');
    expect(calls[0].searchParams.get('feed')).toBe('iex');
    expect(calls[0].searchParams.get('sort')).toBe('desc');
    expect(calls[0].searchParams.get('timeframe')).toBe('1Hour');
    expect(calls[0].searchParams.has('end')).toBe(false);

    const before = Date.UTC(2026, 9, 15, 17);
    const older = await source.fetchCandles('AAPL', '1h', { before, limit: 2 });
    expect(calls[1].searchParams.get('end')).toBe('2026-10-15T16:59:59.000Z');
    expect(older.map((c) => c.time)).toEqual([Date.UTC(2026, 9, 15, 16)]);
  });

  it('looks back to the start of history once when a window is empty', async () => {
    const { fetch, calls } = fakeFetch((url) => ({ body: url.searchParams.get('start')!.startsWith('2016') ? BARS : { bars: null } }));
    const out = await new AlpacaSource({ fetch, keys, now: () => NOW }).fetchCandles('QUIET', '1h');
    expect(calls).toHaveLength(2);
    expect(out).toHaveLength(2);
  });

  it('builds Monday weeks from daily bars', async () => {
    const days = [
      { t: '2026-10-09T04:00:00Z', o: 1, h: 2, l: 1, c: 2, v: 1 },
      { t: '2026-10-12T04:00:00Z', o: 2, h: 3, l: 2, c: 3, v: 1 },
      { t: '2026-10-13T04:00:00Z', o: 3, h: 4, l: 3, c: 4, v: 1 },
    ];
    const { fetch, calls } = fakeFetch(() => ({ body: { bars: days } }));
    const weeks = await new AlpacaSource({ fetch, keys, now: () => NOW }).fetchCandles('AAPL', '1W', { limit: 10 });
    expect(calls[0].searchParams.get('timeframe')).toBe('1Day');
    expect(weeks.map((w) => new Date(w.time).toISOString().slice(0, 10))).toEqual(['2026-10-05', '2026-10-12']);
    expect(weeks[1]).toMatchObject({ open: 2, close: 4, volume: 2 });
  });

  it('needs both key fields', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: BARS }));
    const err = await new AlpacaSource({ fetch, keys: () => ({ keyId: 'PK' }) }).fetchCandles('AAPL', '1h').catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe('no-key');
    expect(calls).toHaveLength(0);
  });

  it('reports a rejected key and rate limits', async () => {
    const bad = fakeFetch(() => ({ status: 401, body: null, raw: '<html><title>401 Authorization Required</title></html>' }));
    await expect(new AlpacaSource({ fetch: bad.fetch, keys }).testConnection()).rejects.toThrow('Alpaca rejected the key pair');
    const busy = fakeFetch(() => ({ status: 429, body: { message: 'too many requests.' } }));
    await expect(new AlpacaSource({ fetch: busy.fetch, keys, now: () => 0 }).fetchCandles('AAPL', '1h')).rejects.toBeInstanceOf(RateLimitError);
  });

  it('searches the asset list from the paper trading host, falling back to the live host', async () => {
    const { fetch, calls } = fakeFetch((url) =>
      url.host === 'paper-api.alpaca.markets'
        ? { status: 401, body: null }
        : { body: [{ symbol: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ', status: 'active' }, { symbol: 'AAL', name: 'American Airlines', exchange: 'NASDAQ', status: 'active' }] },
    );
    const source = new AlpacaSource({ fetch, keys });
    expect((await source.search('aapl'))[0]).toMatchObject({ symbol: 'AAPL', name: 'Apple Inc.', market: 'stock' });
    expect(calls.map((u) => u.host)).toEqual(['paper-api.alpaca.markets', 'api.alpaca.markets']);
    await source.search('aal');
    expect(calls).toHaveLength(2);
  });

  describe('live trades', () => {
    afterEach(() => vi.useRealTimers());

    it('authenticates with a message, shares one connection across charts, and builds bars from trades', () => {
      const { factory, sockets } = fakeSockets();
      const source = new AlpacaSource({ keys, webSocketFactory: factory });
      const seed: Candle = { time: Date.UTC(2026, 9, 15, 17), open: 347, high: 348, low: 346, close: 347.5, volume: 1200 };
      const a: Candle[] = [];
      const b: Candle[] = [];
      const stopA = source.subscribe('AAPL', '1h', (c) => a.push(c), { seed });
      const stopB = source.subscribe('MSFT', '5m', (c) => b.push(c));
      expect(sockets).toHaveLength(1);
      const ws = sockets[0];
      expect(ws.url).toBe('wss://stream.data.alpaca.markets/v2/iex');
      ws.open();
      expect(ws.messages()[0]).toEqual({ action: 'auth', key: 'PKTEST', secret: 'secret-test' });
      ws.receive([{ T: 'success', msg: 'connected' }]);
      ws.receive([{ T: 'success', msg: 'authenticated' }]);
      expect(ws.messages()[1]).toEqual({ action: 'subscribe', trades: ['AAPL', 'MSFT'] });
      ws.receive([
        { T: 't', S: 'AAPL', p: 349, s: 10, t: '2026-10-15T17:30:00.123Z' },
        { T: 't', S: 'MSFT', p: 500, s: 3, t: '2026-10-15T17:31:00Z' },
      ]);
      expect(a[0]).toMatchObject({ time: seed.time, high: 349, close: 349, volume: 1210 });
      expect(b[0]).toEqual({ time: Date.UTC(2026, 9, 15, 17, 30), open: 500, high: 500, low: 500, close: 500, volume: 3 });
      stopA();
      expect(ws.messages()[2]).toEqual({ action: 'unsubscribe', trades: ['AAPL'] });
      stopB();
      expect(ws.closed).toBe(true);
    });

    it('falls back to polling when the free plan connection limit is hit', async () => {
      vi.useFakeTimers();
      const { fetch, calls } = fakeFetch(() => ({ body: BARS }));
      const { factory, last } = fakeSockets();
      const errors: string[] = [];
      const statuses: string[] = [];
      const stop = new AlpacaSource({ fetch, keys, webSocketFactory: factory, pollMs: 60_000 }).subscribe('AAPL', '1h', () => undefined, {
        onError: (m) => errors.push(m),
        onStatus: (s) => statuses.push(s),
      });
      last().open();
      last().receive([{ T: 'error', code: 406, msg: 'connection limit exceeded' }]);
      expect(errors[0]).toContain('one live connection');
      expect(statuses).toContain('polling');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).toHaveLength(1);
      stop();
    });

    it('reports a rejected key on the stream', () => {
      const { factory, last } = fakeSockets();
      const errors: string[] = [];
      const statuses: string[] = [];
      new AlpacaSource({ keys, webSocketFactory: factory }).subscribe('AAPL', '1h', () => undefined, { onError: (m) => errors.push(m), onStatus: (s) => statuses.push(s) });
      last().open();
      last().receive([{ T: 'error', code: 402, msg: 'auth failed' }]);
      expect(errors[0]).toContain('rejected the key pair');
      expect(last().closed).toBe(true);
      // A refused key cannot poll either, so the chart goes offline instead.
      expect(statuses).not.toContain('polling');
      expect(statuses[statuses.length - 1]).toBe('closed');
    });
  });
});
