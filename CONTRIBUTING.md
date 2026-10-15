# Contributing

Thanks for helping. Bug reports, new indicators, data sources and script functions are all welcome.

## Setup

You need Node.js 22.12 or later and pnpm.

```sh
pnpm install
pnpm dev        # the app on http://localhost:5173
pnpm test       # unit tests
pnpm build      # type check, production build, and the MCP server
```

## Where things live

- `src/data/`: market data sources. A new exchange or provider implements `DataSource` in `src/data/types.ts` and is registered in `src/data/sources.ts`.
- `src/chart/`: indicators, drawings and chart helpers.
- `src/script/`: the Kandle Script lexer, parser and runtime.
- `src/agent/` and `packages/mcp/`: the browser side of the agent bridge and the MCP server.
- `src/alerts/`, `src/replay/`, `src/layout/`: alerts, bar replay and multi-chart layouts.

## Pull requests

- Keep each pull request to one change, and add or update tests for it.
- `pnpm test` and `pnpm build` must pass.
- For a new data source, use the provider's official API only, and say whether its data is live or delayed.
- For a new script function, add a test that checks its output against an independent calculation.
- Don't copy code, text or assets from other charting products. Kandle is written from public documentation and its own tests.
