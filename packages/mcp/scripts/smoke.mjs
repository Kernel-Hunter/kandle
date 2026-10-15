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
  const text = res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
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

await call('set_symbol', { symbol: 'ETH/USDT', exchange: 'binance' });
await call('set_timeframe', { timeframe: '4h' });
await call('add_indicator', { name: 'RSI', params: [14] });
const state = JSON.parse((await call('get_chart_state')).content[0].text);
const price = state.last_price;
const level = Math.round(price * 1.02 * 100) / 100;
const line = JSON.parse((await call('draw', { type: 'horizontal_line', points: [{ price: level }] })).content[0].text);
await call('draw', { type: 'text', points: [{ time: state.last_bar.time, price: level }], text: 'Resistance to watch' });
await call('set_alert', { type: 'drawing', drawing_id: line.id, condition: 'crosses', message: `ETHUSDT crossed ${level}` });
await call('set_alert', { type: 'price', level: Math.round(price * 0.98 * 100) / 100, condition: 'crosses_down' });
await call('list_alerts');
await call('get_candles', { limit: 3, include_indicators: true });
const shot = await call('screenshot');
const image = shot.content.find((c) => c.type === 'image');
if (out && image) {
  writeFileSync(out, Buffer.from(image.data, 'base64'));
  console.log(`\nSaved screenshot to ${out}`);
}
await call('run_script', { code: 'plot(close)' });
await call('set_symbol', { symbol: 'NOPE' });

await client.close();
