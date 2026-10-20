import { describe, expect, it } from 'vitest';
import { MAX_FEED_BARS, SeriesFeeds, WARMUP_BARS } from '../src/data/feeds';
import { RateLimitError } from '../src/data/http';
import type { TimeframeId } from '../src/data/timeframes';
import type { Candle, DataSource, FetchCandlesOptions, SourceAuth } from '../src/data/types';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 1);

/** A source with `total` daily bars ending at NOW that pages like an exchange API. */
function fakeSource(total: number, extra: Partial<DataSource> & { auth?: SourceAuth } = {}) {
  const all: Candle[] = Array.from({ length: total }, (_, i) => {
    const time = NOW - (total - 1 - i) * DAY;
    return { time, open: i, high: i + 1, low: i - 1, close: i + 0.5, volume: 10 };
  });
  const calls: FetchCandlesOptions[] = [];
  let push: ((c: Candle) => void) | null = null;
  let subscriptions = 0;
  let fail: Error | null = null;
  const source: DataSource = {
    id: 'fake',
    name: 'Fake',
    timeframes: ['1D'] as TimeframeId[],
    listSymbols: async () => [],
    getSymbol: async () => null,
    fetchCandles: async (_symbol, _tf, options = {}) => {
      calls.push(options);
      if (fail) throw fail;
      const limit = Math.min(options.limit ?? 500, 1000);
      const older = all.filter((c) => options.before === undefined || c.time < options.before);
      return older.slice(-limit);
    },
    subscribe: (_s, _tf, onCandle) => {
      subscriptions++;
      push = onCandle;
      return () => {
        subscriptions--;
        push = null;
      };
    },
    ...extra,
  };
  return {
    source,
    calls,
    all,
    push: (c: Candle) => push?.(c),
    subscriptions: () => subscriptions,
    failWith: (e: Error | null) => {
      fail = e;
    },
  };
}

const REQ = { source: 'fake', symbol: 'ETHUSDT', timeframe: '1D' as TimeframeId };

function feedsFor(source: DataSource, now = () => NOW) {
  return new SeriesFeeds({ source: (id) => (id === source.id ? source : undefined), now });
}

describe('request series feeds', () => {
  it('loads the latest page, then older pages back to the warm-up before the chart', async () => {
    const fake = fakeSource(3000);
    const feeds = feedsFor(fake.source);
    const changed: string[] = [];
    feeds.onChange((k) => changed.push(k));
    expect(feeds.series(REQ)).toBeNull();
    const chartStart = NOW - 800 * DAY;
    await feeds.load(REQ, chartStart);
    const s = feeds.series(REQ)!;
    expect(s.bars[0].timestamp).toBeLessThanOrEqual(chartStart - WARMUP_BARS * DAY);
    expect(s.bars[s.bars.length - 1].timestamp).toBe(NOW);
    expect(fake.calls).toEqual([{ limit: 1000 }, { before: NOW - 999 * DAY, limit: 1000 }]);
    expect(changed).toEqual(['fake|ETHUSDT|1D']);
    // Already covered: no more requests.
    feeds.need(REQ, chartStart);
    await feeds.load(REQ, chartStart);
    expect(fake.calls).toHaveLength(2);
  });

  it('extends history when the chart scrolls back, up to the bar limit', async () => {
    const fake = fakeSource(9000);
    const feeds = feedsFor(fake.source);
    await feeds.load(REQ, NOW - 100 * DAY);
    expect(fake.calls).toHaveLength(1);
    await feeds.load(REQ, NOW - 8000 * DAY);
    expect(feeds.series(REQ)!.bars.length).toBe(MAX_FEED_BARS);
  });

  it('stops at the start of history', async () => {
    const fake = fakeSource(300);
    const feeds = feedsFor(fake.source);
    await feeds.load(REQ, NOW - 200 * DAY);
    expect(feeds.series(REQ)!.bars).toHaveLength(300);
    await feeds.load(REQ, NOW - 2000 * DAY);
    expect(fake.calls).toHaveLength(2);
  });

  it('reports a failed first load and retries later', async () => {
    const fake = fakeSource(100);
    let now = NOW;
    const feeds = feedsFor(fake.source, () => now);
    fake.failWith(new RateLimitError(20));
    await feeds.load(REQ, NOW);
    expect(feeds.series(REQ)!.error).toBe('Free plan limit reached, try again in 20 s');
    await feeds.load(REQ, NOW);
    expect(fake.calls).toHaveLength(1);
    fake.failWith(null);
    now += 21_000;
    await feeds.load(REQ, NOW);
    expect(feeds.series(REQ)!.error).toBeUndefined();
    expect(feeds.series(REQ)!.bars).toHaveLength(100);
  });

  it('keeps keyless series live and drops idle streams', async () => {
    const fake = fakeSource(50);
    let now = NOW;
    const feeds = feedsFor(fake.source, () => now);
    feeds.need(REQ, NOW - 10 * DAY);
    await feeds.load(REQ, NOW - 10 * DAY);
    expect(fake.subscriptions()).toBe(1);
    const v = feeds.series(REQ)!.version;
    fake.push({ time: NOW, open: 1, high: 2, low: 0, close: 1.5, volume: 3 });
    fake.push({ time: NOW + DAY, open: 2, high: 3, low: 1, close: 2.5, volume: 4 });
    const s = feeds.series(REQ)!;
    expect(s.version).toBeGreaterThan(v);
    expect(s.bars.slice(-2).map((b) => b.close)).toEqual([1.5, 2.5]);
    now += 3 * 60_000;
    feeds.sweep();
    expect(fake.subscriptions()).toBe(0);
  });

  it('catches up and streams again when an idle series is needed again', async () => {
    const fake = fakeSource(50);
    let now = NOW;
    const feeds = feedsFor(fake.source, () => now);
    const changed: string[] = [];
    feeds.onChange((k) => changed.push(k));
    await feeds.load(REQ, NOW - 10 * DAY);
    now += 3 * 60_000;
    feeds.sweep();
    expect(fake.subscriptions()).toBe(0);
    // Two days passed while nothing used the series.
    fake.all.push({ time: NOW + DAY, open: 50, high: 51, low: 49, close: 50.5, volume: 10 }, { time: NOW + 2 * DAY, open: 51, high: 52, low: 50, close: 51.5, volume: 10 });
    const calls = fake.calls.length;
    feeds.need(REQ, NOW - 10 * DAY);
    await feeds.load(REQ, NOW - 10 * DAY);
    expect(fake.calls.slice(calls)).toEqual([{ limit: 1000 }]);
    const s = feeds.series(REQ)!;
    expect(s.bars.slice(-3).map((b) => b.timestamp)).toEqual([NOW, NOW + DAY, NOW + 2 * DAY]);
    expect(s.bars).toHaveLength(52);
    expect(fake.subscriptions()).toBe(1);
    expect(changed).toEqual(['fake|ETHUSDT|1D', 'fake|ETHUSDT|1D']);
    // Streaming again: nothing more to fetch.
    feeds.need(REQ, NOW - 10 * DAY);
    expect(fake.calls.length).toBe(calls + 1);
  });

  it('refreshes keyed series slowly instead of streaming', async () => {
    const auth: SourceAuth = { fields: [{ id: 'key', label: 'Key' }], signupUrl: 'https://example.com', plan: 'Free' };
    const fake = fakeSource(50, { auth });
    let now = NOW + 1000;
    const feeds = feedsFor(fake.source, () => now);
    await feeds.load(REQ, NOW - 10 * DAY);
    expect(fake.subscriptions()).toBe(0);
    // The first page and one older page that came back empty.
    expect(fake.calls).toHaveLength(2);
    feeds.need(REQ, NOW - 10 * DAY);
    expect(fake.calls).toHaveLength(2);
    now += 6 * 60_000;
    feeds.need(REQ, NOW - 10 * DAY);
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[2]).toEqual({ limit: 50 });
  });

  it('knows which sources exist', () => {
    const feeds = feedsFor(fakeSource(1).source);
    expect(feeds.hasSource('fake')).toBe(true);
    expect(feeds.hasSource('nasdaq')).toBe(false);
  });
});
