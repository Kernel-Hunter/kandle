import { describe, expect, it, vi } from 'vitest';
import type { DataLoader, DataLoaderGetBarsParams, KLineData } from 'klinecharts';
import { SwitchingLoader } from '../src/replay/loader';
import { ReplaySession, indexAtTime, stepInterval } from '../src/replay/session';

const bar = (i: number): KLineData => ({ timestamp: i * 1000, open: i, high: i + 1, low: i - 1, close: i + 0.5, volume: 10 });
const bars = (n: number) => Array.from({ length: n }, (_, i) => bar(i));

describe('indexAtTime', () => {
  it('finds the bar containing a time', () => {
    const list = bars(10);
    expect(indexAtTime(list, 0)).toBe(0);
    expect(indexAtTime(list, 3500)).toBe(3);
    expect(indexAtTime(list, 9000)).toBe(9);
    expect(indexAtTime(list, 99_000)).toBe(9);
    expect(indexAtTime(list, -1)).toBe(-1);
    expect(indexAtTime([], 5)).toBe(-1);
  });
});

describe('ReplaySession', () => {
  it('only exposes bars up to the cursor', () => {
    const s = new ReplaySession(bars(10), 4);
    expect(s.visible().map((b) => b.timestamp)).toEqual([0, 1000, 2000, 3000, 4000]);
    expect(s.current().timestamp).toBe(4000);
    expect(s.remaining).toBe(5);
    expect(s.total).toBe(10);
  });

  it('steps forward and stops at the end', () => {
    const s = new ReplaySession(bars(10), 4);
    expect(s.step().map((b) => b.timestamp)).toEqual([5000]);
    expect(s.step(3).map((b) => b.timestamp)).toEqual([6000, 7000, 8000]);
    expect(s.step(50).map((b) => b.timestamp)).toEqual([9000]);
    expect(s.done).toBe(true);
    expect(s.step()).toEqual([]);
    expect(s.visible()).toHaveLength(10);
  });

  it('copies bars so callers cannot change the hidden future', () => {
    const source = bars(5);
    const s = new ReplaySession(source, 1);
    source[2].close = 999;
    s.visible()[0].close = 999;
    expect(s.step()[0].close).toBe(2.5);
    expect(s.visible()[0].close).toBe(0.5);
    expect(s.all()).toHaveLength(5);
  });

  it('rejects start points that leave nothing to replay', () => {
    expect(() => new ReplaySession(bars(5), 4)).toThrow();
    expect(() => new ReplaySession(bars(5), -1)).toThrow();
    expect(() => new ReplaySession(bars(1), 0)).toThrow();
  });

  it('maps speed to an interval', () => {
    expect(stepInterval(1)).toBe(1000);
    expect(stepInterval(10)).toBe(100);
    expect(stepInterval(50)).toBe(100);
    expect(stepInterval(0)).toBe(1000);
  });
});

function params(type: 'init' | 'forward', ticker = 'BTCUSDT') {
  const callback = vi.fn<(data: KLineData[], more?: unknown) => void>();
  return {
    params: { type, timestamp: null, symbol: { ticker, pricePrecision: 2, volumePrecision: 2 }, period: { type: 'hour', span: 1 }, callback } as DataLoaderGetBarsParams,
    callback,
  };
}

function fakeLive() {
  const pending: Array<DataLoaderGetBarsParams> = [];
  const subscribed: Array<(b: KLineData) => void> = [];
  const live: DataLoader = {
    getBars: (p) => {
      pending.push(p);
    },
    subscribeBar: (p) => {
      subscribed.push(p.callback);
    },
    unsubscribeBar: vi.fn(),
  };
  return { live, pending, subscribed };
}

describe('SwitchingLoader', () => {
  it('passes through to the live loader', () => {
    const { live, pending } = fakeLive();
    const loader = new SwitchingLoader(live);
    const { params: p, callback } = params('init');
    loader.getBars(p);
    pending[0].callback([bar(1)], false);
    expect(callback).toHaveBeenCalledWith([bar(1)], false);
  });

  it('serves the replay feed and pushes stepped bars', () => {
    const { live, pending } = fakeLive();
    const loader = new SwitchingLoader(live);
    const session = new ReplaySession(bars(10), 3);
    loader.enterReplay({ initial: () => session.visible(), context: { ticker: 'BTCUSDT', period: { type: 'hour', span: 1 } } });
    const { params: p, callback } = params('init');
    loader.getBars(p);
    expect(pending).toHaveLength(0);
    expect(callback.mock.calls[0][0]).toHaveLength(4);
    const pushed = vi.fn();
    loader.subscribeBar({ symbol: p.symbol, period: p.period, callback: pushed });
    for (const b of session.step(2)) loader.push(b);
    expect(pushed.mock.calls.map((c) => (c[0] as KLineData).timestamp)).toEqual([4000, 5000]);
    const older = params('forward');
    loader.getBars(older.params);
    expect(older.callback).toHaveBeenCalledWith([], false);
  });

  it('drops a slow live response once replay has started', () => {
    const { live, pending } = fakeLive();
    const loader = new SwitchingLoader(live);
    const first = params('init');
    loader.getBars(first.params);
    loader.enterReplay({ initial: () => bars(3), context: { ticker: 'BTCUSDT', period: { type: 'hour', span: 1 } } });
    const second = params('init');
    loader.getBars(second.params);
    pending[0].callback(bars(500), false); // the old live request finally answers
    expect(first.callback).not.toHaveBeenCalled();
    expect(second.callback.mock.calls[0][0]).toHaveLength(3);
  });

  it('leaves replay when the symbol changes', () => {
    const { live, pending } = fakeLive();
    const loader = new SwitchingLoader(live);
    const interrupted = vi.fn();
    loader.onReplayInterrupted(interrupted);
    loader.enterReplay({ initial: () => bars(3), context: { ticker: 'BTCUSDT', period: { type: 'hour', span: 1 } } });
    loader.getBars(params('init', 'ETHUSDT').params);
    expect(interrupted).toHaveBeenCalledOnce();
    expect(loader.replaying).toBe(false);
    expect(pending).toHaveLength(1);
  });

  it('reports context changes and finished loads', async () => {
    const { live, pending } = fakeLive();
    const loader = new SwitchingLoader(live);
    const contexts: string[] = [];
    loader.onContext((c) => contexts.push(c.ticker));
    const loaded = loader.nextLoad(1000);
    loader.getBars(params('init', 'SOLUSDT').params);
    pending[0].callback(bars(7), false);
    await expect(loaded).resolves.toBe(7);
    expect(contexts).toEqual(['SOLUSDT']);
  });

  it('times out waiting for a load', async () => {
    vi.useFakeTimers();
    const loader = new SwitchingLoader(fakeLive().live);
    const waiting = loader.nextLoad(100);
    vi.advanceTimersByTime(150);
    await expect(waiting).rejects.toThrow(/Timed out/);
    vi.useRealTimers();
  });
});
