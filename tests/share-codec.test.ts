import { describe, expect, it, vi } from 'vitest';
import { DRAWING_TOOLS } from '../src/chart/overlays';
import {
  CSV_NOTE,
  DEFAULT_INCLUDE,
  LIMITS,
  MAX_FRAGMENT,
  SHARE_HASH,
  ShareError,
  decodeShareHash,
  encodeShared,
  parseInclude,
  parseShared,
  pickShared,
  shareUrl,
  toBase64Url,
  toWire,
  type SharedChart,
} from '../src/share/codec';
import { ALL, ALL_DRAWINGS, H, PAGE, T0, snapshot } from './shareFixtures';

// The chart engine touches `window` on import; these modules only need the catalogs.
vi.mock('klinecharts', () => ({ registerIndicator: vi.fn(), registerOverlay: vi.fn() }));

/** Encodes then decodes, as opening the link would. */
async function roundTrip(chart: SharedChart, compress?: boolean) {
  const payload = await encodeShared(chart, compress);
  return decodeShareHash(`${SHARE_HASH}${payload}`);
}

/** A hash that carries `value` as plain (uncompressed) JSON. */
const plainHash = (value: unknown) => `${SHARE_HASH}j${toBase64Url(new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)))}`;
const base = { v: 1, s: 'binance', y: 'ETHUSDT', t: '4h' };

describe('share links: round trips', () => {
  it.each([true, false])('keep everything a chart can carry (compressed: %s)', async (compress) => {
    const { chart } = pickShared(snapshot(), ALL);
    const back = await roundTrip(chart, compress);
    expect(back.notes).toEqual([]);
    expect(back.chart).toEqual(chart);
  });

  it('keep every drawing type with its exact points and note text', async () => {
    const { chart } = pickShared(snapshot(), { ...DEFAULT_INCLUDE });
    const back = await roundTrip(chart);
    expect(back.chart.drawings).toHaveLength(DRAWING_TOOLS.length);
    expect(back.chart.drawings).toEqual(ALL_DRAWINGS);
    expect(new Set(back.chart.drawings!.map((d) => d.name))).toEqual(new Set(DRAWING_TOOLS.map((t) => t.overlay)));
  });

  it('keep indicators with their parameters, in order, duplicates included', async () => {
    const indicators = [{ name: 'RSI', params: [14] }, { name: 'RSI', params: [7] }, { name: 'VWAP', params: [] }, { name: 'ICHIMOKU', params: [9, 26, 52, 26] }];
    const back = await roundTrip(pickShared(snapshot({ indicators }), DEFAULT_INCLUDE).chart);
    expect(back.chart.indicators).toEqual(indicators);
  });

  it('keep scripts with inputs and strategy settings, without their local ids', async () => {
    const back = await roundTrip(pickShared(snapshot(), { ...DEFAULT_INCLUDE, scripts: true }).chart);
    expect(back.chart.scripts).toEqual([
      { source: snapshot().scripts[0].source, inputs: { Length: 34 } },
      { source: snapshot().scripts[1].source, inputs: { Show: true, Symbol: 'BINANCE:SOLUSDT' }, strategy: { initialCapital: 5000, commissionValue: 0.1, defaultQtyType: 'percent_of_equity' } },
    ]);
  });

  it('keep the multi-chart layout with each chart and the sync settings', async () => {
    const back = await roundTrip(pickShared(snapshot(), { ...DEFAULT_INCLUDE, layout: true }).chart);
    expect(back.chart.layout).toEqual({
      count: 4,
      sync: { crosshair: true, timeframe: true, symbol: false },
      panes: snapshot().layout.panes,
    });
  });

  it('only carry the charts a 2 chart layout shows', async () => {
    const snap = snapshot();
    const back = await roundTrip(pickShared({ ...snap, layout: { ...snap.layout, count: 2 } }, ALL).chart);
    expect(back.chart.layout?.panes).toEqual([snap.layout.panes[0]]);
  });

  it('keep the chart type, scale and range, and a range at the latest bar', async () => {
    const back = await roundTrip(pickShared(snapshot(), DEFAULT_INCLUDE).chart);
    expect(back.chart.style).toEqual({ type: 'heikin_ashi', scale: 'log' });
    expect(back.chart.range).toEqual({ time: T0 + 40 * H, barSpace: 8.5 });
    const live = await roundTrip(pickShared(snapshot({ range: { time: null, barSpace: 6 } }), DEFAULT_INCLUDE).chart);
    expect(live.chart.range).toEqual({ time: null, barSpace: 6 });
  });

  it('leave out what was not picked', async () => {
    const none = { chart: false, indicators: false, drawings: false, scripts: false, layout: false };
    const { chart } = pickShared(snapshot(), none);
    expect(chart).toEqual({ source: 'binance', symbol: 'ETHUSDT', timeframe: '4h' });
    expect(Object.keys(toWire(chart)).sort()).toEqual(['s', 't', 'v', 'y']);
    expect((await roundTrip(chart)).chart).toEqual(chart);
  });

  it('replace any fragment already on the page address', () => {
    expect(shareUrl(`${PAGE}#s=zOLD`, 'zNEW')).toBe(`${PAGE}#s=zNEW`);
    expect(shareUrl('http://localhost:5280/', 'jAAA')).toBe('http://localhost:5280/#s=jAAA');
  });
});

describe('share links: what can be shared', () => {
  it('refuse a CSV chart', () => {
    expect(() => pickShared(snapshot({ source: 'csv', symbol: 'MY-DATA' }), DEFAULT_INCLUDE)).toThrow(CSV_NOTE);
  });

  it('leave out a layout with a CSV chart in it, and say so', () => {
    const snap = snapshot();
    snap.layout.panes[1] = { source: 'csv', symbol: 'MY-DATA', timeframe: '1h', indicators: [] };
    const { chart, notes } = pickShared(snap, ALL);
    expect(chart.layout).toBeUndefined();
    expect(notes[0]).toMatch(/CSV/);
  });

  it('read include options strictly', () => {
    expect(parseInclude(undefined)).toEqual(DEFAULT_INCLUDE);
    expect(parseInclude({ scripts: true, drawings: false })).toEqual({ ...DEFAULT_INCLUDE, scripts: true, drawings: false });
    expect(() => parseInclude({ script: true })).toThrow(/Unknown include option script/);
    expect(() => parseInclude({ scripts: 'yes' })).toThrow(/true or false/);
    expect(() => parseInclude([true])).toThrow(/object/);
  });
});

describe('share links: versions and broken links', () => {
  it('ask for a reload when a newer version made the link', async () => {
    await expect(decodeShareHash(plainHash({ ...base, v: 2 }))).rejects.toThrow(/newer version of Kandle/);
  });

  it.each([
    ['no version', { s: 'binance', y: 'ETHUSDT', t: '4h' }],
    ['a text version', { ...base, v: '1' }],
    ['version 0', { ...base, v: 0 }],
    ['a fractional version', { ...base, v: 1.5 }],
  ])('refuse %s', async (_name, value) => {
    await expect(decodeShareHash(plainHash(value))).rejects.toThrow(/no valid version/);
  });

  it.each([
    ['another hash', '#section', /not a Kandle chart link/],
    ['an unknown mode', `${SHARE_HASH}qAAAA`, /does not start like a chart link/],
    ['characters outside base64url', `${SHARE_HASH}zAB+/==`, /characters a link cannot have/],
    ['a cut base64 string', `${SHARE_HASH}jA`, /cut short/],
    ['broken compressed data', `${SHARE_HASH}z${toBase64Url(new Uint8Array([1, 2, 3, 250, 251, 252, 253]))}`, /compressed data is broken/],
    ['text that is not JSON', plainHash('{"v":1,'), /not valid JSON/],
    ['invalid UTF-8', `${SHARE_HASH}j${toBase64Url(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]))}`, /not valid JSON/],
    ['a list', plainHash([1, 2]), /not a chart/],
    ['null', plainHash(null), /not a chart/],
  ])('refuse %s', async (_name, hash, message) => {
    const result = decodeShareHash(hash as string);
    await expect(result).rejects.toBeInstanceOf(ShareError);
    await expect(result).rejects.toThrow(message as RegExp);
  });

  it('ignore fields it does not know', () => {
    const { chart } = parseShared({ ...base, extra: { deep: [1, 2, 3] }, zz: 'x' });
    expect(chart).toEqual({ source: 'binance', symbol: 'ETHUSDT', timeframe: '4h' });
  });

  it('leave out indicators and drawings from a newer version, and say so', () => {
    const { chart, notes } = parseShared({ ...base, i: [['RSI', [14]], ['FUTURE', [1]]], d: [['segment', [T0, 1, T0 + H, 2]], ['spiral', [T0, 1]]] });
    expect(chart.indicators).toEqual([{ name: 'RSI', params: [14] }]);
    expect(chart.drawings).toEqual([{ name: 'segment', points: [{ timestamp: T0, value: 1 }, { timestamp: T0 + H, value: 2 }] }]);
    expect(notes).toHaveLength(2);
  });
});

describe('share links: hostile input', () => {
  const bad = (value: Record<string, unknown>) => () => parseShared({ ...base, ...value });

  it('refuse wrong types in every section', () => {
    expect(bad({ s: 42 })).toThrow(ShareError);
    expect(bad({ s: 'nasdaq' })).toThrow(/unknown data source/);
    expect(bad({ y: 'ETH USDT"><script>' })).toThrow(/invalid symbol/);
    expect(bad({ y: 'X'.repeat(41) })).toThrow(/invalid symbol/);
    expect(bad({ t: '2h' })).toThrow(/unknown timeframe/);
    expect(bad({ k: 'renko', a: 'log' })).toThrow(/chart type/);
    expect(bad({ k: 'line' })).toThrow(/price scale/);
    expect(bad({ r: [T0, 0] })).toThrow(/bar spacing/);
    expect(bad({ r: [T0, 51] })).toThrow(/bar spacing/);
    expect(bad({ r: ['yesterday', 8] })).toThrow(/visible range/);
    expect(bad({ i: { RSI: [14] } })).toThrow(/indicators must be a list/);
    expect(bad({ i: [['RSI', ['14']]] })).toThrow(/indicator parameter/);
    expect(bad({ i: [['RSI', [1e9]]] })).toThrow(/indicator parameter/);
    expect(bad({ i: [['RSI', [Number.MAX_VALUE]]] })).toThrow(/indicator parameter/);
    expect(bad({ d: 'segment' })).toThrow(/drawings must be a list/);
    expect(bad({ d: [['segment', [T0, 1, T0]]] })).toThrow(/odd number/);
    expect(bad({ d: [['segment', []]] })).toThrow(/odd number/);
    expect(bad({ d: [['segment', [-1, 1]]] })).toThrow(/drawing time/);
    expect(bad({ d: [['segment', [T0, '1']]] })).toThrow(/drawing price/);
    expect(bad({ d: [['textNote', [T0, 1], { html: '<img>' }]] })).toThrow(/note/);
    expect(bad({ x: [{ c: 42 }] })).toThrow(/a script must be text/);
    expect(bad({ x: [{ c: '   ' }] })).toThrow(/empty/);
    expect(bad({ x: ['plot(close)'] })).toThrow(/must be an object/);
    expect(bad({ x: [{ c: 'plot(close)', i: [1] }] })).toThrow(/inputs must be an object/);
    expect(bad({ x: [{ c: 'plot(close)', i: { Length: { valueOf: 1 } } }] })).toThrow(/script input/);
    expect(bad({ x: [{ c: 'strategy("s")', g: { initialCapital: -5 } }] })).toThrow(/initialCapital/);
    expect(bad({ l: { n: 3, y: [1, 0, 0], p: [] } })).toThrow(/1, 2 or 4 charts/);
    expect(bad({ l: { n: 2, y: [1, 0, 'x'], p: [] } })).toThrow(/sync settings/);
    expect(bad({ l: { n: 2, y: [1, 0, 0], p: [['csv', 'MINE', '1h', []]] } })).toThrow(CSV_NOTE);
    expect(bad({ s: 'csv', y: 'MINE' })).toThrow(CSV_NOTE);
  });

  it('cap the size of every list and text', () => {
    const segment = ['segment', [T0, 1, T0 + H, 2]];
    expect(bad({ d: Array(LIMITS.drawings + 1).fill(segment) })).toThrow(/more than 300 drawings/);
    expect(bad({ d: [['segment', Array(20).fill(T0)]] })).toThrow(/drawing points/);
    expect(bad({ d: [['textNote', [T0, 1], 'x'.repeat(LIMITS.text + 1)]] })).toThrow(/at most 280/);
    expect(bad({ i: Array(LIMITS.indicators + 1).fill(['RSI', [14]]) })).toThrow(/more than 30 indicators/);
    expect(bad({ i: [['MA', Array(LIMITS.params + 1).fill(5)]] })).toThrow(/indicator parameters/);
    expect(bad({ x: Array(LIMITS.scripts + 1).fill({ c: 'plot(close)' }) })).toThrow(/more than 10 scripts/);
    expect(bad({ x: [{ c: 'x'.repeat(100_001) }] })).toThrow(/at most 100000/);
    const many = Object.fromEntries(Array.from({ length: LIMITS.inputs + 1 }, (_, i) => [`k${i}`, i]));
    expect(bad({ x: [{ c: 'plot(close)', i: many }] })).toThrow(/more than 100 inputs/);
    expect(bad({ l: { n: 4, y: [1, 0, 0], p: Array(4).fill(['binance', 'BTCUSDT', '1h', []]) } })).toThrow(/more than 3 charts/);
  });

  it('refuse fragments and inflated data that are too large', async () => {
    await expect(decodeShareHash(`${SHARE_HASH}z${'A'.repeat(MAX_FRAGMENT)}`)).rejects.toThrow(/too long/);
    // About 3 MB of spaces compresses to a few KB: a small link that would inflate to a lot.
    const bomb = new TextEncoder().encode(`{"v":1${' '.repeat(3 * 1024 * 1024)}}`);
    const packed = new Uint8Array(await new Response(new Blob([bomb]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    expect(packed.length).toBeLessThan(10_000);
    await expect(decodeShareHash(`${SHARE_HASH}z${toBase64Url(packed)}`)).rejects.toThrow(/too much data/);
  });

  it('never let keys reach a prototype', async () => {
    const hostile = `{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}},"v":1,"s":"binance","y":"ETHUSDT","t":"4h","x":[{"c":"plot(close)","i":{"Length":5}}]}`;
    const { chart } = await decodeShareHash(plainHash(hostile));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
    expect(chart.scripts?.[0].inputs).toEqual({ Length: 5 });
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const raw = `{"v":1,"s":"binance","y":"ETHUSDT","t":"4h","x":[{"c":"plot(close)","i":{"${key}":{"polluted":1}}}]}`;
      await expect(decodeShareHash(plainHash(raw))).rejects.toThrow(/invalid name/);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('only keep known strategy settings', () => {
    const { chart } = parseShared({ ...base, x: [{ c: 'strategy("s")', g: { slippage: 2, __proto__: { x: 1 }, evil: 'rm -rf' } }] });
    expect(chart.scripts?.[0].strategy).toEqual({ slippage: 2 });
  });
});
