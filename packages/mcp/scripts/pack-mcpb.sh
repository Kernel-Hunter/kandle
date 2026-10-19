#!/usr/bin/env bash
# Builds kandle-mcp-<version>.mcpb, an MCP Bundle that Claude Desktop and other MCP clients
# can install with one click. It holds the built server, its production dependencies and
# manifest.json. Run `pnpm build` first.
#
#   packages/mcp/scripts/pack-mcpb.sh [output-dir]
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
out="$(cd "${1:-.}" && pwd)"
version="$(node -p "require('$here/package.json').version")"
mcpb="npx -y @anthropic-ai/mcpb@2.1.2"

test -f "$here/dist/cli.js" || { echo "kandle-mcp is not built. Run pnpm build first." >&2; exit 1; }
test "$(node -p "require('$here/manifest.json').version")" = "$version" \
  || { echo "manifest.json version does not match package.json ($version)." >&2; exit 1; }

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp -R "$here/bin" "$here/dist" "$here/package.json" "$here/README.md" "$here/manifest.json" "$here/icon.png" "$stage/"
(cd "$stage" && npm install --omit=dev --ignore-scripts --no-audit --no-fund --no-package-lock --loglevel=error)

$mcpb validate "$stage/manifest.json"
$mcpb pack "$stage" "$out/kandle-mcp-$version.mcpb"
