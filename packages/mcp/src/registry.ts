import { mcpbPackageUrl } from './protocol.js';

/** Name of the server in the MCP Registry. GitHub sign-in grants the io.github.<owner> namespace. */
export const REGISTRY_NAME = 'io.github.Kernel-Hunter/kandle';

/** The server.json entry for the MCP Registry, pointing at the release's .mcpb bundle. */
export function serverJson(version: string, sha256: string) {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`not a SHA-256 hex digest: ${sha256}`);
  return {
    $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
    name: REGISTRY_NAME,
    title: 'Kandle',
    description: 'Read and draw on a live crypto, stock or forex chart, run scripts and backtests.',
    repository: { url: 'https://github.com/Kernel-Hunter/kandle', source: 'github' },
    websiteUrl: 'https://kernel-hunter.github.io/kandle/',
    version,
    packages: [
      {
        registryType: 'mcpb',
        identifier: mcpbPackageUrl(version),
        fileSha256: sha256,
        transport: { type: 'stdio' },
      },
    ],
  };
}
