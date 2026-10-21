import { describe, expect, it, vi } from 'vitest';
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
