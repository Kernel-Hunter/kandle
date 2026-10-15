/**
 * Product identity lives here so the project can be renamed in one place.
 * `id` is used for storage keys; `name` is what users see.
 */
export const APP = {
  id: 'kandle',
  name: 'Kandle',
  tagline: 'Open-source charts for crypto, stocks and forex',
  repoUrl: 'https://github.com/Kernel-Hunter/kandle',
  /** npx runs the MCP server from the latest release, so it needs no npm registry. */
  mcpNpx: 'npx -y --package=https://github.com/Kernel-Hunter/kandle/releases/latest/download/kandle-mcp.tgz kandle-mcp',
} as const;
