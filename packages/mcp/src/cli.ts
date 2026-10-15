import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BridgeServer } from './bridge.js';
import { DEFAULT_PORT } from './protocol.js';
import { parseOriginList } from './security.js';
import { createMcpServer, SERVER_VERSION } from './server.js';
import { loadOrCreateToken } from './token.js';

const HELP = `kandle-mcp ${SERVER_VERSION}

MCP server (stdio) that lets AI agents read and draw on a running Kandle chart.

Usage:
  kandle-mcp                 start the MCP server (your agent client runs this)
  kandle-mcp --print-token   print the pairing code and exit
  kandle-mcp --help

Options:
  --port <n>                 bridge port on 127.0.0.1 (default ${DEFAULT_PORT}, or KANDLE_PORT)

Environment:
  KANDLE_PORT                bridge port
  KANDLE_TOKEN               fixed pairing code instead of the one in ~/.kandle/bridge-token
  KANDLE_HOME                folder for the pairing code file (default ~/.kandle)
  KANDLE_ALLOWED_ORIGINS     extra browser origins allowed to connect, comma separated,
                             e.g. https://example.github.io for a hosted copy of Kandle
`;

function parsePort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write(`Invalid port ${value}\n`);
    process.exit(2);
  }
  return port;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    return;
  }
  if (args.includes('--version')) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }
  const tokenInfo = loadOrCreateToken();
  if (args.includes('--print-token')) {
    process.stdout.write(`${tokenInfo.token}\n`);
    return;
  }
  const portFlag = args.indexOf('--port');
  const port = parsePort(portFlag >= 0 ? args[portFlag + 1] : process.env.KANDLE_PORT);

  // stdout carries MCP messages, so everything human-readable goes to stderr.
  const log = (message: string) => process.stderr.write(`[kandle-mcp] ${message}\n`);
  const bridge = new BridgeServer({
    port,
    token: tokenInfo.token,
    allowedOrigins: parseOriginList(process.env.KANDLE_ALLOWED_ORIGINS),
    log,
  });
  await bridge.start();
  log(`Pairing code ${tokenInfo.token}${tokenInfo.path ? ` (stored in ${tokenInfo.path})` : ''}`);

  const server = createMcpServer(bridge, tokenInfo.token);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    await bridge.close();
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  process.stdin.on('close', () => void shutdown());
}

main().catch((error: unknown) => {
  process.stderr.write(`[kandle-mcp] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
