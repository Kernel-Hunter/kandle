# Kandle

Kandle is a free, open-source charting app for crypto, stock and forex markets. It runs in your browser and keeps your layouts on your own machine. Crypto charts need no account or API key; stock and forex charts use a free key from a data provider that you paste in.

It has alerts, bar replay and multi-chart layouts, and an AI agent such as Claude Code, Codex, Cursor or Gemini CLI can read the chart and draw on it through a local MCP server.

![Kandle showing ETH/USDT with indicators and drawings](docs/screenshot-week1.png)

## Try it

Live demo: link coming soon.

## Features

- Live crypto candles from Binance, Coinbase, Bybit, OKX and Kraken public market data, with no key. History loads over REST and updates stream over websockets.
- US and global stocks, ETFs and forex from Twelve Data, Alpaca or Polygon with your own free API key. See [Data sources](#data-sources).
- Symbol search for the chosen source, with Crypto, Stock, ETF, Forex and Index badges.
- Timeframes: 1m, 5m, 15m, 1H, 4H, 1D, 1W. Scroll left to load older history.
- 34 indicators, with as many on the chart as you like: MA, EMA, SMA, WMA, HMA, Bollinger Bands, Donchian Channel, VWAP, Supertrend, Parabolic SAR, Volume, MACD, RSI, Stochastic RSI, KDJ, ATR, OBV, CCI, DMI/ADX, Williams %R, ROC, Momentum, TRIX, Awesome Oscillator and more. Every parameter can be edited.
- Drawing tools: trend line, ray, extended line, horizontal line and ray, vertical line, parallel channel, rectangle, Fibonacci retracement, price range, text notes and price labels. Select a drawing to move it or delete it. An optional magnet snaps points to candle prices.
- Your symbol, timeframe, theme, indicators, and drawings (saved per symbol) come back when you reload.
- Dark and light themes.
- Keyboard shortcuts for most actions. Press `?` in the app to see them all.
- Export the chart as a PNG image.
- Scripts: write your own indicators in Kandle Script, with an editor under the chart and ten example scripts.
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
| `Alt+S` | Script editor |
| `Ctrl+Enter` or `Cmd+Enter` | Add or update the script on the chart (in the editor) |
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
| `run_script` | Adds a Kandle script to the main chart and returns its id and latest plot values, or the error with line and column |

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

## Scripts

Kandle Script lets you write your own indicators. It is compatible with the scripting language most chart users already know, so many existing indicator scripts run with few or no changes.

Click **Scripts** (or press `Alt+S`) to open the editor under the chart. Write a script, or pick one from **Examples**, and press `Ctrl+Enter` (`Cmd+Enter` on a Mac) to add it to the chart. Errors are underlined as you type, with the line, column and message below the editor. Pick a script from the list at the top left of the editor to change it later.

```
//@version=5
indicator("EMA cross", overlay = true)
fastLen = input.int(9, "Fast", minval = 1)
slowLen = input.int(21, "Slow", minval = 1)

fast = ta.ema(close, fastLen)
slow = ta.ema(close, slowLen)

plot(fast, "Fast", color.orange, 2)
plot(slow, "Slow", color.blue, 2)
plotshape(ta.crossover(fast, slow), "Up", shape.triangleup, location.belowbar, color.green)
```

Scripts with `overlay = true` draw on the price chart; the others get their own pane. Inputs show up in the **Indicators** dialog, where you can change them without touching the code. Scripts and their input values are saved with your layout. When a new candle arrives or the last one changes, only the last bar is calculated again; a full run over 1,500 bars takes a few milliseconds for typical scripts.

The examples are a moving average cross, RSI with bands, MACD, Bollinger Bands, Supertrend, VWAP bands, Stochastic, an ATR trailing stop, a Donchian breakout and volume spikes.

![The script editor with an RSI script, and Supertrend and Bollinger Bands scripts on the chart](docs/screenshot-scripts.png)

### What is supported

- Syntax: `//@version=5` and `//@version=6` headers, comments, indented blocks, line wrapping inside brackets or after an operator, `var` and `varip`, type names on declarations (`float x = na`), `=`, `:=` and `+= -= *= /= %=`, `?:`, `and`, `or`, `not`, `if` / `else if` / `else`, `switch` with or without a value, `for i = a to b by step`, `for x in array`, `for [i, x] in array`, `while`, `break`, `continue`, functions on one line or several, default and named arguments, tuples (`[a, b] = f()`), user methods (`method f(float x) =>`) and method calls such as `values.push(x)`.
- Series: every value has history, read with `x[n]`. `na`, `na()`, `nz()` and `fixnan()`. Variables declared with `var` keep their value from bar to bar. Each call of a function keeps its own history.
- Data: `open`, `high`, `low`, `close`, `volume`, `hl2`, `hlc3`, `ohlc4`, `hlcc4`, `time`, `bar_index`, `last_bar_index`, `year`, `month`, `dayofmonth`, `dayofweek`, `hour`, `minute`, `barstate.*`, `syminfo.ticker`, `syminfo.mintick`, `timeframe.period`, `timeframe.change()`.
- `ta.*`: `sma`, `ema`, `rma`, `wma`, `vwma`, `hma`, `rsi`, `macd`, `stoch`, `atr`, `tr`, `bb`, `bbw`, `kc`, `cci`, `mfi`, `obv`, `vwap` (with optional anchor and bands), `supertrend`, `dmi`, `wpr`, `change`, `mom`, `roc`, `highest`, `lowest`, `highestbars`, `lowestbars`, `crossover`, `crossunder`, `cross`, `rising`, `falling`, `stdev`, `variance`, `dev`, `cum`, `valuewhen`, `barssince`, `pivothigh`, `pivotlow`, `linreg`, `correlation`, `percentrank`, `median`.
- `math.*`: `abs`, `max`, `min`, `avg`, `sum`, `round`, `floor`, `ceil`, `sqrt`, `pow`, `log`, `log10`, `exp`, `sign`, trigonometry, `pi` and `e`.
- `input`, `input.int`, `input.float`, `input.bool`, `input.string` (with `options`), `input.source`, `input.color`, `input.price`.
- `color.*` constants, `color.new`, `color.rgb`, `color.from_gradient`, and `#RRGGBB` or `#RRGGBBAA` literals.
- `str.tostring`, `str.format`, `str.length`, `str.contains`, `str.upper`, `str.lower` and a few more. `array.*` for float, int, bool, string and color arrays.
- Output: `indicator()` with `title`, `shorttitle`, `overlay`, `format` and `precision`; `plot` with the line, step line, histogram, columns, circles, cross and area styles, per-bar colors, `linewidth` and `offset`; `plotshape`; `plotchar`; `hline`; `fill` between two plots or two hlines; `bgcolor`; `barcolor` (on price-chart scripts).

Not supported yet: strategies and backtesting, `request.*` (other symbols or timeframes), drawing objects (`label`, `line`, `box`, `table`), user-defined types and enums, `import`, `matrix` and `map`, and gradient fills. Using one of these gives a clear "not supported yet" error that points at the line.

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

- Strategy scripts with backtest results, and `request.*` for other symbols and timeframes in scripts.
- Desktop app for macOS, Windows, and Linux.
- CSV import.

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
  data/              market data adapters behind a DataSource interface, API keys, rate limits
  chart/             chart engine glue, extra indicators, extra drawing tools
  store/             layout persistence
  script/            Kandle Script: lexer, parser, runtime, built-ins, chart renderer
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

## Data sources

Click **Data** in the top bar to see every source, add keys and test them. In symbol search, pick the source above the results.

| Source | Markets | Key needed | Updates |
| --- | --- | --- | --- |
| Binance | Crypto | No | Live |
| Coinbase | Crypto | No | Live |
| Bybit | Crypto | No | Live |
| OKX | Crypto | No | Live |
| Kraken | Crypto | No | Live. History is limited to the latest 720 bars per timeframe. |
| Twelve Data | Stocks, ETFs, forex, crypto | Free key | Live for the symbols your plan streams, otherwise refreshed once a minute |
| Alpaca | US stocks and ETFs | Free key ID and secret | Live from the IEX feed (volume covers IEX trades only) |
| Polygon | Stocks, ETFs, forex, crypto, indices | Free key | End of day on the free plan, marked Delayed |

Free keys:

- Twelve Data: sign up at [twelvedata.com](https://twelvedata.com/register). The free plan allows 8 requests a minute and 800 a day.
- Alpaca: open a free account at [alpaca.markets](https://app.alpaca.markets/signup) (paper trading is enough) and create an API key. The free plan uses the IEX feed and allows 200 requests a minute.
- Polygon: sign up at [polygon.io](https://polygon.io/dashboard/signup). The free plan has 2 years of end-of-day data and 5 requests a minute.

Finnhub is not included: its free plan does not include historical candles, so it cannot draw a chart.

How keys are handled:

- Keys stay in this browser. They are saved in local storage under `kandle:apikey:<source>` and are never sent anywhere except to that provider's own API. Kandle has no server.
- Keys go in request headers where the provider allows it. The Twelve Data websocket only accepts the key in its URL, which goes to Twelve Data only.
- **Remove key** in the Data dialog deletes it from the browser.

Free plans have tight limits, so Kandle caches responses, counts requests against each plan's per-minute limit, and backs off when a provider answers 429. When a limit is reached the chart says "Free plan limit reached, try again in N s" instead of retrying in a loop.

Stock charts only have bars for trading hours. Nights, weekends and holidays get no empty bars, and the chart places bars side by side, so there are no gaps on the time axis.

Market data comes straight from each provider's official public API in your browser. Kandle does not store or redistribute it, and each provider's terms apply. Exchange availability depends on your region; for Binance the app uses the public market data hosts first.

![The Data sources dialog over an OKX chart](docs/screenshot-sources.png)

## License

MIT. See [LICENSE](LICENSE).

Charts are drawn with [KLineChart](https://github.com/klinecharts/KLineChart), licensed under Apache-2.0. The script editor uses [CodeMirror](https://codemirror.net), licensed under MIT. Their notices are in `public/third-party-notices.txt`.
