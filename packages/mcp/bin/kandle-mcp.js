#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const entry = new URL('../dist/cli.js', import.meta.url);
if (!existsSync(fileURLToPath(entry))) {
  process.stderr.write('kandle-mcp is not built yet. Run `pnpm --filter kandle-mcp build` in the Kandle repo.\n');
  process.exit(1);
}
await import(entry.href);
