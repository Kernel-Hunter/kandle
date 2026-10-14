import { describe, expect, it } from 'vitest';
import {
  BinanceSource,
  binanceInterval,
  parseBinanceExchangeInfo,
  parseBinanceKline,
  parseBinanceStreamKline,
} from '../src/data/binance';
import { binanceRow, fakeFetch } from './helpers';

const MIN = 60_000;

describe('parseBinanceKline', () => {
  it('maps the REST array format to a candle', () => {
    const row = [1700000000000, '100.5', '110', '99', '105.25', '1234.5', 1700000059999, '0', 1, '0', '0', '0'];
    expect(parseBinanceKline(row)).toEqual({ time: 1700000000000, open: 100.5, high: 110, low: 99, close: 105.25, volume: 1234.5 });
  });

  it('rejects malformed rows', () => {
    expect(() => parseBinanceKline([1, 2, 3])).toThrow();
    expect(() => parseBinanceKline('nope')).toThrow();
    expect(() => parseBinanceKline([1, 'x', '1', '1', '1', '1'])).toThrow();
  });
});

describe('parseBinanceStreamKline', () => {
  const event = { e: 'kline', k: { t: 1700000000000, o: '1', h: '3', l: '0.5', c: '2', v: '10', x: false } };

  it('parses kline events', () => {
    expect(parseBinanceStreamKline(event)).toEqual({ time: 1700000000000, open: 1, high: 3, low: 0.5, close: 2, volume: 10 });
  });

  it('unwraps combined-stream envelopes', () => {
    expect(parseBinanceStreamKline({ stream: 'btcusdt@kline_1m', data: event })?.close).toBe(2);
  });

  it('ignores other messages', () => {
    expect(parseBinanceStreamKline({ result: null, id: 1 })).toBeNull();
    expect(parseBinanceStreamKline(null)).toBeNull();
  });
});

describe('parseBinanceExchangeInfo', () => {
  it('keeps trading spot symbols and derives precision from filters', () => {
    const info = {
      symbols: [
        {
          symbol: 'BTCUSDT',
          status: 'TRADING',
          baseAsset: 'BTC',
          quoteAsset: 'USDT',
          isSpotTradingAllowed: true,
          filters: [
            { filterType: 'PRICE_FILTER', tickSize: '0.01000000' },
            { filterType: 'LOT_SIZE', stepSize: '0.00001000' },
          ],
        },
        { symbol: 'OLDUSDT', status: 'BREAK', baseAsset: 'OLD', quoteAsset: 'USDT', filters: [] },
      ],
    };
    expect(parseBinanceExchangeInfo(info)).toEqual([
      { symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT', pricePrecision: 2, volumePrecision: 5 },
    ]);
  });
});

describe('BinanceSource.fetchCandles', () => {
  it('maps timeframes to Binance intervals', () => {
    expect(binanceInterval('1D')).toBe('1d');
    expect(binanceInterval('1W')).toBe('1w');
    expect(binanceInterval('4h')).toBe('4h');
  });

  it('requests the latest page without endTime', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: [binanceRow(2 * MIN), binanceRow(MIN)] }));
    const source = new BinanceSource({ fetch, restBases: ['https://example.test'] });
    const candles = await source.fetchCandles('btcusdt', '1m', { limit: 2 });
    expect(calls[0].pathname).toBe('/api/v3/klines');
    expect(calls[0].searchParams.get('symbol')).toBe('BTCUSDT');
    expect(calls[0].searchParams.get('interval')).toBe('1m');
    expect(calls[0].searchParams.get('limit')).toBe('2');
    expect(calls[0].searchParams.has('endTime')).toBe(false);
    expect(candles.map((c) => c.time)).toEqual([MIN, 2 * MIN]); // sorted ascending
  });

  it('pages backwards with endTime just before the oldest loaded bar', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: [binanceRow(8 * MIN), binanceRow(9 * MIN), binanceRow(10 * MIN)] }));
    const source = new BinanceSource({ fetch, restBases: ['https://example.test'] });
    const candles = await source.fetchCandles('BTCUSDT', '1m', { before: 10 * MIN, limit: 3 });
    expect(calls[0].searchParams.get('endTime')).toBe(String(10 * MIN - 1));
    // A bar at the cursor itself must never come back, or the chart would show it twice.
    expect(candles.map((c) => c.time)).toEqual([8 * MIN, 9 * MIN]);
  });

  it('clamps the limit to the API maximum', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: [] }));
    const source = new BinanceSource({ fetch, restBases: ['https://example.test'] });
    await source.fetchCandles('BTCUSDT', '1h', { limit: 50_000 });
    expect(calls[0].searchParams.get('limit')).toBe('1000');
  });

  it('walks the whole history page by page without gaps or duplicates', async () => {
    const all = Array.from({ length: 1234 }, (_, i) => (i + 1) * MIN);
    const { fetch } = fakeFetch((url) => {
      const limit = Number(url.searchParams.get('limit'));
      const end = url.searchParams.has('endTime') ? Number(url.searchParams.get('endTime')) : Infinity;
      const page = all.filter((t) => t <= end).slice(-limit);
      return { body: page.map((t) => binanceRow(t)) };
    });
    const source = new BinanceSource({ fetch, restBases: ['https://example.test'] });
    let loaded = await source.fetchCandles('BTCUSDT', '1m', { limit: 500 });
    let requests = 1;
    for (;;) {
      const older = await source.fetchCandles('BTCUSDT', '1m', { before: loaded[0].time, limit: 500 });
      requests += 1;
      if (older.length === 0) break;
      loaded = [...older, ...loaded];
    }
    expect(loaded.map((c) => c.time)).toEqual(all);
    expect(requests).toBe(4); // 500 + 500 + 234 + one empty page
  });

  it('falls back to the next host when the first one fails', async () => {
    const { fetch, calls } = fakeFetch((url) =>
      url.hostname === 'blocked.test' ? { status: 451, body: {} } : { body: [binanceRow(MIN)] },
    );
    const source = new BinanceSource({ fetch, restBases: ['https://blocked.test', 'https://ok.test'] });
    const candles = await source.fetchCandles('BTCUSDT', '1m');
    expect(calls.map((c) => c.hostname)).toEqual(['blocked.test', 'ok.test']);
    expect(candles).toHaveLength(1);
  });

  it('throws when every host fails', async () => {
    const { fetch } = fakeFetch(() => ({ status: 500, body: {} }));
    const source = new BinanceSource({ fetch, restBases: ['https://a.test', 'https://b.test'] });
    await expect(source.fetchCandles('BTCUSDT', '1m')).rejects.toThrow(/500/);
  });
});
