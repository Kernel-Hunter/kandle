import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readFileSync } from 'node:fs';
import { BRIDGE_METHODS, compareVersions, mcpbPackageUrl, mcpPackageUrl } from '../packages/mcp/src/protocol';
import { REGISTRY_NAME, serverJson } from '../packages/mcp/src/registry';
import { SERVER_VERSION, createMcpServer, updateNotice, type BridgeLike } from '../packages/mcp/src/server';
import { APP } from '../src/config';
import { COMMISSION_TYPES, QTY_TYPES, TOOLS, normalizeTimeframe, parseTime, prepareArgs, schemas } from '../packages/mcp/src/tools';
import * as settings from '../src/script/strategySettings';
import { INCLUDE_KEYS } from '../src/share/codec';

// The share codec reads the drawing and indicator catalogs, which import the chart engine.
vi.mock('klinecharts', () => ({ registerIndicator: vi.fn(), registerOverlay: vi.fn() }));

describe('tool schemas', () => {
  it('cover every bridge method exactly once, plus the status tool', () => {
    const methods = TOOLS.filter((t) => t.method).map((t) => t.method);
    expect([...methods].sort()).toEqual([...BRIDGE_METHODS].sort());
    for (const t of TOOLS) expect(schemas[t.name]).toBeDefined();
    expect(TOOLS.map((t) => t.name)).toContain('get_bridge_status');
  });

  it('accepts valid input', () => {
    expect(schemas.set_symbol.parse({ symbol: 'BTC/USDT', exchange: 'binance', pane: 2 })).toEqual({ symbol: 'BTC/USDT', exchange: 'binance', pane: 2 });
    expect(schemas.draw.parse({ type: 'fib', points: [{ time: 1, price: 2 }, { time: '2026-10-01', price: 3 }] }).type).toBe('fib');
    expect(schemas.set_layout.parse({ charts: 4, sync: { crosshair: true } }).charts).toBe(4);
    expect(schemas.get_candles.parse({}).limit).toBeUndefined();
    expect(schemas.get_backtest.parse({})).toEqual({});
    expect(schemas.get_backtest.parse({ id: 's1', trades: 0 })).toEqual({ id: 's1', trades: 0 });
    const inputs = { Symbol: 'BINANCE:SOLUSDT', 'Higher timeframe': '240', Length: 20, Show: true };
    expect(schemas.run_script.parse({ code: 'plot(close)', id: 's1', inputs })).toEqual({ code: 'plot(close)', id: 's1', inputs });
    expect(schemas.set_chart_style.parse({ type: 'heikin_ashi', scale: 'log', pane: 2 })).toEqual({ type: 'heikin_ashi', scale: 'log', pane: 2 });
    expect(schemas.set_chart_style.parse({ scale: 'percent' })).toEqual({ scale: 'percent' });
    expect(schemas.get_share_link.parse({})).toEqual({});
    expect(schemas.get_share_link.parse({ include: { scripts: true, layout: true, drawings: false } })).toEqual({ include: { scripts: true, layout: true, drawings: false } });
  });

  it('rejects bad input with field errors', () => {
    expect(schemas.set_symbol.safeParse({ symbol: 'BTC USDT; rm -rf' }).success).toBe(false);
    expect(schemas.set_symbol.safeParse({ symbol: 'BTCUSDT', exchange: 'ftx' }).success).toBe(false);
    expect(schemas.set_symbol.safeParse({ symbol: 'XBTUSD', exchange: 'kraken' }).success).toBe(true);
    expect(schemas.set_symbol.safeParse({ symbol: 'MY-BTC', exchange: 'csv' }).success).toBe(true);
    expect(schemas.set_timeframe.safeParse({ timeframe: '2h' }).success).toBe(false);
    expect(schemas.get_candles.safeParse({ limit: 50_000 }).success).toBe(false);
    expect(schemas.draw.safeParse({ type: 'circle', points: [{ price: 1 }] }).success).toBe(false);
    expect(schemas.draw.safeParse({ type: 'fib', points: [] }).success).toBe(false);
    expect(schemas.draw.safeParse({ type: 'text', points: [{ price: Number.NaN }] }).success).toBe(false);
    expect(schemas.set_layout.safeParse({ charts: 3 }).success).toBe(false);
    expect(schemas.start_replay.safeParse({ speed: 11 }).success).toBe(false);
    expect(schemas.get_chart_state.safeParse({ pane: 5 }).success).toBe(false);
    expect(schemas.get_backtest.safeParse({ trades: 501 }).success).toBe(false);
    expect(schemas.get_backtest.safeParse({ trades: 2.5 }).success).toBe(false);
    expect(schemas.run_script.safeParse({ code: 'plot(close)', inputs: { Symbol: ['ETHUSDT'] } }).success).toBe(false);
    expect(schemas.run_script.safeParse({ code: 'plot(close)', inputs: { Length: Number.NaN } }).success).toBe(false);
    expect(schemas.set_chart_style.safeParse({ type: 'renko' }).success).toBe(false);
    expect(schemas.set_chart_style.safeParse({ scale: 'logarithmic' }).success).toBe(false);
    expect(schemas.set_chart_style.safeParse({ type: 'line', pane: 0 }).success).toBe(false);
    expect(schemas.get_share_link.safeParse({ include: { everything: true } }).success).toBe(false);
    expect(schemas.get_share_link.safeParse({ include: { scripts: 'yes' } }).success).toBe(false);
  });

  it('offer the same share link options as the app', () => {
    const include = schemas.get_share_link.shape.include.unwrap();
    expect(Object.keys(include.shape)).toEqual(INCLUDE_KEYS);
  });

  it('validate the watchlist tools', () => {
    expect(schemas.get_watchlist.parse({})).toEqual({});
    expect(schemas.add_to_watchlist.parse({ symbol: 'EUR/USD', exchange: 'twelvedata' })).toEqual({ symbol: 'EUR/USD', exchange: 'twelvedata' });
    expect(schemas.add_to_watchlist.safeParse({ symbol: 'BTC USDT' }).success).toBe(false);
    expect(schemas.add_to_watchlist.safeParse({ symbol: 'BTCUSDT', exchange: 'ftx' }).success).toBe(false);
    expect(schemas.add_to_watchlist.safeParse({}).success).toBe(false);
    expect(schemas.remove_from_watchlist.parse({ symbol: 'all' })).toEqual({ symbol: 'all' });
    expect(schemas.remove_from_watchlist.safeParse({ symbol: '' }).success).toBe(false);
  });
});

describe('run_script strategy settings', () => {
  const parse = (strategy: unknown) => schemas.run_script.safeParse({ code: 'strategy("s")', strategy });
  const message = (strategy: unknown) => {
    const res = parse(strategy);
    return res.success ? null : res.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  };

  it('match the settings the app accepts', () => {
    expect(QTY_TYPES).toEqual(settings.QTY_TYPES);
    expect(COMMISSION_TYPES).toEqual(settings.COMMISSION_TYPES);
  });

  it('accept every strategy() setting, and null to go back to the script value', () => {
    const all = {
      initial_capital: 5000,
      default_qty_type: 'percent_of_equity',
      default_qty_value: 25,
      commission_type: 'cash_per_order',
      commission_value: 0,
      slippage: 2,
      pyramiding: 0,
      process_orders_on_close: true,
    };
    expect(parse(all)).toMatchObject({ success: true, data: { strategy: all } });
    expect(parse({ initial_capital: null, slippage: null }).success).toBe(true);
    expect(parse({}).success).toBe(true);
    // The app reads the same names, so what passes here is accepted there.
    expect(settings.parseStrategyPatch(all).ok).toBe(true);
  });

  it('reject bad values with messages that name the setting', () => {
    expect(message({ initial_capital: 0 })).toBe('strategy.initial_capital: initial_capital must be more than 0');
    expect(message({ default_qty_value: -1 })).toBe('strategy.default_qty_value: default_qty_value must be more than 0');
    expect(message({ commission_value: -0.5 })).toBe('strategy.commission_value: commission_value must be 0 or more');
    expect(message({ slippage: 1.5 })).toBe('strategy.slippage: slippage must be a whole number of ticks');
    expect(message({ pyramiding: -1 })).toBe('strategy.pyramiding: pyramiding must be 0 or more');
    expect(message({ default_qty_type: 'shares' })).toMatch(/^strategy\.default_qty_type: /);
    expect(message({ process_orders_on_close: 'yes' })).toMatch(/^strategy\.process_orders_on_close: /);
    expect(message({ capital: 5 })).toMatch(/capital/);
    expect(message('fast')).toMatch(/^strategy: /);
  });
});

describe('argument preparation', () => {
  it('reads times in ms, seconds and ISO form', () => {
    expect(parseTime(1_790_000_000_000)).toBe(1_790_000_000_000);
    expect(parseTime(1_790_000_000)).toBe(1_790_000_000_000);
    expect(parseTime('1790000000')).toBe(1_790_000_000_000);
    expect(parseTime('2026-10-01T00:00:00Z')).toBe(Date.UTC(2026, 9, 1));
    expect(() => parseTime('yesterday-ish')).toThrow(/ISO date/);
    expect(() => parseTime(-5)).toThrow();
  });

  it('normalises timeframes', () => {
    expect(normalizeTimeframe('1H')).toBe('1h');
    expect(normalizeTimeframe('1d')).toBe('1D');
    expect(() => normalizeTimeframe('3m')).toThrow(/Unknown timeframe/);
  });

  it('checks rules that span fields', () => {
    expect(() => prepareArgs('get_candles', { from: Date.UTC(2026, 9, 2), to: Date.UTC(2026, 9, 1) })).toThrow(/before/);
    expect(() => prepareArgs('remove_indicator', {})).toThrow(/id or name/);
    expect(() => prepareArgs('draw', { type: 'trend_line', points: [{ price: 1 }] })).toThrow(/needs 2 points/);
    expect(() => prepareArgs('draw', { type: 'trend_line', points: [{ price: 1, time: 1 }, { price: 2 }] })).toThrow(/time on both/);
    expect(() => prepareArgs('draw', { type: 'text', points: [{ price: 1, time: 1 }] })).toThrow(/need text/);
    expect(() => prepareArgs('set_alert', { type: 'price' })).toThrow(/need a level/);
    expect(() => prepareArgs('set_alert', { type: 'drawing' })).toThrow(/drawing_id/);
    expect(() => prepareArgs('set_alert', { type: 'indicator', level: 1 })).toThrow(/indicator_id/);
    expect(() => prepareArgs('start_replay', { start_time: 1, bars_back: 5 })).toThrow(/not both/);
    expect(() => prepareArgs('set_chart_style', { pane: 2 })).toThrow(/type, a scale or both/);
    expect(prepareArgs('set_chart_style', { scale: 'log' })).toEqual({ scale: 'log' });
  });

  it('converts times and trims extra points', () => {
    const out = prepareArgs('draw', { type: 'horizontal_line', points: [{ price: 5 }, { price: 6, time: 1 }] });
    expect(out.points).toEqual([{ price: 5 }]);
    const fib = prepareArgs('draw', { type: 'fib', points: [{ price: 1, time: '2026-10-01T00:00:00Z' }, { price: 2, time: 1_790_000_000 }] });
    expect(fib.points).toEqual([{ price: 1, time: Date.UTC(2026, 9, 1) }, { price: 2, time: 1_790_000_000_000 }]);
    expect(prepareArgs('set_layout', { charts: 2, panes: [{ timeframe: '4H' }] }).panes).toEqual([{ timeframe: '4h' }]);
    expect(prepareArgs('start_replay', { start_time: '2026-10-01T00:00:00Z' }).start_time).toBe(Date.UTC(2026, 9, 1));
  });
});

function fakeBridge(connected: boolean, answer: (method: string, params: Record<string, unknown>) => unknown = () => ({ ok: 1 })) {
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => answer(method, params));
  const bridge: BridgeLike = {
    connected,
    status: () => ({ state: 'listening', url: 'ws://127.0.0.1:7457', connected }),
    request: request as BridgeLike['request'],
  };
  return { bridge, request };
}

async function connect(bridge: BridgeLike) {
  const server = createMcpServer(bridge, 'ABCD-EFGH-JKLM');
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

describe('MCP server', () => {
  it('lists every tool with a JSON schema and annotations', async () => {
    const client = await connect(fakeBridge(true).bridge);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(TOOLS.length);
    const draw = tools.find((t) => t.name === 'draw')!;
    expect(draw.inputSchema.required).toEqual(['type', 'points']);
    expect(JSON.stringify(draw.inputSchema)).toContain('horizontal_line');
    expect(tools.find((t) => t.name === 'get_candles')!.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'clear_drawings')!.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === 'get_backtest')!.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'get_watchlist')!.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'get_share_link')!.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'remove_from_watchlist')!.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === 'add_to_watchlist')!.inputSchema.required).toEqual(['symbol']);
    const runScript = tools.find((t) => t.name === 'run_script')!;
    expect(runScript.description).toMatch(/strategy\(\).*backtest/s);
    const strategy = (runScript.inputSchema.properties as Record<string, { properties?: Record<string, unknown> }>).strategy;
    expect(Object.keys(strategy.properties ?? {})).toEqual([
      'initial_capital',
      'default_qty_type',
      'default_qty_value',
      'commission_type',
      'commission_value',
      'slippage',
      'pyramiding',
      'process_orders_on_close',
    ]);
  });

  it('explains pairing when the app is not connected', async () => {
    const { bridge, request } = fakeBridge(false);
    const client = await connect(bridge);
    const res = await client.callTool({ name: 'get_chart_state', arguments: {} });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('ABCD-EFGH-JKLM');
    expect(request).not.toHaveBeenCalled();
    const status = await client.callTool({ name: 'get_bridge_status', arguments: {} });
    expect(JSON.parse((status.content as Array<{ text: string }>)[0].text)).toMatchObject({ connected: false, pairing_code: 'ABCD-EFGH-JKLM' });
  });

  it('forwards prepared arguments and returns JSON text', async () => {
    const { bridge, request } = fakeBridge(true, (_m, p) => ({ echo: p }));
    const client = await connect(bridge);
    const res = await client.callTool({ name: 'set_timeframe', arguments: { timeframe: '1d' } });
    expect(request).toHaveBeenCalledWith('set_timeframe', { timeframe: '1D' }, undefined);
    expect(JSON.parse((res.content as Array<{ text: string }>)[0].text)).toEqual({ echo: { timeframe: '1D' } });
  });

  it('returns validation and app errors as tool errors', async () => {
    const { bridge } = fakeBridge(true, () => {
      throw new Error('Unknown symbol NOPE.');
    });
    const client = await connect(bridge);
    const bad = await client.callTool({ name: 'set_layout', arguments: { charts: 3 } });
    expect(bad.isError).toBe(true);
    const cross = await client.callTool({ name: 'set_alert', arguments: { type: 'price' } });
    expect(cross.isError).toBe(true);
    expect(JSON.stringify(cross.content)).toContain('Price alerts need a level');
    const fromApp = await client.callTool({ name: 'set_symbol', arguments: { symbol: 'NOPE' } });
    expect(fromApp.isError).toBe(true);
    expect(JSON.stringify(fromApp.content)).toContain('Unknown symbol NOPE.');
  });

  it('forwards run_script strategy settings and explains bad ones', async () => {
    const { bridge, request } = fakeBridge(true, (_m, p) => ({ echo: p }));
    const client = await connect(bridge);
    const strategy = { initial_capital: 5000, commission_value: 0.1, slippage: null };
    await client.callTool({ name: 'run_script', arguments: { code: 'strategy("s")', id: 's1', strategy } });
    expect(request).toHaveBeenCalledWith('run_script', { code: 'strategy("s")', id: 's1', strategy }, 60_000);
    const bad = await client.callTool({ name: 'run_script', arguments: { code: 'strategy("s")', strategy: { initial_capital: 0 } } });
    expect(bad.isError).toBe(true);
    expect(JSON.stringify(bad.content)).toContain('initial_capital must be more than 0');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('forwards chart style changes and refuses empty ones', async () => {
    const { bridge, request } = fakeBridge(true, (_m, p) => ({ echo: p }));
    const client = await connect(bridge);
    await client.callTool({ name: 'set_chart_style', arguments: { type: 'bars', pane: 3 } });
    expect(request).toHaveBeenCalledWith('set_chart_style', { type: 'bars', pane: 3 }, undefined);
    const empty = await client.callTool({ name: 'set_chart_style', arguments: {} });
    expect(empty.isError).toBe(true);
    expect(JSON.stringify(empty.content)).toContain('Give a type, a scale or both');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('forwards watchlist calls to the app', async () => {
    const { bridge, request } = fakeBridge(true, () => ({ count: 1, items: [] }));
    const client = await connect(bridge);
    await client.callTool({ name: 'add_to_watchlist', arguments: { symbol: 'SOLUSDT', exchange: 'bybit' } });
    expect(request).toHaveBeenCalledWith('add_to_watchlist', { symbol: 'SOLUSDT', exchange: 'bybit' }, 30_000);
    await client.callTool({ name: 'get_watchlist', arguments: {} });
    expect(request).toHaveBeenLastCalledWith('get_watchlist', {}, undefined);
    const bad = await client.callTool({ name: 'remove_from_watchlist', arguments: {} });
    expect(bad.isError).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('returns screenshots as image content', async () => {
    const { bridge } = fakeBridge(true, () => ({ dataUrl: 'data:image/png;base64,iVBORw0KGgo=', width: 10, height: 5, label: 'BTCUSDT 1h on binance' }));
    const client = await connect(bridge);
    const res = await client.callTool({ name: 'screenshot', arguments: {} });
    const content = res.content as Array<{ type: string; data?: string; mimeType?: string; text?: string }>;
    expect(content[0]).toEqual({ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' });
    expect(content[1].text).toBe('Screenshot of BTCUSDT 1h on binance, 10x5 px.');
  });
});

describe('versions', () => {
  it('match across the app, the server and both package.json files', () => {
    const root = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    const mcp = JSON.parse(readFileSync(new URL('../packages/mcp/package.json', import.meta.url), 'utf8')) as { version: string };
    expect(new Set([root.version, mcp.version, SERVER_VERSION, APP.version]).size).toBe(1);
  });

  it('point the docs and the Agent dialog at this version\'s release', () => {
    const url = mcpPackageUrl(APP.version);
    expect(url).toBe(`https://github.com/Kernel-Hunter/kandle/releases/download/v${APP.version}/kandle-mcp-${APP.version}.tgz`);
    expect(APP.mcpNpx).toContain(url);
    for (const file of ['../README.md', '../README.zh-CN.md']) {
      const text = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(text).toContain(url);
      expect(text).toContain(mcpbPackageUrl(APP.version));
      expect(text).not.toContain('releases/latest/download');
    }
  });

  it('keep the MCP Bundle manifest in step with the server', () => {
    const manifest = JSON.parse(readFileSync(new URL('../packages/mcp/manifest.json', import.meta.url), 'utf8')) as {
      version: string;
      tools: { name: string; description: string }[];
    };
    expect(manifest.version).toBe(SERVER_VERSION);
    expect(manifest.tools).toEqual(TOOLS.map((t) => ({ name: t.name, description: t.description })));
  });

  it('describe the release bundle for the MCP Registry', () => {
    const sha = 'a'.repeat(64);
    const entry = serverJson(SERVER_VERSION, sha);
    expect(entry.name).toBe(REGISTRY_NAME);
    expect(entry.version).toBe(SERVER_VERSION);
    expect(entry.description.length).toBeLessThanOrEqual(100);
    expect(entry.packages).toEqual([
      {
        registryType: 'mcpb',
        identifier: `https://github.com/Kernel-Hunter/kandle/releases/download/v${SERVER_VERSION}/kandle-mcp-${SERVER_VERSION}.mcpb`,
        fileSha256: sha,
        transport: { type: 'stdio' },
      },
    ]);
    expect(() => serverJson(SERVER_VERSION, 'not-a-hash')).toThrow();
  });

  it('compares dotted versions', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('0.2.0', '0.2')).toBe(0);
    expect(compareVersions('0.1.9', '0.2.0')).toBeLessThan(0);
  });

  it('asks for an update only when the app is newer than the server', () => {
    expect(updateNotice(undefined)).toBeNull();
    expect(updateNotice(SERVER_VERSION)).toBeNull();
    expect(updateNotice('0.0.1')).toBeNull();
    const notice = updateNotice('99.0.0');
    expect(notice).toContain('99.0.0');
    expect(notice).toContain(mcpPackageUrl('99.0.0'));
  });
});
