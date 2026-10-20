import { mcpPackageUrl } from '../packages/mcp/src/protocol';

const VERSION = '0.4.0';

/**
 * Product identity lives here so the project can be renamed in one place.
 * `id` is used for storage keys; `name` is what users see.
 */
export const APP = {
  id: 'kandle',
  name: 'Kandle',
  tagline: 'Open-source charts for crypto, stocks and forex',
  version: VERSION,
  repoUrl: 'https://github.com/Kernel-Hunter/kandle',
  /** npx runs the MCP server from this version's release tarball, so it needs no npm registry. */
  mcpNpx: `npx -y --package=${mcpPackageUrl(VERSION)} kandle-mcp`,
} as const;
