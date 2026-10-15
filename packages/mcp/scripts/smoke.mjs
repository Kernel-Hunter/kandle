#!/usr/bin/env node
// End-to-end check with the official MCP client: spawns kandle-mcp over stdio, waits for a
// running Kandle tab to pair, then drives the chart through the tools.
//
//   node packages/mcp/scripts/smoke.mjs [screenshot.png]
//
// Pair the app while it waits: Agent button, paste the code it prints, turn on Agent bridge.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] ? resolve(process.argv[2]) : null;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(here, '../bin/kandle-mcp.js')],
  env: { ...process.env },
  stderr: 'inherit',
});
const client = new Client({ name: 'kandle-smoke', version: '0.0.0' });
await client.connect(transport);

const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  console.log(`\n# ${name} ${JSON.stringify(args)}${res.isError ? '  (error)' : ''}`);
  console.log(text.length > 1200 ? `${text.slice(0, 1200)}...` : text);
  return res;
};

const tools = await client.listTools();
console.log(`${tools.tools.length} tools: ${tools.tools.map((t) => t.name).join(', ')}`);

const status = JSON.parse((await call('get_bridge_status')).content[0].text);
if (!status.connected) {
  console.log(`\nWaiting for Kandle to pair with code ${status.pairing_code} ...`);
  const deadline = Date.now() + 180_000;
  for (;;) {
    const s = JSON.parse((await client.callTool({ name: 'get_bridge_status', arguments: {} })).content[0].text);
    if (s.connected) break;
    if (Date.now() > deadline) throw new Error('Kandle did not connect in time');
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log('Connected.');
}

await call('set_layout', { charts: 1 });
await call('clear_drawings');
await call('remove_alert', { id: 'all' });
await call('set_symbol', { symbol: 'BTC/USDT', exchange: 'binance' });
await call('set_timeframe', { timeframe: '4h' });
await call('remove_indicator', { name: 'RSI' }).catch(() => undefined);
await call('add_indicator', { name: 'RSI', params: [14] });
const state = JSON.parse((await call('get_chart_state')).content[0].text);
const candles = JSON.parse((await call('get_candles', { limit: 120 })).content[0].text);
const highs = candles.rows.map((r) => r[2]);
const lows = candles.rows.map((r) => r[3]);
const top = Math.max(...highs);
const bottom = Math.min(...lows);
const topBar = candles.rows[highs.indexOf(top)];
const bottomBar = candles.rows[lows.indexOf(bottom)];
const noteBar = candles.rows[candles.rows.length - 25];
const resistance = JSON.parse((await call('draw', { type: 'horizontal_line', points: [{ price: top }] })).content[0].text);
await call('draw', { type: 'horizontal_line', points: [{ price: bottom }] });
await call('draw', { type: 'fib', points: [{ time: bottomBar[0], price: bottom }, { time: topBar[0], price: top }] });
await call('draw', { type: 'text', points: [{ time: noteBar[0], price: top }], text: '120-bar high' });
await call('set_alert', { type: 'drawing', drawing_id: resistance.id, condition: 'crosses_up', message: `BTCUSDT broke the 120-bar high ${top}` });
await call('set_alert', { type: 'price', level: Math.round(state.last_price * 0.97), condition: 'crosses_down' });
await call('list_alerts');
await call('get_candles', { limit: 3, include_indicators: true });
const shot = await call('screenshot');
const image = shot.content.find((c) => c.type === 'image');
if (out && image) {
  writeFileSync(out, Buffer.from(image.data, 'base64'));
  console.log(`\nSaved screenshot to ${out}`);
}
await call('start_replay', { bars_back: 30 });
await call('step_replay', { bars: 2 });
await call('stop_replay');
await call('set_layout', { charts: 4, sync: { crosshair: true }, panes: [{}, { symbol: 'BTCUSDT', timeframe: '1h' }] });
await call('get_chart_state', { pane: 2 });
await call('set_layout', { charts: 1 });
await call('run_script', { code: 'plot(close)' });
await call('set_symbol', { symbol: 'NOPE' });

await client.close();
