# kandle-mcp

MCP server (stdio) that lets AI agents read and draw on a running [Kandle](../../README.md) chart.

Your agent starts `kandle-mcp`. It listens for the Kandle app on `ws://127.0.0.1:7457`. In Kandle, click **Agent**, paste the pairing code and turn on **Agent bridge**.

```sh
claude mcp add kandle -- npx -y --package=https://github.com/Kernel-Hunter/kandle/releases/download/v0.9.0/kandle-mcp-0.9.0.tgz kandle-mcp
cat ~/.kandle/bridge-token     # show the pairing code
```

See the main README for config snippets for Codex, Cursor and Gemini CLI, the tool list and the security model.

## Development

```sh
pnpm --filter kandle-mcp build
node packages/mcp/scripts/smoke.mjs docs/screenshot-agent.png   # end-to-end check against a running Kandle tab
```

`src/protocol.ts` is the wire protocol shared with the app (`src/agent/` in the main repo).
