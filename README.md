# Kandle

Kandle is a free, open-source charting app for crypto markets. It runs in your browser, needs no account or API key, and keeps your layouts on your own machine.

It has alerts, bar replay and multi-chart layouts, and an AI agent such as Claude Code, Codex, Cursor or Gemini CLI can read the chart and draw on it through a local MCP server.

![Kandle showing ETH/USDT with indicators and drawings](docs/screenshot-week1.png)

## Try it

Live demo: link coming soon.

## Features

- Live candles from Binance and Coinbase public market data. History loads over REST and updates stream over websockets.
- Symbol search across every Binance spot pair and every Coinbase product.
- Timeframes: 1m, 5m, 15m, 1H, 4H, 1D, 1W. Scroll left to load older history.
- 34 indicators, with as many on the chart as you like: MA, EMA, SMA, WMA, HMA, Bollinger Bands, Donchian Channel, VWAP, Supertrend, Parabolic SAR, Volume, MACD, RSI, Stochastic RSI, KDJ, ATR, OBV, CCI, DMI/ADX, Williams %R, ROC, Momentum, TRIX, Awesome Oscillator and more. Every parameter can be edited.
- Drawing tools: trend line, ray, extended line, horizontal line and ray, vertical line, parallel channel, rectangle, Fibonacci retracement, price range, text notes and price labels. Select a drawing to move it or delete it. An optional magnet snaps points to candle prices.
- Your symbol, timeframe, theme, indicators, and drawings (saved per symbol) come back when you reload.
- Dark and light themes.
- Keyboard shortcuts for most actions. Press `?` in the app to see them all.
- Export the chart as a PNG image.
- Alerts on price levels, drawn lines and indicator values, with browser notifications.
- Bar replay to step through history one candle at a time.
- 1, 2 or 4 charts on screen, each with its own symbol, timeframe and indicators.
- An MCP server so AI agents can read the chart, draw on it, set alerts and take screenshots.
- Works on desktop and tablet screens.

### Keyboard shortcuts

| Keys | Action |
| --- | --- |
| Any letter or digit | Search symbols |
| `/` or `Alt+I` | Indicators |
| `Alt+1` to `Alt+7` | Timeframes 1m to 1W |
| `Alt+T` | Trend line |
| `Alt+R` | Ray |
| `Alt+H` | Horizontal line |
| `Alt+V` | Vertical line |
| `Alt+B` | Rectangle |
| `Alt+F` | Fibonacci retracement |
| `Alt+P` | Price range |
| `Alt+N` | Text note |
| `Alt+M` | Magnet on or off |
| `Delete` | Delete the selected drawing |
| `Esc` | Cancel the current drawing or close a dialog |
| `Alt+L` | Switch between light and dark |

## Use it with your AI agent

Kandle ships an MCP server, `kandle-mcp`. Your agent starts it, and the Kandle tab in your browser connects to it over a WebSocket on `127.0.0.1`. The agent can then read the chart and change it while you watch.

### Set up

1. Add the server to your agent (the snippets are below).
2. Ask the agent for the Kandle pairing code. It calls `get_bridge_status` and shows a code like `K7QD-9MXR-2HPA`. You can also run `npx kandle-mcp --print-token`.
3. In Kandle, click **Agent** in the top bar, paste the code, and turn on **Agent bridge**. The dot on the button turns green when the agent is connected.

The code is saved in your browser and in `~/.kandle/bridge-token`, so you only pair once.

`kandle-mcp` is not on npm yet. Until it is, build it from this repo with `pnpm install && pnpm build` and use `node /path/to/kandle/packages/mcp/bin/kandle-mcp.js` in place of `npx -y kandle-mcp` in the snippets. Inside the repo, `npx kandle-mcp` and `pnpm mcp` also work.

Claude Code:

```sh
claude mcp add kandle -- npx -y kandle-mcp
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.kandle]
command = "npx"
args = ["-y", "kandle-mcp"]
```

Cursor (`~/.cursor/mcp.json` or `.cursor/mcp.json` in a project) and Gemini CLI (`~/.gemini/settings.json`):

```json
{
  "mcpServers": {
    "kandle": { "command": "npx", "args": ["-y", "kandle-mcp"] }
  }
}
```

### Tools

| Tool | What it does |
| --- | --- |
| `get_bridge_status` | Connection state and the pairing code |
| `get_chart_state` | Symbol, timeframe, last bar, visible range, indicators with latest values, drawings with ids, alerts, replay and layout |
| `set_symbol`, `set_timeframe` | Change the market or bar size |
| `get_candles` | OHLCV bars by count or time range, optionally with indicator values per bar |
| `add_indicator`, `remove_indicator`, `list_indicators` | Manage indicators and list the 34 available |
| `draw` | Trend line, horizontal line or ray, vertical line, ray, extended line, rectangle, Fibonacci retracement, text note, price range, all by price and time |
| `remove_drawing`, `clear_drawings` | Remove drawings |
| `screenshot` | PNG of a chart, returned as an image |
| `set_alert`, `list_alerts`, `remove_alert` | Alerts on price, drawn lines and indicators |
| `start_replay`, `step_replay`, `stop_replay` | Bar replay |
| `set_layout` | 1, 2 or 4 charts, sync options, symbol and timeframe per chart |
| `run_script` | Runs a Kandle script when the script engine is present |

Most tools take an optional `pane` (1 to 4) when several charts are showing. Times can be ISO 8601 dates or Unix times in seconds or milliseconds. Inputs are validated and errors say what to fix.

[`skills/kandle/SKILL.md`](skills/kandle/SKILL.md) is an agent skill with chart analysis workflows: support and resistance, trend, indicator confluence, and annotating a chart with an explanation. Copy it into your agent's skills folder (for Claude Code, `~/.claude/skills/kandle/`).

![An agent marked up BTC/USDT with the 120-bar high and low, a Fibonacci retracement and a note](docs/screenshot-agent.png)

### Security model

- The bridge only listens on `127.0.0.1`. Nothing is reachable from other machines.
- The app connects to the server, not the other way round, and only after you turn on **Agent bridge**. It is off by default and you can turn it off at any time.
- Every connection must send the pairing code first. The code has about 59 bits of randomness, is compared in constant time, and the server stops accepting codes for a minute after 5 wrong ones.
- The server rejects WebSocket connections from web pages that are not served from `localhost`, `127.0.0.1` or `[::1]`, so a website you visit cannot connect even if it guesses the port. Add other origins, such as a hosted copy of Kandle, with `KANDLE_ALLOWED_ORIGINS`.
- The server rejects requests whose `Host` header is not a loopback address, which blocks DNS rebinding.
- The agent can only do what the tools allow: read chart data, change symbols, indicators, drawings, alerts, replay and layout, and take screenshots of the chart. It cannot read other tabs, your files or your browser storage.
- Only one Kandle tab is connected at a time. A newer tab takes over and the older one shows that it was replaced.
- Programs running as your user on the same computer can read `~/.kandle/bridge-token`. That is the same trust level as the agent itself.

Settings: `--port` or `KANDLE_PORT` (default 7457, change the port in the Agent dialog to match), `KANDLE_TOKEN` for a fixed code, `KANDLE_HOME` for the token folder.

## Alerts

Click **Alerts** to create and manage alerts for the main chart's symbol:

- Price crosses, crosses up, crosses down or touches a level.
- Price crosses or touches a horizontal line, horizontal ray, trend line, ray or extended line you drew. If you move the line, the alert follows it.
- An indicator line, such as RSI or MACD, crosses a level.

Each alert fires once, or every time (at most once per bar). When one fires you get a browser notification, a message in the app and a short sound. Kandle asks for notification permission when you create your first alert. Alerts are saved in your browser and are checked against live data while a Kandle tab is open; they do not run when the tab is closed. Alerts on a symbol shown in any of the charts on screen are checked.

## Bar replay

Click **Replay**, then click a bar on the main chart. Every bar after it is hidden and indicators are calculated only on what is visible. Use the replay bar to play, pause, step forward one bar and pick a speed from 1x to 10x (bars per second). Keyboard: Space plays or pauses, Right arrow steps, Esc exits. Exiting returns the chart to live data. Changing the symbol or timeframe also ends replay. Replay can go back as far as the exchange has history; Kandle loads older bars when needed.

## Layouts

Click **Layout** to show 1 chart, 2 side by side or 4 in a grid. The first chart is the main one and uses the top bar and drawing tools. The others each have their own symbol, timeframe and indicators in a small header. Turn on sync to keep the crosshair, the timeframe or the symbol the same across charts. The layout and each chart's settings are saved in your browser.

## Roadmap

- Scripts: a scripting language for custom indicators, with an editor panel. Classic indicators will be rewritten as example scripts.
- Desktop app for macOS, Windows, and Linux.
- More data sources: Kraken, Bybit, CSV import, and stock data with your own API keys.

## Run it locally

You need Node.js 22.12 or newer and pnpm.

```sh
pnpm install
pnpm dev
```

Then open the URL that Vite prints, usually http://localhost:5173.

Other commands:

```sh
pnpm test     # unit tests
pnpm build    # type check, production build in dist/, and build kandle-mcp
pnpm preview  # serve the production build
pnpm mcp      # build and run kandle-mcp (normally your agent runs it)
```

To build for a subpath, such as a GitHub Pages project site, set `BASE_PATH`:

```sh
BASE_PATH=/kandle/ pnpm build
```

### Project layout

```
src/
  config.ts          app name and identifiers
  data/              exchange adapters behind a DataSource interface
  chart/             chart engine glue, extra indicators, extra drawing tools
  store/             layout persistence
  ui/                symbol search, indicator panel, dialogs
  agent/             agent bridge client, request handlers, Agent dialog
  alerts/            alert evaluation, notifications, alert manager
  replay/            bar replay and the data loader it sits behind
  layout/            multi-chart layouts
  features/          connects the above to the app
packages/mcp/        kandle-mcp, the MCP server
skills/kandle/       agent skill for chart analysis
tests/               unit tests
```

To add an exchange, implement the `DataSource` interface in `src/data/types.ts` and register it in `src/data/sources.ts`.

## Data

Market data comes straight from each exchange's public API in your browser. Kandle has no server and does not store or redistribute data. Exchange availability depends on your region; for Binance the app uses the public market data hosts first.

## License

MIT. See [LICENSE](LICENSE).

Charts are drawn with [KLineChart](https://github.com/klinecharts/KLineChart), licensed under Apache-2.0. Its notices are in `public/third-party-notices.txt`.
