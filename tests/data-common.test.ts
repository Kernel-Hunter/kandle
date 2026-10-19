import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderError, RateLimitError, RateLimiter, TtlCache, parseRetryAfter, rateLimitMessage, requestJson } from '../src/data/http';
import { KeyStore, keyStorageKey } from '../src/data/keys';
import { applyTick, dayStartInZone, sessionBucketStart, sessionLookback, startPolling } from '../src/data/live';
import { openManagedSocket } from '../src/data/socket';
import { SOURCES, getSource, hasKey, sourceMarkets } from '../src/data/sources';
import { displayName } from '../src/data/search';
import { MemoryStorage } from '../src/store/layout';
import { EXCHANGES } from '../packages/mcp/src/tools';
import type { Candle } from '../src/data/types';
import { fakeFetch, fakeSockets } from './helpers';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('RateLimiter', () => {
  it('allows the per-minute budget, then reports the wait until the oldest request expires', () => {
    let now = 1_000_000;
    const limiter = new RateLimiter({ perMinute: 2, now: () => now });
    limiter.take();
    now += 10_000;
    limiter.take();
    expect(() => limiter.take()).toThrow(RateLimitError);
    try {
      limiter.take();
    } catch (error) {
      expect((error as RateLimitError).retryAfter).toBe(50);
      expect((error as Error).message).toBe('Free plan limit reached, try again in 50 s');
    }
    now += 50_000;
    expect(() => limiter.take()).not.toThrow();
  });

  it('backs off after a 429, doubling until a success resets it', () => {
    let now = 0;
    const limiter = new RateLimiter({ now: () => now });
    expect(limiter.backoff()).toBe(15);
    expect(limiter.wait()).toBe(15);
    now += 15_000;
    expect(limiter.backoff()).toBe(30);
    now += 30_000;
    limiter.success();
    expect(limiter.backoff()).toBe(15);
  });

  it("prefers the server's Retry-After", () => {
    const limiter = new RateLimiter({ now: () => 0 });
    expect(limiter.backoff(7)).toBe(7);
    expect(() => limiter.take()).toThrow('try again in 7 s');
  });
});

describe('TtlCache', () => {
  it('expires entries and evicts the least recently used', () => {
    let now = 0;
    const cache = new TtlCache<number>(1000, 2, () => now);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a');
    cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    now = 2000;
    expect(cache.get('a')).toBeUndefined();
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds and HTTP dates', () => {
    expect(parseRetryAfter('12')).toBe(12);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('0')).toBeUndefined();
  });

  it('formats the user message with whole seconds', () => {
    expect(rateLimitMessage(0.2)).toBe('Free plan limit reached, try again in 1 s');
    expect(rateLimitMessage(41.3)).toBe('Free plan limit reached, try again in 42 s');
  });
});

describe('requestJson', () => {
  it('turns a 429 into a RateLimitError using Retry-After and blocks later calls', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 429, body: { message: 'slow down' }, headers: { 'Retry-After': '20' } }));
    const limiter = new RateLimiter({ now: () => 0 });
    await expect(requestJson({ url: 'https://x.test/a', provider: 'X', fetch, limiter })).rejects.toThrow('try again in 20 s');
    await expect(requestJson({ url: 'https://x.test/a', provider: 'X', fetch, limiter })).rejects.toBeInstanceOf(RateLimitError);
    expect(calls).toHaveLength(1);
  });

  it('reports network failures and HTTP errors with readable messages', async () => {
    const down = fakeFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    await expect(requestJson({ url: 'https://x.test/', provider: 'X', fetch: down.fetch })).rejects.toThrow('X could not be reached');
    const auth = fakeFetch(() => ({ status: 401, body: null, raw: '<html>401</html>' }));
    const err = await requestJson({ url: 'https://x.test/', provider: 'X', fetch: auth.fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe('auth');
    expect((err as Error).message).toContain('rejected the API key');
  });

  it('caches successful responses by key', async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { ok: 1 } }));
    const cache = new TtlCache<unknown>(60_000);
    await requestJson({ url: 'https://x.test/a', provider: 'X', fetch, cache });
    expect(await requestJson({ url: 'https://x.test/a', provider: 'X', fetch, cache })).toEqual({ ok: 1 });
    expect(calls).toHaveLength(1);
  });

  it('lets a provider flag errors that arrive with HTTP 200', async () => {
    const { fetch } = fakeFetch(() => ({ body: { code: 429 } }));
    const limiter = new RateLimiter({ now: () => 0 });
    await expect(
      requestJson({ url: 'https://x.test/', provider: 'X', fetch, limiter, classify: (_s, b) => ((b as { code: number }).code === 429 ? { kind: 'rate', retryAfter: 33 } : null) }),
    ).rejects.toThrow('try again in 33 s');
  });
});

describe('KeyStore', () => {
  it('keeps keys under the app prefix, trims them and clears empty values', () => {
    const storage = new MemoryStorage();
    const store = new KeyStore(storage);
    const changes: string[] = [];
    store.onChange((id) => changes.push(id));
    store.set('twelvedata', { apiKey: '  abc  ' });
    expect(storage.getItem(keyStorageKey('twelvedata'))).toBe('{"apiKey":"abc"}');
    expect(keyStorageKey('twelvedata')).toBe('kandle:apikey:twelvedata');
    expect(store.has('twelvedata', ['apiKey'])).toBe(true);
    expect(store.has('alpaca', ['keyId'])).toBe(false);
    store.set('twelvedata', { apiKey: 'abc' });
    expect(changes).toEqual(['twelvedata']);
    store.set('twelvedata', { apiKey: '   ' });
    expect(store.get('twelvedata')).toBeNull();
    store.clear('twelvedata');
    expect(changes).toEqual(['twelvedata', 'twelvedata']);
  });

  it('ignores corrupt entries', () => {
    const storage = new MemoryStorage();
    storage.setItem(keyStorageKey('x'), '{nope');
    expect(new KeyStore(storage).get('x')).toBeNull();
    storage.setItem(keyStorageKey('x'), '["a"]');
    expect(new KeyStore(storage).get('x')).toBeNull();
  });
});

describe('market hours', () => {
  it('puts a New York evening trade on its trading date', () => {
    // 2026-10-14 23:30 UTC is 19:30 in New York, still the 14th there.
    expect(dayStartInZone(Date.UTC(2026, 9, 14, 23, 30), 'America/New_York')).toBe(Date.UTC(2026, 9, 14));
    expect(dayStartInZone(Date.UTC(2026, 9, 14, 23, 30), 'UTC')).toBe(Date.UTC(2026, 9, 14));
    expect(dayStartInZone(Date.UTC(2026, 9, 15, 0, 30), 'America/New_York')).toBe(Date.UTC(2026, 9, 14));
  });

  it('keeps the session offset of intraday bars (09:30 open gives :30 hourly bars)', () => {
    const anchor = Date.UTC(2026, 9, 14, 13, 30);
    expect(sessionBucketStart('1h', Date.UTC(2026, 9, 14, 15, 10), anchor)).toBe(Date.UTC(2026, 9, 14, 14, 30));
    // The next morning, across the overnight gap.
    expect(sessionBucketStart('1h', Date.UTC(2026, 9, 15, 13, 45), anchor)).toBe(Date.UTC(2026, 9, 15, 13, 30));
    expect(sessionBucketStart('1h', Date.UTC(2026, 9, 15, 13, 45))).toBe(Date.UTC(2026, 9, 15, 13));
    expect(sessionBucketStart('1W', Date.UTC(2026, 9, 15, 15), undefined, 'America/New_York')).toBe(Date.UTC(2026, 9, 12));
  });

  it('never creates bars for the hours or days without trades', () => {
    const fri: Candle = { time: Date.UTC(2026, 9, 16, 19, 30), open: 10, high: 11, low: 9, close: 10.5, volume: 100 };
    // The next trade is on Monday morning: one new bar, nothing for the weekend.
    const mon = applyTick(fri, '1h', { price: 12, size: 5, time: Date.UTC(2026, 9, 19, 13, 31) }, 'America/New_York');
    expect(mon).toEqual({ time: Date.UTC(2026, 9, 19, 13, 30), open: 12, high: 12, low: 12, close: 12, volume: 5 });
    const same = applyTick(fri, '1h', { price: 12, size: 2, time: Date.UTC(2026, 9, 16, 19, 59) }, 'America/New_York');
    expect(same).toMatchObject({ time: fri.time, high: 12, close: 12, volume: 102 });
    // A late trade for an older bar is ignored.
    expect(applyTick(fri, '1h', { price: 1, size: 1, time: Date.UTC(2026, 9, 16, 18) })).toBe(fri);
  });

  it('sizes lookback windows to cover nights and weekends', () => {
    expect(sessionLookback('1D', 100)).toBe(160 * DAY);
    expect(sessionLookback('1h', 16)).toBeGreaterThanOrEqual(36 * HOUR + 5 * DAY);
  });
});

describe('startPolling', () => {
  afterEach(() => vi.useRealTimers());

  it('emits new bars, skips older ones, and waits out rate limits', async () => {
    vi.useFakeTimers();
    const got: number[] = [];
    const errors: string[] = [];
    let call = 0;
    const stop = startPolling({
      intervalMs: 1000,
      poll: async () => {
        call += 1;
        if (call === 2) throw new RateLimitError(30);
        if (call === 1) return [{ time: 2, open: 1, high: 1, low: 1, close: 1, volume: 0 }];
        return [
          { time: 1, open: 1, high: 1, low: 1, close: 1, volume: 0 },
          { time: 3, open: 1, high: 1, low: 1, close: 1, volume: 0 },
        ];
      },
      onCandle: (c) => got.push(c.time),
      onError: (m) => errors.push(m),
    });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(errors).toEqual(['Free plan limit reached, try again in 30 s']);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(call).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(got).toEqual([2, 3]);
    stop();
  });
});

describe('startPolling with a refused key', () => {
  afterEach(() => vi.useRealTimers());

  it('stops instead of retrying forever', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const statuses: string[] = [];
    startPolling({
      intervalMs: 1000,
      poll: async () => {
        calls += 1;
        throw new ProviderError('X rejected the API key.', 'auth', 401);
      },
      onCandle: () => undefined,
      onStatus: (s) => statuses.push(s),
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toBe(1);
    expect(statuses).toEqual(['polling', 'closed']);
  });
});

describe('openManagedSocket heartbeat', () => {
  afterEach(() => vi.useRealTimers());

  it('pings while open and stops after close', () => {
    vi.useFakeTimers();
    const { factory, last } = fakeSockets();
    const stop = openManagedSocket({ url: 'wss://x.test', factory, onMessage: () => undefined, heartbeat: { intervalMs: 1000, message: 'ping' } });
    last().open();
    vi.advanceTimersByTime(2500);
    expect(last().sent).toEqual(['ping', 'ping']);
    stop();
    vi.advanceTimersByTime(5000);
    expect(last().sent).toHaveLength(2);
  });
});

describe('source registry', () => {
  it('lists the keyless exchanges and the keyed providers with sign-up links', () => {
    expect(SOURCES.map((s) => s.id)).toEqual(['binance', 'coinbase', 'bybit', 'okx', 'kraken', 'twelvedata', 'alpaca', 'polygon', 'csv']);
    for (const s of SOURCES.filter((x) => x.auth)) expect(s.auth!.signupUrl).toMatch(/^https:\/\//);
    expect(sourceMarkets(getSource('binance'))).toEqual(['crypto']);
    expect(sourceMarkets(getSource('twelvedata'))).toContain('forex');
    expect(hasKey(getSource('kraken'))).toBe(true);
    expect(getSource('nope').id).toBe('binance');
    // The MCP tool schema accepts exactly the registered sources.
    expect([...EXCHANGES]).toEqual(SOURCES.map((s) => s.id));
  });

  it('labels stocks by ticker and pairs by base and quote', () => {
    expect(displayName({ symbol: 'AAPL', base: 'AAPL', quote: 'USD', pricePrecision: 2, volumePrecision: 0, market: 'stock' })).toBe('AAPL');
    expect(displayName({ symbol: 'EUR/USD', base: 'EUR', quote: 'USD', pricePrecision: 5, volumePrecision: 0, market: 'forex' })).toBe('EUR/USD');
    expect(displayName({ symbol: 'BTCUSDT', base: 'BTC', quote: 'USDT', pricePrecision: 2, volumePrecision: 4 })).toBe('BTC/USDT');
    expect(displayName({ symbol: 'MY-DATA', base: 'My data', quote: '', pricePrecision: 2, volumePrecision: 0 })).toBe('My data');
  });
});
