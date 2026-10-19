#!/usr/bin/env node
// Prints the server.json that the release workflow publishes to the MCP Registry
// (https://registry.modelcontextprotocol.io). The package is the .mcpb bundle attached to
// the GitHub release, so the registry entry needs the bundle's SHA-256.
//
//   node packages/mcp/scripts/server-json.mjs kandle-mcp-<version>.mcpb > server.json
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { serverJson } from '../dist/registry.js';

const file = process.argv[2];
if (!file) {
  process.stderr.write('usage: server-json.mjs <bundle.mcpb>\n');
  process.exit(1);
}
const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
process.stdout.write(`${JSON.stringify(serverJson(pkg.version, sha256), null, 2)}\n`);
