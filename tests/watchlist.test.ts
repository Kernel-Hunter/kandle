import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderError, RateLimitError } from '../src/data/http';
import type { Ticker, TickerFeed } from '../src/data/tickers';
import type { Candle, DataSource, StreamStatus } from '../src/data/types';
import { MemoryStorage } from '../src/store/layout';
import { WatchlistController, type WatchlistDeps } from '../src/watchlist/controller';
import { autoPrecision, direction, formatChange, formatPercent, formatPrice } from '../src/watchlist/format';
import { DEFAULT_ITEMS, MAX_ITEMS, addItem, loadWatchlist, moveItem, removeItem, sanitizeWatchlist, saveWatchlist } from '../src/watchlist/store';

const KEY = 'kandle:watchlist';

describe('watchlist store', () => {
  it('starts with BTC, ETH and SOL on Binance', () => {
    const config = loadWatchlist(new MemoryStorage());
    expect(config.items).toEqual(DEFAULT_ITEMS);
    expect(config.open).toBe(false);
    expect(loadWatchlist(new MemoryStorage(), undefined, true).open).toBe(true);
  });

  it('saves and loads the list and the panel state', () => {
    const storage = new MemoryStorage();
    const items = [{ source: 'coinbase', symbol: 'BTC-USD' }, { source: 'twelvedata', symbol: 'EUR/USD' }];
    expect(saveWatchlist(storage, { version: 1, open: true, items })).toBe(true);
    expect(loadWatchlist(storage)).toEqual({ version: 1, open: true, items });
    // An empty saved list stays empty instead of coming back as the default.
    saveWatchlist(storage, { version: 1, open: false, items: [] });
    expect(loadWatchlist(storage).items).toEqual([]);
  });

  it('cleans up stored data it cannot use', () => {
    const storage = new MemoryStorage();
    storage.setItem(KEY, '{not json');
    expect(loadWatchlist(storage).items).toEqual(DEFAULT_ITEMS);
    const raw = {
      open: 'yes',
      items: [
        { source: 'binance', symbol: 'BTCUSDT' },
        { source: 'binance', symbol: 'BTCUSDT' },
        { source: 'ftx', symbol: 'BTCUSDT' },
        { source: 'binance', symbol: 'BTC USDT; drop' },
        { source: 'binance' },
        null,
        { source: 'okx', symbol: 'ETH-USDT', extra: 1 },
      ],
    };
    expect(sanitizeWatchlist(raw, (id) => id !== 'ftx')).toEqual({
      version: 1,
      open: false,
      items: [{ source: 'binance', symbol: 'BTCUSDT' }, { source: 'okx', symbol: 'ETH-USDT' }],
    });
    const many = { items: Array.from({ length: MAX_ITEMS + 5 }, (_, i) => ({ source: 'binance', symbol: `C${i}USDT` })) };
    expect(sanitizeWatchlist(many).items).toHaveLength(MAX_ITEMS);
  });

  it('adds, removes and moves rows', () => {
    const items = [...DEFAULT_ITEMS];
    expect(addItem(items, { source: 'binance', symbol: 'BTCUSDT' })).toBeNull();
    expect(addItem(items, { source: 'coinbase', symbol: 'BTC-USD' }, 0)![0]).toEqual({ source: 'coinbase', symbol: 'BTC-USD' });
    expect(addItem(items, { source: 'binance', symbol: 'bad symbol' })).toBeNull();
    const full = Array.from({ length: MAX_ITEMS }, (_, i) => ({ source: 'binance', symbol: `C${i}` }));
    expect(addItem(full, { source: 'binance', symbol: 'XRPUSDT' })).toBeNull();
    expect(removeItem(items, { source: 'binance', symbol: 'ETHUSDT' })!.map((i) => i.symbol)).toEqual(['BTCUSDT', 'SOLUSDT']);
    expect(removeItem(items, { source: 'coinbase', symbol: 'ETHUSDT' })).toBeNull();
    expect(moveItem(items, 0, 2).map((i) => i.symbol)).toEqual(['ETHUSDT', 'SOLUSDT', 'BTCUSDT']);
    expect(moveItem(items, 2, 0).map((i) => i.symbol)).toEqual(['SOLUSDT', 'BTCUSDT', 'ETHUSDT']);
    expect(moveItem(items, 9, 0)).toEqual(items);
  });
});

describe('formatting', () => {
  it('formats prices, changes and percents', () => {
    expect(formatPrice(82608.34, 2)).toBe('82,608.34');
    expect(formatPrice(0.000012345)).toBe('0.00001235');
    expect(formatPrice(106.57)).toBe('106.5700');
    expect(formatPrice(null)).toBe('');
    expect(autoPrecision(2500)).toBe(2);
    expect(formatPercent(0.7781)).toBe('+0.78%');
    expect(formatPercent(-1.234)).toBe('-1.23%');
    expect(formatPercent(-0.001)).toBe('0.00%');
    expect(formatPercent(null)).toBe('');
    expect(formatChange(-637.9, 2)).toBe('-637.90');
    expect(formatChange(52.3, 2)).toBe('+52.30');
    expect(direction(-1)).toBe('down');
    expect(direction(0)).toBe('flat');
    expect(direction(null)).toBe('flat');
  });
});

/** A ticker feed the test drives: it records watch calls and whether each one was stopped. */
function fakeFeed() {
  const runs: Array<{ symbols: string[]; emit: (t: Ticker) => void; status: (s: StreamStatus) => void; stopped: boolean }> = [];
  const feed: TickerFeed = {
    watch(symbols, onTicker, onStatus) {
      const run = { symbols: [...symbols], emit: onTicker, status: (s: StreamStatus) => onStatus?.(s), stopped: false };
      runs.push(run);
      return () => {
        run.stopped = true;
      };
    },
  };
  const live = () => runs.filter((r) => !r.stopped);
  return { feed, runs, live };
}

function polledSource(id: string, bars: (symbol: string) => Candle[] | Error, extra: Partial<DataSource> = {}) {
  const fetchCandles = vi.fn(async (symbol: string) => {
    const out = bars(symbol);
    if (out instanceof Error) throw out;
    return out;
  });
  return { id, name: id, timeframes: ['1D'], fetchCandles, ...extra } as unknown as DataSource & { fetchCandles: typeof fetchCandles };
}

const DAY = 86_400_000;
const bar = (time: number, close: number): Candle => ({ time, open: close, high: close, low: close, close, volume: 1 });

function setup(over: Partial<WatchlistDeps> = {}, sources: DataSource[] = []) {
  const binance = fakeFeed();
  const coinbase = fakeFeed();
  const storage = new MemoryStorage();
  const all = new Map<string, DataSource>([
    ['binance', { id: 'binance', name: 'Binance' } as DataSource],
    ['coinbase', { id: 'coinbase', name: 'Coinbase' } as DataSource],
    ...sources.map((s) => [s.id, s] as [string, DataSource]),
  ]);
  const deps: WatchlistDeps = {
    storage,
    source: (id) => all.get(id),
    hasKey: () => true,
    feeds: { binance: binance.feed, coinbase: coinbase.feed },
    now: () => Date.now(),
    ...over,
  };
  const wl = new WatchlistController(deps);
  return { wl, binance, coinbase, storage };
}

describe('WatchlistController', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('streams only while the panel is open, with one feed per exchange', () => {
    const { wl, binance, storage } = setup();
    wl.start();
    expect(binance.runs).toHaveLength(0);
    wl.setOpen(true);
    expect(binance.live()).toHaveLength(1);
    expect(binance.live()[0].symbols).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
    expect(JSON.parse(storage.getItem(KEY)!).open).toBe(true);
    wl.setOpen(false);
    expect(binance.live()).toHaveLength(0);
    for (let i = 0; i < 5; i++) {
      wl.setOpen(true);
      wl.setOpen(false);
    }
    expect(binance.runs).toHaveLength(6);
    expect(binance.live()).toHaveLength(0);
    expect(wl.running).toBe(false);
  });

  it('starts on load when the saved panel was open', () => {
    const storage = new MemoryStorage();
    storage.setItem(KEY, JSON.stringify({ open: true, items: [{ source: 'binance', symbol: 'BTCUSDT' }] }));
    const { wl, binance } = setup({ storage });
    wl.start();
    expect(binance.live().map((r) => r.symbols)).toEqual([['BTCUSDT']]);
  });

  it('restarts a feed only when its symbols change, not on reorder', () => {
    const { wl, binance, coinbase } = setup();
    wl.setOpen(true);
    wl.move(0, 2);
    expect(binance.runs).toHaveLength(1);
    wl.add({ source: 'coinbase', symbol: 'BTC-USD' });
    expect(binance.runs).toHaveLength(1);
    expect(coinbase.live()[0].symbols).toEqual(['BTC-USD']);
    wl.add({ source: 'binance', symbol: 'XRPUSDT' });
    expect(binance.runs[0].stopped).toBe(true);
    expect(binance.live()[0].symbols).toEqual(['ETHUSDT', 'SOLUSDT', 'BTCUSDT', 'XRPUSDT']);
    wl.remove({ source: 'coinbase', symbol: 'BTC-USD' });
    expect(coinbase.live()).toHaveLength(0);
    expect(wl.add({ source: 'binance', symbol: 'XRPUSDT' })).toBe(false);
    expect(wl.add({ source: 'ftx', symbol: 'XRPUSDT' })).toBe(false);
  });

  it('turns tickers into quotes and reports the 24 h change', () => {
    const { wl, binance } = setup();
    wl.setOpen(true);
    binance.live()[0].emit({ symbol: 'BTCUSDT', price: 82608.34, reference: 81970.44, time: Date.UTC(2026, 9, 20, 17) });
    binance.live()[0].emit({ symbol: 'DOGEUSDT', price: 1, reference: 1, time: 0 });
    const [btc, eth] = wl.report();
    expect(btc).toEqual({
      exchange: 'binance',
      symbol: 'BTCUSDT',
      price: 82608.34,
      change: 637.9,
      change_percent: 0.778,
      basis: '24h',
      updated_at: '2026-10-20T17:00:00.000Z',
      status: 'live',
    });
    expect(eth).toMatchObject({ symbol: 'ETHUSDT', price: null, change: null, status: 'loading' });
    expect(wl.report()).toHaveLength(3);
    wl.setOpen(false);
    expect(wl.report()[0]).toMatchObject({ price: 82608.34, status: 'paused' });
  });

  it('stops after the tab has been hidden for a while and resumes when it is shown', () => {
    const { wl, binance } = setup({ hiddenGraceMs: 60_000 });
    wl.setOpen(true);
    wl.setPageVisible(false);
    vi.advanceTimersByTime(30_000);
    expect(binance.live()).toHaveLength(1);
    // Coming back inside the grace period keeps the same connection.
    wl.setPageVisible(true);
    wl.setPageVisible(false);
    vi.advanceTimersByTime(59_000);
    expect(binance.live()).toHaveLength(1);
    vi.advanceTimersByTime(2_000);
    expect(binance.live()).toHaveLength(0);
    wl.setPageVisible(true);
    expect(binance.live()).toHaveLength(1);
    expect(binance.runs).toHaveLength(2);
  });

  it('wakes the feeds for an agent while the panel is closed, then lets them go', async () => {
    const { wl, binance } = setup();
    const done = wl.refresh(4000, 30_000);
    expect(binance.live()).toHaveLength(1);
    for (const s of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) binance.live()[0].emit({ symbol: s, price: 2, reference: 1, time: 1 });
    await done;
    expect(wl.report().every((r) => r.status === 'live')).toBe(true);
    vi.advanceTimersByTime(29_000);
    expect(binance.live()).toHaveLength(1);
    vi.advanceTimersByTime(2_000);
    expect(binance.live()).toHaveLength(0);
  });

  it('gives up waiting after the timeout', async () => {
    const { wl } = setup();
    const done = wl.refresh(4000, 0);
    await vi.advanceTimersByTimeAsync(4000);
    await done;
    expect(wl.report()[0].status).toBe('loading');
  });

  it('polls sources without a stream for the previous daily close, spaced out', async () => {
    const now = Date.UTC(2026, 9, 20, 15);
    vi.setSystemTime(now);
    const td = polledSource('twelvedata', (s) => (s === 'AAPL' ? [bar(now - DAY, 200), bar(now, 210)] : [bar(now - DAY, 1.1), bar(now, 1.0)]));
    const { wl } = setup({ pollPlan: { twelvedata: { intervalMs: 600_000, spacingMs: 20_000 } } }, [td]);
    wl.add({ source: 'twelvedata', symbol: 'AAPL' });
    wl.add({ source: 'twelvedata', symbol: 'EUR/USD' });
    wl.setOpen(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(td.fetchCandles).toHaveBeenCalledTimes(1);
    expect(td.fetchCandles).toHaveBeenCalledWith('AAPL', '1D', { limit: 2 });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(td.fetchCandles).toHaveBeenCalledTimes(2);
    const rows = wl.report().filter((r) => r.exchange === 'twelvedata');
    expect(rows[0]).toMatchObject({ price: 210, change: 10, change_percent: 5, basis: 'prev_close', status: 'polled' });
    expect(rows[1]).toMatchObject({ price: 1, change_percent: -9.091, basis: 'prev_close' });
    // Nothing more until the interval has passed.
    await vi.advanceTimersByTimeAsync(500_000);
    expect(td.fetchCandles).toHaveBeenCalledTimes(2);
    // Each row comes due again 10 minutes after its last request.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(td.fetchCandles).toHaveBeenCalledTimes(4);
    wl.setOpen(false);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(td.fetchCandles).toHaveBeenCalledTimes(4);
  });

  it('takes a chart price for polled rows and keeps the polled reference', async () => {
    const now = Date.UTC(2026, 9, 20, 15);
    vi.setSystemTime(now);
    const td = polledSource('twelvedata', () => [bar(now - DAY, 200), bar(now, 210)]);
    const { wl, binance } = setup({}, [td]);
    wl.add({ source: 'twelvedata', symbol: 'AAPL' });
    wl.setOpen(true);
    await vi.advanceTimersByTimeAsync(0);
    wl.onChartPrice('twelvedata', 'AAPL', 220, now + 1000);
    expect(wl.report()[3]).toMatchObject({ price: 220, change: 20, status: 'chart' });
    // Streamed rows ignore chart prices, so price and change always come from the same feed.
    binance.live()[0].emit({ symbol: 'BTCUSDT', price: 100, reference: 90, time: 1 });
    wl.onChartPrice('binance', 'BTCUSDT', 101, now);
    expect(wl.report()[0].price).toBe(100);
  });

  it('shows missing keys without asking, and backs off on rate limits', async () => {
    vi.setSystemTime(Date.UTC(2026, 9, 20));
    let calls = 0;
    const polygon = polledSource('polygon', () => (++calls === 1 ? new RateLimitError(30) : [bar(0, 1), bar(DAY, 2)]));
    const alpaca = polledSource('alpaca', () => []);
    const { wl } = setup({ hasKey: (s) => s.id !== 'alpaca', pollPlan: { polygon: { intervalMs: 600_000, spacingMs: 5_000 }, alpaca: { intervalMs: 60_000, spacingMs: 1000 } } }, [polygon, alpaca]);
    wl.add({ source: 'polygon', symbol: 'AAPL' });
    wl.add({ source: 'alpaca', symbol: 'MSFT' });
    wl.setOpen(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(alpaca.fetchCandles).not.toHaveBeenCalled();
    expect(wl.report()[4]).toMatchObject({ status: 'no-key', error: 'Add your alpaca API key in Data sources' });
    expect(polygon.fetchCandles).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(polygon.fetchCandles).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(polygon.fetchCandles).toHaveBeenCalledTimes(2);
    expect(wl.report()[3]).toMatchObject({ price: 2, change_percent: 100 });
  });

  it('reports a refused key and asks again once the key changes', async () => {
    let refuse = true;
    const td = polledSource('twelvedata', () => (refuse ? new ProviderError('Twelve Data rejected the API key.', 'auth', 401) : [bar(0, 1), bar(DAY, 1.5)]));
    const { wl } = setup({}, [td]);
    wl.add({ source: 'twelvedata', symbol: 'AAPL' });
    wl.setOpen(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(wl.report()[3]).toMatchObject({ status: 'no-key', error: 'Twelve Data rejected the API key.' });
    refuse = false;
    wl.keysChanged('twelvedata');
    await vi.advanceTimersByTimeAsync(25_000);
    expect(wl.report()[3]).toMatchObject({ price: 1.5, status: 'polled' });
  });

  it('shows the last close of imported data against the bar before', async () => {
    const t = Date.UTC(2026, 0, 5);
    const csv = polledSource('csv', () => [bar(t - 3_600_000, 50), bar(t, 40)], { local: true, timeframesFor: () => ['1h', '4h', '1D'] });
    const { wl } = setup({}, [csv]);
    wl.add({ source: 'csv', symbol: 'MY-DATA' });
    wl.setOpen(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(csv.fetchCandles).toHaveBeenCalledWith('MY-DATA', '1h', { limit: 2 });
    expect(wl.report()[3]).toEqual({
      exchange: 'csv',
      symbol: 'MY-DATA',
      price: 40,
      change: -10,
      change_percent: -20,
      basis: 'prev_bar',
      updated_at: new Date(t).toISOString(),
      status: 'static',
    });
  });

  it('stops everything when disposed', () => {
    const { wl, binance, coinbase } = setup();
    wl.add({ source: 'coinbase', symbol: 'BTC-USD' });
    wl.setOpen(true);
    expect(binance.live().length + coinbase.live().length).toBe(2);
    wl.dispose();
    expect(binance.live().length + coinbase.live().length).toBe(0);
  });
});
