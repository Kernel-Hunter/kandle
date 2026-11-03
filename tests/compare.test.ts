import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KLineData } from 'klinecharts';

// The controller registers its indicator with the chart engine; keep the template so the fake chart can run it.
const registered: Record<string, { calc: (data: KLineData[], indicator: unknown) => unknown; createTooltipDataSource: (p: unknown) => unknown }> = {};
vi.mock('klinecharts', () => ({
  registerIndicator: vi.fn((template: { name: string }) => {
    registered[template.name] = template as never;
  }),
  registerOverlay: vi.fn(),
}));

import { COMPARE_INDICATOR, CompareController, digitsFor, type CompareFeeds } from '../src/compare/controller';
import { MAX_COMPARE, alignCloses, anchorIndex, changeSince, rebaseFactor, sanitizeCompare } from '../src/compare/series';
import type { RequestSeries, ResolvedRequest } from '../src/script/security';
import { requestKey } from '../src/script/security';
import { sanitizeLayout } from '../src/store/layout';

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 1);

describe('alignCloses', () => {
  it('takes the last compared bar at or before each chart bar', () => {
    const chart = [T0, T0 + H, T0 + 2 * H, T0 + 3 * H];
    const bars = [
      { timestamp: T0 + H, close: 10 },
      { timestamp: T0 + 3 * H, close: 12 },
    ];
    expect([...alignCloses(chart, bars)]).toEqual([Number.NaN, 10, 10, 12]);
  });

  it('is all NaN without bars', () => {
    expect([...alignCloses([T0, T0 + H], [])]).toEqual([Number.NaN, Number.NaN]);
  });
});

describe('rebasing', () => {
  const main = [100, 110, 120, 90];
  const raw = Float64Array.from([Number.NaN, 2, 3, 1]);

  it('anchors at the first bar where both have a price', () => {
    expect(anchorIndex(raw, main, 0)).toBe(1);
    expect(anchorIndex(raw, main, 2)).toBe(2);
    expect(anchorIndex(raw, main, 9)).toBe(-1);
  });

  it('scales the compared series onto the chart price at the anchor', () => {
    const f = rebaseFactor(raw, main, 1);
    expect(raw[1] * f).toBe(110);
    expect(raw[2] * f).toBe(165);
    expect(rebaseFactor(raw, main, -1)).toBeNaN();
  });

  it('measures change since the anchor in percent', () => {
    expect(changeSince(raw, 1, 2)).toBe(50);
    expect(changeSince(raw, 1, 3)).toBe(-50);
    expect(changeSince(raw, -1, 3)).toBeNull();
    expect(changeSince(raw, 1, 0)).toBeNull();
  });
});

describe('sanitizeCompare', () => {
  it('keeps valid entries once and caps the list', () => {
    const list = sanitizeCompare([
      { source: 'binance', symbol: 'ETHUSDT' },
      { source: 'binance', symbol: 'ETHUSDT' },
      { source: 'kraken', symbol: 'XBT/USD' },
      { source: 'Bad Source', symbol: 'X' },
      { source: 'binance', symbol: 'no spaces' },
      null,
      'ETHUSDT',
      ...['A', 'B', 'C', 'D', 'E'].map((s) => ({ source: 'okx', symbol: `${s}-USDT` })),
    ]);
    expect(list).toHaveLength(MAX_COMPARE);
    expect(list.slice(0, 2)).toEqual([
      { source: 'binance', symbol: 'ETHUSDT' },
      { source: 'kraken', symbol: 'XBT/USD' },
    ]);
    expect(sanitizeCompare('nope')).toEqual([]);
  });

  it('is part of the saved layout', () => {
    expect(sanitizeLayout({ compare: [{ source: 'binance', symbol: 'SOLUSDT' }, { symbol: 'x' }] }).compare).toEqual([{ source: 'binance', symbol: 'SOLUSDT' }]);
    expect(sanitizeLayout({}).compare).toBeUndefined();
    expect(sanitizeLayout({ compareScale: true }).compareScale).toBe(true);
    expect(sanitizeLayout({ compareScale: 'yes' }).compareScale).toBeUndefined();
  });
});

it('formats small prices with more digits', () => {
  expect(digitsFor(77388)).toBe(2);
  expect(digitsFor(1)).toBe(2);
  expect(digitsFor(0.5234)).toBe(4);
  expect(digitsFor(0.00001234)).toBe(8);
});

// ---------------------------------------------------------------- controller

interface FakeIndicator {
  id: string;
  name: string;
  extendData: string;
  calcParams: number[];
  result: Array<{ close?: number }>;
}

/** Enough of a chart for the controller: indicators run their calc right away. */
function fakeChart(closes: number[]) {
  const data: KLineData[] = closes.map((close, i) => ({ timestamp: T0 + i * H, open: close, high: close, low: close, close, volume: 1 }));
  const indicators: FakeIndicator[] = [];
  const actions: Array<() => void> = [];
  let range = { from: 0, to: data.length, realFrom: 0, realTo: data.length };
  let next = 1;
  const run = (ind: FakeIndicator) => {
    ind.result = registered[COMPARE_INDICATOR].calc(data, ind) as FakeIndicator['result'];
  };
  const chart = {
    getDataList: () => data,
    getVisibleRange: () => range,
    createIndicator: (create: { name: string; extendData: string; calcParams: number[] }) => {
      const ind: FakeIndicator = { id: `ind${next++}`, name: create.name, extendData: create.extendData, calcParams: create.calcParams, result: [] };
      indicators.push(ind);
      run(ind);
      return ind.id;
    },
    getIndicators: ({ id }: { id?: string }) => indicators.filter((i) => id === undefined || i.id === id),
    removeIndicator: ({ id }: { id: string }) => {
      const i = indicators.findIndex((x) => x.id === id);
      if (i >= 0) indicators.splice(i, 1);
    },
    overrideIndicator: ({ id, calcParams }: { id: string; calcParams: number[] }) => {
      const ind = indicators.find((x) => x.id === id);
      if (ind) {
        ind.calcParams = calcParams;
        run(ind);
      }
    },
    subscribeAction: (_type: string, fn: () => void) => actions.push(fn),
    unsubscribeAction: vi.fn(),
  };
  return {
    chart,
    indicators,
    /** Scrolls so `from` is the first bar of the visible range, as the engine reports it. */
    scrollTo(from: number) {
      range = { ...range, from, realFrom: from };
      for (const fn of actions) fn();
    },
  };
}

/** Feeds that hold series in memory and load them when the test says so. */
function fakeFeeds() {
  const store = new Map<string, RequestSeries>();
  const listeners = new Set<(key: string) => void>();
  const needed: string[] = [];
  const feeds: CompareFeeds = {
    series: (req) => store.get(requestKey(req)) ?? null,
    need: (req) => void needed.push(requestKey(req)),
    load: async () => undefined,
    onChange: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return {
    feeds,
    needed,
    /** Makes a series available and tells the listeners, like a finished load. */
    put(req: ResolvedRequest, closes: number[], error?: string) {
      const bars = closes.map((close, i) => ({ timestamp: T0 + i * H, open: close, high: close, low: close, close, volume: 1 }));
      store.set(requestKey(req), { bars, version: 1, ...(error ? { error } : {}) });
      for (const fn of listeners) fn(requestKey(req));
    },
  };
}

describe('CompareController', () => {
  const ETH = { source: 'binance', symbol: 'ETHUSDT' };
  const ethReq = { ...ETH, timeframe: '1h' as const };
  let fake: ReturnType<typeof fakeChart>;
  let feeds: ReturnType<typeof fakeFeeds>;
  let changes: unknown[];
  let controller: CompareController;

  beforeEach(() => {
    fake = fakeChart([100, 110, 120, 130]);
    feeds = fakeFeeds();
    changes = [];
    controller = new CompareController({
      chart: () => fake.chart as never,
      paneId: 'candle_pane',
      feeds: feeds.feeds,
      timeframe: () => '1h',
      onChange: (list) => changes.push(list),
    });
  });

  it('draws a compared symbol scaled to the chart at the first visible bar', async () => {
    feeds.put(ethReq, [10, 12, 9, 15]);
    const report = await controller.add(ETH);
    expect(report).toMatchObject({ ...ETH, last: 15, changePercent: 50, loading: false });
    expect(fake.indicators).toHaveLength(1);
    expect(fake.indicators[0].result.map((r) => r.close)).toEqual([100, 120, 90, 150]);
    expect(changes).toEqual([[ETH]]);
    expect(feeds.needed).toContain(requestKey(ethReq));
  });

  it('rescales when the first visible bar changes', async () => {
    feeds.put(ethReq, [10, 12, 9, 15]);
    await controller.add(ETH);
    fake.scrollTo(2);
    // Bar 2: chart 120, ETH 9, so ETH is drawn at 120 there and everything else follows.
    const drawn = fake.indicators[0].result.map((r) => r.close!);
    [10, 12, 9, 15].forEach((eth, i) => expect(drawn[i]).toBeCloseTo((eth * 120) / 9, 9));
    expect(controller.report()[0].changePercent).toBeCloseTo(((15 - 9) / 9) * 100, 6);
  });

  it('fills in a line when its series arrives', async () => {
    await controller.add(ETH);
    expect(controller.report()[0].loading).toBe(true);
    expect(fake.indicators[0].result.every((r) => r.close === undefined)).toBe(true);
    feeds.put(ethReq, [20, 20, 20, 30]);
    expect(fake.indicators[0].result.map((r) => r.close)).toEqual([100, 100, 100, 150]);
  });

  it('reports a series that failed to load', async () => {
    feeds.put(ethReq, [], 'HTTP 400');
    const report = await controller.add(ETH);
    expect(report.error).toBe('HTTP 400');
    expect(report.last).toBeNull();
  });

  it('refuses duplicates and more than the maximum', async () => {
    await controller.add(ETH);
    await expect(controller.add(ETH)).rejects.toThrow('already compared');
    for (const s of ['A', 'B', 'C', 'D']) await controller.add({ source: 'okx', symbol: `${s}-USDT` });
    await expect(controller.add({ source: 'okx', symbol: 'E-USDT' })).rejects.toThrow(`At most ${MAX_COMPARE}`);
    expect(new Set(controller.report().map((r) => r.color)).size).toBe(MAX_COMPARE);
  });

  it('removes one or all lines', async () => {
    await controller.add(ETH);
    await controller.add({ source: 'binance', symbol: 'SOLUSDT' });
    expect(controller.remove({ source: 'binance', symbol: 'XRPUSDT' })).toBe(false);
    expect(controller.remove(ETH)).toBe(true);
    expect(controller.list()).toEqual([{ source: 'binance', symbol: 'SOLUSDT' }]);
    expect(controller.clear()).toBe(1);
    expect(fake.indicators).toHaveLength(0);
    expect(changes.at(-1)).toEqual([]);
  });

  it('restores lines without reporting a change', () => {
    controller.restore([ETH, { source: 'binance', symbol: 'SOLUSDT' }]);
    expect(controller.size).toBe(2);
    expect(changes).toEqual([]);
  });

  it('shows the compared price and change in the legend', async () => {
    feeds.put(ethReq, [10, 12, 9, 15]);
    await controller.add(ETH);
    const tip = registered[COMPARE_INDICATOR].createTooltipDataSource({ indicator: fake.indicators[0], crosshair: { dataIndex: 3 } }) as {
      name: string;
      legends: Array<{ value: { text: string } }>;
    };
    expect(tip.name).toBe('ETHUSDT');
    expect(tip.legends[0].value.text).toBe('15.00  +50.00%');
  });
});
