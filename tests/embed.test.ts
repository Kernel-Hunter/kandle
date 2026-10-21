import { afterEach, describe, expect, it, vi } from 'vitest';
import { csvStore, setCsvStore } from '../src/data/csv';
import { keyStore, setKeyStore } from '../src/data/keys';
import { getSource, hasKey } from '../src/data/sources';
import { embedLayout, isolateStorage } from '../src/embed/state';
import { EMBED_SCRIPTS_NOTE, makeEmbedLink } from '../src/share';
import { DEFAULT_INCLUDE, SHARE_HASH, ShareError, decodeShareHash, pickShared } from '../src/share/codec';
import { DEFAULT_EMBED_OPTIONS, appPage, embedTitle, embedUrl, escapeAttribute, iframeSnippet, openInAppUrl, parseEmbedOptions, parseEmbedParams } from '../src/share/embed';
import { ALL, PAGE, snapshot } from './shareFixtures';

// The chart engine touches `window` on import; these modules only need the catalogs.
vi.mock('klinecharts', () => ({ registerIndicator: vi.fn(), registerOverlay: vi.fn() }));

describe('embed URLs', () => {
  it('turn on embed mode only for embed=1', () => {
    expect(parseEmbedParams('?embed=1')).toEqual({ embed: true, theme: null });
    expect(parseEmbedParams('?embed=1&theme=light')).toEqual({ embed: true, theme: 'light' });
    expect(parseEmbedParams('?theme=dark&embed=1')).toEqual({ embed: true, theme: 'dark' });
    expect(parseEmbedParams('?embed=1&theme=blue').theme).toBeNull();
    for (const search of ['', '?embed=0', '?embed=true', '?embed', '?theme=dark', '?embedded=1']) expect(parseEmbedParams(search).embed).toBe(false);
  });

  it('put the flag in the query and keep the chart in the fragment', () => {
    expect(appPage(`${PAGE}?embed=1#s=zABC`)).toBe(PAGE);
    expect(embedUrl(PAGE, 'zABC')).toBe(`${PAGE}?embed=1#s=zABC`);
    expect(embedUrl(`${PAGE}?x=1#s=zOLD`, 'zABC', 'light')).toBe(`${PAGE}?embed=1&theme=light#s=zABC`);
    expect(openInAppUrl(`${PAGE}?embed=1&theme=dark#s=zABC`, '#s=zABC')).toBe(`${PAGE}#s=zABC`);
    expect(openInAppUrl(`${PAGE}?embed=1`, '')).toBe(PAGE);
  });

  it('carry the same chart as a share link, without scripts', async () => {
    const link = await makeEmbedLink(snapshot(), ALL, DEFAULT_EMBED_OPTIONS, PAGE);
    const url = new URL(link.url);
    expect(parseEmbedParams(url.search)).toEqual({ embed: true, theme: null });
    expect(link.url.startsWith(`${PAGE}?embed=1${SHARE_HASH}`)).toBe(true);
    expect(link.openUrl).toBe(`${PAGE}${url.hash}`);
    expect(link.include).toEqual({ ...ALL, scripts: false });
    expect(link.notes).toContain(EMBED_SCRIPTS_NOTE);
    const { chart } = await decodeShareHash(url.hash);
    expect(chart.scripts).toBeUndefined();
    expect(chart).toEqual(pickShared(snapshot(), { ...ALL, scripts: false }).chart);
  });

  it('pass the theme on and leave the scripts note out when there were none to leave', async () => {
    const link = await makeEmbedLink(snapshot({ scripts: [] }), { ...ALL, layout: false }, { ...DEFAULT_EMBED_OPTIONS, theme: 'dark' }, PAGE);
    expect(parseEmbedParams(new URL(link.url).search).theme).toBe('dark');
    expect(link.notes).toEqual([]);
  });

  it('say when the viewer would need an API key, and refuse CSV charts', async () => {
    const keyed = await makeEmbedLink(snapshot({ source: 'twelvedata', symbol: 'AAPL', layout: { ...snapshot().layout, count: 1 } }), DEFAULT_INCLUDE, DEFAULT_EMBED_OPTIONS, PAGE);
    expect(keyed.notes).toEqual(["Charts from Twelve Data need the viewer's own API key, so the embed shows a note with a link to Kandle in their place."]);
    // The default layout in the fixture has a Twelve Data chart too.
    const layout = await makeEmbedLink(snapshot(), { ...DEFAULT_INCLUDE, layout: true }, DEFAULT_EMBED_OPTIONS, PAGE);
    expect(layout.notes.join(' ')).toMatch(/Charts from Twelve Data need/);
    await expect(makeEmbedLink(snapshot({ source: 'csv', symbol: 'MY-DATA' }), DEFAULT_INCLUDE, DEFAULT_EMBED_OPTIONS, PAGE)).rejects.toBeInstanceOf(ShareError);
  });
});

describe('iframe snippet', () => {
  it('is a lazy, borderless iframe with a title', async () => {
    const link = await makeEmbedLink(snapshot(), DEFAULT_INCLUDE, DEFAULT_EMBED_OPTIONS, PAGE);
    expect(link.html).toBe(`<iframe src="${link.url}" title="Kandle chart: ETHUSDT 4H on Binance" width="640" height="400" style="border:0" loading="lazy"></iframe>`);
    const full = await makeEmbedLink(snapshot(), DEFAULT_INCLUDE, parseEmbedOptions({ width: '100%', height: 300 }), PAGE);
    expect(full.html).toContain('width="100%" height="300"');
  });

  it('escapes every value, so a symbol or URL cannot add markup', async () => {
    const evil = `X"><img src=x onerror=alert(1)>'&`;
    const html = iframeSnippet({ url: `${PAGE}?embed=1#s=${evil}`, title: embedTitle({ source: 'binance', symbol: evil, timeframe: '1h' }), width: 640, height: 400 });
    expect(html.match(/</g)).toHaveLength(2);
    expect(html.match(/>/g)).toHaveLength(2);
    expect(html.match(/"/g)).toHaveLength(12);
    expect(html).not.toMatch(/'/);
    expect(html).toContain('X&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&#39;&amp;');
    // A symbol that never went through the link checks is escaped all the same.
    const link = await makeEmbedLink(snapshot({ symbol: evil }), DEFAULT_INCLUDE, DEFAULT_EMBED_OPTIONS, PAGE);
    expect(link.html.match(/</g)).toHaveLength(2);
    expect(link.html).toContain(`title="Kandle chart: ${escapeAttribute(evil)} 4H on Binance"`);
  });

  it('checks sizes and theme from automation', () => {
    expect(parseEmbedOptions(undefined)).toEqual(DEFAULT_EMBED_OPTIONS);
    expect(parseEmbedOptions({ theme: 'auto', width: 320, height: 220 })).toEqual({ theme: null, width: 320, height: 220 });
    expect(parseEmbedOptions({ theme: 'light' }).theme).toBe('light');
    expect(() => parseEmbedOptions({ theme: 'blue' })).toThrow(/light, dark or auto/);
    expect(() => parseEmbedOptions({ width: 50 })).toThrow(/width/);
    expect(() => parseEmbedOptions({ width: '50%' })).toThrow(/width/);
    expect(() => parseEmbedOptions({ height: 2.5 })).toThrow(/height/);
    expect(() => parseEmbedOptions({ height: '400" onload="x' })).toThrow(/height/);
  });
});

describe('embed layout', () => {
  it('shows only what the link carries', () => {
    const { chart } = pickShared(snapshot(), { ...DEFAULT_INCLUDE, indicators: false, drawings: false });
    const layout = embedLayout(chart);
    expect(layout.count).toBe(1);
    expect(layout.panes).toEqual([{ source: 'binance', symbol: 'ETHUSDT', timeframe: '4h', style: { type: 'heikin_ashi', scale: 'log' }, indicators: [], drawings: [], range: snapshot().range }]);
  });

  it('shows every chart of a shared layout', () => {
    const { chart } = pickShared(snapshot(), ALL);
    const layout = embedLayout(chart);
    expect(layout.count).toBe(4);
    expect(layout.sync.crosshair).toBe(true);
    expect(layout.panes.map((p) => `${p.source}:${p.symbol}:${p.timeframe}`)).toEqual(['binance:ETHUSDT:4h', 'coinbase:BTC-USD:1D', 'kraken:XBT/USD:15m', 'twelvedata:EUR/USD:1h']);
    expect(layout.panes[1]).toMatchObject({ style: { type: 'bars', scale: 'percent' }, indicators: [{ name: 'MACD', params: [12, 26, 9] }], drawings: [] });
    expect(layout.panes[2].style).toEqual({ type: 'candles', scale: 'normal' });
  });

  it('fills panes a link leaves out with the defaults', () => {
    const layout = embedLayout({ source: 'binance', symbol: 'BTCUSDT', timeframe: '1h', layout: { count: 2, sync: { crosshair: false, timeframe: false, symbol: false }, panes: [] } });
    expect(layout.panes).toHaveLength(2);
    expect(layout.panes[1].symbol).toBe('ETHUSDT');
  });
});

describe('embed storage', () => {
  const realWindow = (globalThis as { window?: unknown }).window;
  afterEach(() => {
    setKeyStore(null);
    setCsvStore(null);
    (globalThis as { window?: unknown }).window = realWindow;
  });

  it('never reads or writes browser storage', () => {
    const local = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() };
    (globalThis as { window?: unknown }).window = { localStorage: local };
    // Without isolation the shared stores go to localStorage.
    keyStore().get('twelvedata');
    expect(local.getItem).toHaveBeenCalled();
    setKeyStore(null);
    local.getItem.mockClear();
    local.setItem.mockClear();
    local.removeItem.mockClear();

    const memory = isolateStorage();
    keyStore().set('twelvedata', { apiKey: 'abc' });
    expect(hasKey(getSource('twelvedata'))).toBe(true);
    keyStore().clear('twelvedata');
    expect(csvStore().list()).toEqual([]);
    memory.setItem('kandle:layout', '{}');
    expect(local.getItem).not.toHaveBeenCalled();
    expect(local.setItem).not.toHaveBeenCalled();
    expect(local.removeItem).not.toHaveBeenCalled();
  });
});
