# Kandle

**Free, open-source charts for crypto, stocks and forex, and your AI agent can drive them.**

Indicators, drawing tools, your own scripts and strategy backtests, alerts, bar replay and up to four charts on screen. No account, no paywall, no limit on indicators. It runs in your browser and keeps everything on your machine.

Claude Code, Codex, Cursor or Gemini CLI can read the chart, draw support and resistance, add indicators, write scripts and set alerts while you watch.

**[Open Kandle in your browser](https://kernel-hunter.github.io/kandle/)** · [Connect your agent](#use-it-with-your-ai-agent) · [Write a script](#scripts)

[![CI](https://github.com/Kernel-Hunter/kandle/actions/workflows/ci.yml/badge.svg)](https://github.com/Kernel-Hunter/kandle/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](README.md) · [简体中文](README.zh-CN.md)

![Kandle with support and resistance levels, a support zone, an EMA cross script and RSI on BTC/USDT 4H](docs/hero.png)

## Connect your agent in one line

```sh
claude mcp add kandle -- npx -y --package=https://github.com/Kernel-Hunter/kandle/releases/download/v0.10.0/kandle-mcp-0.10.0.tgz kandle-mcp
```

Then open Kandle, click **Agent**, paste the pairing code your agent gives you and turn on **Agent bridge**. Ask it something like "mark the last swing high and low on BTC and draw a Fibonacci retracement between them". Setup for other agents is [below](#use-it-with-your-ai-agent).

![An agent reads BTC/USDT, marks resistance and a support zone, adds RSI and runs an EMA cross script](docs/demo.gif)

## Features

- Live crypto candles from Binance, Coinbase, Bybit, OKX and Kraken public market data, with no key. History loads over REST and updates stream over websockets.
- US and global stocks, ETFs and forex from Twelve Data, Alpaca or Polygon with your own free API key. See [Data sources](#data-sources).
- Your own OHLCV data from a CSV file, kept in your browser. See [CSV import](#csv-import).
- Symbol search for the chosen source, with Crypto, Stock, ETF, Forex, Index and CSV badges.
- Timeframes: 1m, 5m, 15m, 1H, 4H, 1D, 1W. Scroll left to load older history.
- Chart types: candles, hollow candles, bars (OHLC), line, area and Heikin Ashi, with a normal, logarithmic or percent price scale. Each chart in a layout keeps its own. Heikin Ashi only changes how bars are drawn: indicators, scripts, backtests, alerts and the agent tools keep using the real prices, and the legend shows the Heikin Ashi values on their own line.
- 36 indicators, with as many on the chart as you like: MA, EMA, SMA, WMA, HMA, Bollinger Bands, Donchian Channel, VWAP, Supertrend, Parabolic SAR, Ichimoku Cloud, Volume Profile, Volume, MACD, RSI, Stochastic RSI, KDJ, ATR, OBV, CCI, DMI/ADX, Williams %R, ROC, Momentum, TRIX, Awesome Oscillator and more. Every parameter can be edited.
- Ichimoku Cloud with the cloud drawn ahead of the last candle, and a volume profile of the bars on screen that marks the point of control and the value area. The profile updates as you scroll and zoom.
- Drawing tools: trend line, ray, extended line, horizontal line and ray, vertical line, parallel channel, rectangle, Fibonacci retracement, price range, text notes and price labels. Select a drawing to move it or delete it. An optional magnet snaps points to candle prices.
- Your symbol, timeframe, chart type, price scale, theme, indicators, and drawings (saved per symbol) come back when you reload.
- Dark and light themes.
- Keyboard shortcuts for most actions. Press `?` in the app to see them all.
- Export the chart as a PNG image.
- Share a chart as a link: symbol, timeframe, chart type, indicators and drawings, plus scripts and the multi-chart layout if you choose. The link carries the chart itself. See [Share a chart](#share-a-chart). The same popover gives an iframe that shows the chart on a blog or docs page, see [Embed a chart](#embed-a-chart).
- Scripts: write your own indicators in Kandle Script, with an editor under the chart and 14 example scripts. Scripts can read other timeframes and other symbols with `request.security`.
- Strategy backtests: write a strategy script, see its trades on the chart, and get net profit, drawdown, win rate, an equity curve and the list of trades.
- Alerts on price levels, drawn lines and indicator values, with browser notifications.
- Bar replay to step through history one candle at a time.
- 1, 2 or 4 charts on screen, each with its own symbol, timeframe and indicators.
- A watchlist next to the charts with live prices and 24 hour change for crypto, and the change since the previous close for stocks and forex. Click a symbol to open it.
- An MCP server so AI agents can read the chart, draw on it, set alerts and take screenshots.
- Works on desktops, tablets and phones. On a narrow screen the top bar keeps the symbol, timeframe and price in view and moves the other tools into the ... menu.

![BTC/USDT 4H with the Ichimoku Cloud and a volume profile of the visible bars](docs/screenshot-ichimoku.png)

### Keyboard shortcuts

| Keys | Action |
| --- | --- |
| Any letter or digit | Search symbols |
| `/` or `Alt+I` | Indicators |
| `Alt+S` | Script editor |
| `Ctrl+Enter` or `Cmd+Enter` | Add or update the script on the chart (in the editor) |
| `Alt+1` to `Alt+7` | Timeframes 1m to 1W |
| `Alt+C` | Next chart type |
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
| `Alt+W` | Show or hide the watchlist |
| `Alt+K` | Share a link to this chart |

## Use it with your AI agent

Kandle ships an MCP server, `kandle-mcp`. Your agent starts it, and the Kandle tab in your browser connects to it over a WebSocket on `127.0.0.1`. The agent can then read the chart and change it while you watch.

### Set up

1. Add the server to your agent (the snippets are below).
2. Ask the agent for the Kandle pairing code. It calls `get_bridge_status` and shows a code like `K7QD-9MXR-2HPA`. The code is also saved in `~/.kandle/bridge-token`.
3. In Kandle, click **Agent** in the top bar, paste the code, and turn on **Agent bridge**. The dot on the button turns green when the agent is connected.

The code is saved in your browser and in `~/.kandle/bridge-token`, so you only pair once.

This works with the [hosted app](https://kernel-hunter.github.io/kandle/) and with a copy you run yourself. With the hosted app, your browser may ask whether the page can reach devices on your local network; allow it so the page can talk to `kandle-mcp` on `127.0.0.1`.

`npx` runs `kandle-mcp` from a GitHub release, so you only need Node.js 22.12 or newer. When a new version of Kandle comes out, change the version in the URL; `get_bridge_status` tells your agent when the app is newer than its server. To run it from a clone instead, use `pnpm install && pnpm build` and point your agent at `node /path/to/kandle/packages/mcp/bin/kandle-mcp.js`.

Claude Code:

```sh
claude mcp add kandle -- npx -y --package=https://github.com/Kernel-Hunter/kandle/releases/download/v0.10.0/kandle-mcp-0.10.0.tgz kandle-mcp
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.kandle]
command = "npx"
args = ["-y", "--package=https://github.com/Kernel-Hunter/kandle/releases/download/v0.10.0/kandle-mcp-0.10.0.tgz", "kandle-mcp"]
```

Cursor (`~/.cursor/mcp.json` or `.cursor/mcp.json` in a project) and Gemini CLI (`~/.gemini/settings.json`):

```json
{
  "mcpServers": {
    "kandle": {
      "command": "npx",
      "args": ["-y", "--package=https://github.com/Kernel-Hunter/kandle/releases/download/v0.10.0/kandle-mcp-0.10.0.tgz", "kandle-mcp"]
    }
  }
}
```

Claude Desktop: download [kandle-mcp-0.10.0.mcpb](https://github.com/Kernel-Hunter/kandle/releases/download/v0.10.0/kandle-mcp-0.10.0.mcpb) and open it to install the server.

Kandle is also listed in the [MCP Registry](https://registry.modelcontextprotocol.io/) as `io.github.Kernel-Hunter/kandle`, so clients that browse the registry can find it.

### Tools

| Tool | What it does |
| --- | --- |
| `get_bridge_status` | Connection state and the pairing code |
| `get_chart_state` | Symbol, timeframe, last bar, visible range, indicators with latest values, drawings with ids, alerts, replay and layout |
| `set_symbol`, `set_timeframe` | Change the market or bar size. Exchange `csv` opens a dataset you imported |
| `get_candles` | OHLCV bars by count or time range, optionally with indicator values per bar |
| `add_indicator`, `remove_indicator`, `list_indicators` | Manage indicators and list the 36 available |
| `draw` | Trend line, horizontal line or ray, vertical line, ray, extended line, rectangle, Fibonacci retracement, text note, price range, all by price and time |
| `remove_drawing`, `clear_drawings` | Remove drawings |
| `screenshot` | PNG of a chart, returned as an image |
| `set_alert`, `list_alerts`, `remove_alert` | Alerts on price, drawn lines and indicators |
| `start_replay`, `step_replay`, `stop_replay` | Bar replay |
| `set_layout` | 1, 2 or 4 charts, sync options, symbol and timeframe per chart |
| `set_chart_style` | Chart type (candles, hollow candles, bars, line, area, Heikin Ashi) and price scale (normal, log, percent) of a chart |
| `get_watchlist`, `add_to_watchlist`, `remove_from_watchlist` | Watchlist symbols with last price, change and change percent, and adding or removing them |
| `run_script` | Adds a Kandle script to the main chart and returns its id, input values and latest plot values, or the error with line and column. `inputs` sets input values by title and `id` replaces a script added earlier. For a strategy it also returns the backtest summary and the last 20 trades, and `strategy` changes its backtest settings |
| `get_backtest` | Settings (and which ones differ from the script), summary and up to 500 trades of a strategy script on the chart |
| `get_share_link` | A link that opens the main chart for anyone. `include` picks what it carries besides the exchange, symbol and timeframe. `embed: true` adds an iframe for another web page |

Most tools take an optional `pane` (1 to 4) when several charts are showing. Times can be ISO 8601 dates or Unix times in seconds or milliseconds. Inputs are validated and errors say what to fix.

[`skills/kandle/SKILL.md`](skills/kandle/SKILL.md) is an agent skill with chart analysis workflows: support and resistance, trend, indicator confluence, and annotating a chart with an explanation. Copy it into your agent's skills folder (for Claude Code, `~/.claude/skills/kandle/`).

![An agent marked up BTC/USDT with the 120-bar high and low, a Fibonacci retracement and a note](docs/screenshot-agent.png)

### Security model

- The bridge only listens on `127.0.0.1`. Nothing is reachable from other machines.
- The app connects to the server, not the other way round, and only after you turn on **Agent bridge**. It is off by default and you can turn it off at any time.
- Every connection must send the pairing code first. The code has about 59 bits of randomness, is compared in constant time, and the server stops accepting codes for a minute after 5 wrong ones.
- The server rejects WebSocket connections from web pages that are not served from `localhost`, `127.0.0.1` or `[::1]`, so a website you visit cannot connect even if it guesses the port. The hosted app at `https://kernel-hunter.github.io` is also allowed. Add other origins, such as your own hosted copy, with `KANDLE_ALLOWED_ORIGINS`.
- The server rejects requests whose `Host` header is not a loopback address, which blocks DNS rebinding.
- The agent can only do what the tools allow: read chart data, change symbols, chart types, indicators, drawings, alerts, replay, layout and the watchlist, take screenshots of the chart and make share links. It cannot read other tabs, your files or your browser storage.
- Only one Kandle tab is connected at a time. A newer tab takes over and the older one shows that it was replaced.
- Programs running as your user on the same computer can read `~/.kandle/bridge-token`. That is the same trust level as the agent itself.

Settings: `--port` or `KANDLE_PORT` (default 7457, change the port in the Agent dialog to match), `KANDLE_TOKEN` for a fixed code, `KANDLE_HOME` for the token folder.

## Scripts

Kandle Script lets you write your own indicators and backtest strategies. It is compatible with the scripting language most chart users already know, so many existing indicator scripts run with few or no changes.

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

The indicator examples are a moving average cross, RSI with bands, MACD, Bollinger Bands, Supertrend, VWAP bands, Stochastic, an ATR trailing stop, a Donchian breakout, volume spikes and a daily EMA trend filter that uses `request.security`. The strategy examples are an EMA cross that is always in the market, RSI mean reversion with a stop and a target, a Donchian channel breakout, and a range breakout that waits with a buy stop above the range and a sell stop below it in one order group and stops trading after a set drawdown.

![The script editor with an RSI script, and Supertrend and Bollinger Bands scripts on the chart](docs/screenshot-scripts.png)

### Strategies and backtesting

Declare a script with `strategy()` instead of `indicator()` and it becomes a backtest. Orders placed with `strategy.entry`, `strategy.exit` and `strategy.close` are filled by a broker emulator on the bars loaded in the chart. Each fill is drawn on the price chart as an arrow with its signal name, with a dashed line from entry to exit (green for a win, red for a loss). The **Strategy** tab under the chart has two views:

- **Overview**: net profit, closed trades, percent profitable, profit factor, max drawdown, average trade, Sharpe ratio and buy and hold, the equity curve against buy and hold, and a table with gross profit and loss, average and largest wins and losses, and commission paid. When the script sets risk rules, the table lists them, and a rule that stopped trading is named above the equity curve, with a marker on the curve where it happened.
- **List of trades**: every trade with its direction, entry and exit signal, time and price, quantity, profit, cumulative profit, run-up and drawdown. Click a trade to scroll the chart to it.

```
//@version=5
strategy("EMA cross", overlay = true, initial_capital = 10000,
     default_qty_type = strategy.percent_of_equity, default_qty_value = 100,
     commission_type = strategy.commission.percent, commission_value = 0.05)
fast = ta.ema(close, input.int(12, "Fast"))
slow = ta.ema(close, input.int(26, "Slow"))

if ta.crossover(fast, slow)
    strategy.entry("Long", strategy.long)
    // Stop 3% below and target 6% above the signal bar's close.
    strategy.exit("Exit", "Long", stop = close * 0.97, limit = close * 1.06)
if ta.crossunder(fast, slow)
    strategy.close("Long")

plot(fast, "Fast", color.orange)
plot(slow, "Slow", color.blue)
```

The values in the `strategy()` call are the script's defaults. To try others without editing the code, open the **Indicators** dialog: a strategy has a **Backtest settings** group under its inputs with initial capital, order size and its type, commission and its type, slippage in ticks, pyramiding, and filling market orders on the bar close. A change runs the backtest again, and the trades on the chart and the **Strategy** tab follow. Changed settings are highlighted and saved with the layout like input values, and **Reset** goes back to the values in the script.

How orders fill:

- The script runs once at the close of each bar. An order placed on a bar fills on a later bar: a market order at the next open, a limit or stop order when a bar's range reaches its price. With `process_orders_on_close = true`, market orders fill at the close of the bar that placed them.
- Kandle has no data inside a bar, so it assumes price moved from the open to the nearer of the high and the low, then to the other one, then to the close (high first when both are equally far). When one bar touches both the stop and the target of an exit, the level nearer the open fills. This is an assumption, and a real trade on such a bar could have gone the other way.
- A limit or stop order whose price is already passed at the open (a gap) fills at the open.
- Limit orders fill at their price. Market and stop orders fill `slippage` ticks worse. Commission is charged on every entry and every exit.
- An entry in the opposite direction closes the open position and opens the new one. More entries in the same direction are allowed up to `pyramiding` (0, the default, allows one).
- `strategy.exit` levels given in ticks (`profit`, `loss`, `trail_points`, `trail_offset`) are measured from each trade's fill price. An exit placed on the same bar as its entry protects the trade from the bar it fills on.
- Order sizes come from `default_qty_type` and `default_qty_value` unless `qty` is given. Cash and percent of equity sizes use the fill price. Quantities are not rounded to lot sizes and there are no margin calls.
- The whole history is recalculated when new data arrives, so the results always match the bars on the chart. Scroll left to load older bars and the backtest covers them too.

Order groups: `strategy.entry` and `strategy.order` take `oca_name` and `oca_type`. Pending orders with the same `oca_name` form a group, and when one of them fills, its `oca_type` decides what happens to the others:

- `strategy.oca.cancel`: the other orders of the group are cancelled. This is the usual bracket: a buy stop above a range and a sell stop below it, where the first one to fill removes the other.
- `strategy.oca.reduce`: the quantity of each other order is lowered by the quantity that filled (for an entry that reverses a position, the closed contracts count too), and an order that gets to 0 is cancelled. An order placed without `qty` is first given its default size at the fill price.
- `strategy.oca.none`, the default: nothing happens to the others; the name has no effect.

This happens at the moment of the fill, so a cancelled order cannot fill later in the same bar even if the price path reaches it. Orders in a group should share one type; if they do not, the type of the order that fills is the one that counts. Only real fills count: an entry that does nothing because of `pyramiding` or a risk rule leaves the group alone. Placing an order with the id of a pending one replaces it, group included. Exit brackets from `strategy.exit` keep working as before for the trade that filled.

Risk rules: `strategy.risk.*` calls are settings. They must be at the top level of the script, they apply from the next fill on, and when one is called again the latest value counts. Arguments that are constants are checked when the script compiles; values from inputs are checked when it runs. Both errors point at the line and column.

- `strategy.risk.allow_entry_in(strategy.direction.all | strategy.direction.long | strategy.direction.short)`: `strategy.entry` in a direction that is not allowed only closes an open position in the other direction, and does nothing when there is none. `strategy.order` in that direction can reduce a position but not open one.
- `strategy.risk.max_position_size(contracts)`: an entry or order that would make the position larger than `contracts` is cut down to the room that is left, and does nothing when there is no room. A reversal closes the old position in full and opens at most `contracts`.
- `strategy.risk.max_drawdown(value, type)`: `type` is `strategy.percent_of_equity` (the default) or `strategy.cash`. Drawdown is measured on bar-close equity from its highest point so far, starting with the initial capital. When it reaches `value`, trading stops for the rest of the backtest.
- `strategy.risk.max_intraday_loss(value, type)`: the loss is bar-close equity below the equity at the start of the UTC day, in percent of that equity or in cash. When it reaches `value`, trading stops until the next UTC day.
- `strategy.risk.max_intraday_filled_orders(count)`: counts orders that fill during the UTC day. A reversal is one order, each exit that fills is one order, and the closes that risk rules make are not counted. When the count reaches `count`, trading stops until the next UTC day.
- `strategy.risk.max_cons_loss_days(count)`: a UTC day is a losing day when equity at its last close is below equity at the end of the day before. A winning day starts the count over, and a day where equity did not change is skipped. A day is scored when the next one begins, so after `count` losing days in a row trading stops for the rest of the backtest from the first bar of the next day.

When a rule triggers, every pending order and `strategy.exit` bracket is cancelled, the open position is closed with a market order labelled with the rule (such as "Max drawdown"), and new entries, orders and exits are ignored until trading resumes; `strategy.close` and `strategy.cancel` still work. The closing order fills like any market order: at the next bar's open, or at the close of the same bar with `process_orders_on_close = true`. `max_cons_loss_days` triggers as a new day begins, so it closes at that bar's open. Days are UTC calendar days, taken from the bar's open time, because Kandle has no trading session data. Rules measured on bar-close equity do not see a loss that only happened inside a bar.

How the figures are measured: max drawdown is the largest fall of bar-close equity from an earlier peak. The Sharpe ratio uses the equity at the end of each UTC day (each bar on daily and weekly charts): the mean return over its standard deviation, annualized over 365 days, with a risk-free rate of 0. Buy and hold is the price change from the first loaded close to the last close, applied to the initial capital. Open profit counts the commission already paid on entry.

Supported: `strategy()` with `initial_capital` (default 100000), `default_qty_type` (`strategy.fixed`, `strategy.cash`, `strategy.percent_of_equity`), `default_qty_value`, `commission_type` (`strategy.commission.percent`, `cash_per_contract`, `cash_per_order`), `commission_value`, `slippage`, `pyramiding` and `process_orders_on_close`. Orders: `strategy.entry` and `strategy.order` (with `oca_name` and `oca_type`: `strategy.oca.cancel`, `reduce` and `none`), `strategy.exit` (`profit`, `limit`, `loss`, `stop`, `trail_price` or `trail_points` with `trail_offset`, `qty`, `qty_percent`, `comment_profit`, `comment_loss`, `comment_trailing`), `strategy.close` (with `qty`, `qty_percent` and `immediately`), `strategy.close_all`, `strategy.cancel` and `strategy.cancel_all`, with `strategy.long` and `strategy.short`. Risk rules: `strategy.risk.allow_entry_in` (`strategy.direction.all`, `long`, `short`), `max_position_size`, `max_drawdown`, `max_intraday_loss`, `max_intraday_filled_orders` and `max_cons_loss_days`. State: `strategy.position_size`, `position_avg_price`, `equity`, `netprofit`, `openprofit`, `grossprofit`, `grossloss`, `max_drawdown`, `closedtrades`, `opentrades`, `wintrades`, `losstrades`, `eventrades`, `initial_capital`, and per-trade values such as `strategy.closedtrades.profit(i)` and `strategy.opentrades.entry_price(i)`. `currency`, `calc_on_every_tick` and the `alert_message` arguments are accepted and ignored. `oca_name` in `strategy.exit` is accepted and has no effect, because the target and stop of an exit already cancel each other.

Agents get the same results: `run_script` returns the backtest summary and the last 20 trades of a strategy, and `get_backtest` returns up to 500 trades. `run_script` also takes `strategy`, backtest settings named like the `strategy()` arguments, such as `{"initial_capital": 5000, "commission_value": 0.1}`; `null` puts a setting back to the script's value, and with `id` it reruns a strategy already on the chart. In the page, `window.kandle.setStrategySettings(id, settings)` does the same for a script on the chart, `listScripts()` shows each strategy's own settings and the ones in use, and `getBacktest()` lists the settings that differ in `changedSettings`. The risk rules a script sets are in `settings.risk`, `riskStop` names the rule that stopped trading with the reason (or is `null`), and `riskHalts` counts the days an intraday rule paused trading.

![A Donchian breakout strategy on BTC/USDT with its trades on the chart and the Strategy tab open](docs/screenshot-strategy.png)

### Other symbols and timeframes

`request.security(symbol, timeframe, expression, gaps, lookahead)` returns the value of `expression` calculated on another timeframe, or on another symbol from the chart's data source.

```
//@version=5
indicator("Daily EMA trend", overlay = true)
dailyEma = request.security(syminfo.tickerid, "D", ta.ema(close, 20))
ethClose = request.security("ETHUSDT", "60", close)
plot(dailyEma, "Daily EMA", color.orange, 2, plot.style_stepline)
```

- `symbol` is `syminfo.tickerid` (or `syminfo.ticker`) for the chart's symbol, or a symbol on the same data source such as `"ETHUSDT"` while you chart BTCUSDT on Binance. A prefix such as `"BINANCE:ETHUSDT"` picks that data source when Kandle has it and is ignored otherwise.
- `timeframe` is `"1"`, `"5"`, `"15"`, `"60"`, `"240"`, `"D"` or `"W"` (`"1D"`, `"1W"`, `"1h"` and `"4h"` also work), or `timeframe.period` or `""` for the chart's own.
- Symbol and timeframe must stay the same for the whole run, because Kandle loads the data before the script runs. They can be strings, inputs (`input.symbol`, `input.timeframe`, `input.string`), variables set once to one of these, or text joined from them such as `"BINANCE:" + sym`. Anything that can change from bar to bar, such as `close > open ? "ETHUSDT" : "SOLUSDT"`, gives the error "request.security needs constant symbol and timeframe". A script can request up to 5 different symbol and timeframe pairs; an input counts as one pair whatever it holds.
- The expression runs on the requested bars with its own history, so `ta.ema(close, 20)` in a `"D"` request is a 20-day EMA. Variables, inputs and functions it uses are calculated again on the requested bars. Variables declared with `var`, variables changed with `:=`, function parameters and loop variables cannot be used in it. Tuples work: `[o, c] = request.security(syminfo.tickerid, "D", [open, close])`.

Inputs let you pick the series in the **Indicators** dialog. Changing one runs the script again and loads the new series; series loaded before stay cached, so switching back is instant.

```
//@version=5
indicator("HTF close", overlay = true)
tf = input.timeframe("D", "Higher timeframe")
sym = input.symbol("ETHUSDT", "Symbol")
plot(request.security(sym, tf, close))
```

No lookahead by default. With `lookahead = barmerge.lookahead_off`, a chart bar gets the value of the last requested bar that had closed when the chart bar closed. On a 1H chart a daily value changes on the last hourly bar of each day, and the bars before it show the previous day. History never sees later data. Only the newest chart bar, while the current day is still forming, shows that day's value as it develops.

- `lookahead = barmerge.lookahead_on` uses the requested bar that contains the chart bar, even before it has closed. On history this looks ahead: the 09:00 bar sees that day's close. `request.security(syminfo.tickerid, "D", close[1], lookahead = barmerge.lookahead_on)` is the usual way to get the previous day's close on every bar of today without looking ahead.
- `gaps = barmerge.gaps_on` returns na except on the chart bar where a new requested bar closes (with lookahead on, the first chart bar inside each requested bar).
- Lower or equal timeframes: each chart bar gets the value of the last requested bar that closed inside it, and lookahead has no effect. Up to 5,000 requested bars are loaded, so on a daily chart a 1-minute request covers only the last few days.

Requested series load through the chart's data source with the same caching and rate limits, from 500 bars before the first bar on the chart, and load more when you scroll back. On sources without a key they update live; on sources that need a key they refresh every few minutes to stay within the free plan. While a series loads its values are na, and if it cannot load the script shows the error. `run_script` waits for the data before it returns.

### What is supported

- Syntax: `//@version=5` and `//@version=6` headers, comments, indented blocks, line wrapping inside brackets or after an operator, `var` and `varip`, type names on declarations (`float x = na`), `=`, `:=` and `+= -= *= /= %=`, `?:`, `and`, `or`, `not`, `if` / `else if` / `else`, `switch` with or without a value, `for i = a to b by step`, `for x in array`, `for [i, x] in array`, `while`, `break`, `continue`, functions on one line or several, default and named arguments, tuples (`[a, b] = f()`), user methods (`method f(float x) =>`) and method calls such as `values.push(x)`.
- Series: every value has history, read with `x[n]`. `na`, `na()`, `nz()` and `fixnan()`. Variables declared with `var` keep their value from bar to bar. Each call of a function keeps its own history.
- Data: `open`, `high`, `low`, `close`, `volume`, `hl2`, `hlc3`, `ohlc4`, `hlcc4`, `time`, `bar_index`, `last_bar_index`, `year`, `month`, `dayofmonth`, `dayofweek`, `hour`, `minute`, `barstate.*`, `syminfo.ticker`, `syminfo.mintick`, `timeframe.period`, `timeframe.change()`.
- `ta.*`: `sma`, `ema`, `rma`, `wma`, `vwma`, `hma`, `rsi`, `macd`, `stoch`, `atr`, `tr`, `bb`, `bbw`, `kc`, `cci`, `mfi`, `obv`, `vwap` (with optional anchor and bands), `supertrend`, `dmi`, `wpr`, `change`, `mom`, `roc`, `highest`, `lowest`, `highestbars`, `lowestbars`, `crossover`, `crossunder`, `cross`, `rising`, `falling`, `stdev`, `variance`, `dev`, `cum`, `valuewhen`, `barssince`, `pivothigh`, `pivotlow`, `linreg`, `correlation`, `percentrank`, `median`.
- `math.*`: `abs`, `max`, `min`, `avg`, `sum`, `round`, `floor`, `ceil`, `sqrt`, `pow`, `log`, `log10`, `exp`, `sign`, trigonometry, `pi` and `e`.
- `input`, `input.int`, `input.float`, `input.bool`, `input.string` (with `options`), `input.source`, `input.color`, `input.price`, `input.timeframe` (a dropdown of Kandle's timeframes, or its `options`, plus Chart, which follows the chart's timeframe) and `input.symbol` (a text field that suggests symbols from the chart's data source; empty follows the chart's symbol). `input.timeframe(timeframe.period)` and `input.symbol(syminfo.tickerid)` start out following the chart.
- `color.*` constants, `color.new`, `color.rgb`, `color.from_gradient`, and `#RRGGBB` or `#RRGGBBAA` literals.
- `str.tostring`, `str.format`, `str.length`, `str.contains`, `str.upper`, `str.lower` and a few more. `array.*` for float, int, bool, string and color arrays.
- Other symbols and timeframes: `request.security` with `barmerge.gaps_on`, `gaps_off`, `lookahead_on` and `lookahead_off`. See [Other symbols and timeframes](#other-symbols-and-timeframes).
- Strategies: see [Strategies and backtesting](#strategies-and-backtesting).
- Output: `indicator()` with `title`, `shorttitle`, `overlay`, `format` and `precision`; `plot` with the line, step line, histogram, columns, circles, cross and area styles, per-bar colors, `linewidth` and `offset`; `plotshape`; `plotchar`; `hline`; `fill` between two plots or two hlines; `bgcolor`; `barcolor` (on price-chart scripts).

Not supported yet: `request.*` functions other than `request.security` (such as `request.security_lower_tf` and `request.financial`), drawing objects (`label`, `line`, `box`, `table`), user-defined types and enums, `import`, `matrix` and `map`, and gradient fills. Using one of these gives a clear "not supported yet" error that points at the line.

## Alerts

Click **Alerts** to create and manage alerts for the main chart's symbol:

- Price crosses, crosses up, crosses down or touches a level.
- Price crosses or touches a horizontal line, horizontal ray, trend line, ray or extended line you drew. If you move the line, the alert follows it.
- An indicator line, such as RSI or MACD, crosses a level.

Each alert fires once, or every time (at most once per bar). When one fires you get a browser notification, a message in the app and a short sound. Kandle asks for notification permission when you create your first alert. Alerts are saved in your browser and are checked against live data while a Kandle tab is open; they do not run when the tab is closed. Alerts on a symbol shown in any of the charts on screen are checked.

## Bar replay

Click **Replay**, then click a bar on the main chart. Every bar after it is hidden and indicators are calculated only on what is visible. Use the replay bar to play, pause, step forward one bar and pick a speed from 1x to 10x (bars per second). Keyboard: Space plays or pauses, Right arrow steps, Esc exits. Exiting returns the chart to live data. Changing the symbol or timeframe also ends replay. Replay can go back as far as the exchange has history; Kandle loads older bars when needed.

## Layouts

Click **Layout** to show 1 chart, 2 side by side or 4 in a grid. The first chart is the main one and uses the top bar and drawing tools. The others each have their own symbol, timeframe, chart type and indicators in a small header. Turn on sync to keep the crosshair, the timeframe or the symbol the same across charts. The layout and each chart's settings are saved in your browser.

## Watchlist

Click **Watchlist** (or press `Alt+W`) to show the list on the right of the charts. Click a symbol to load it into the chart you last clicked, which has a blue outline when several charts are showing. The **+** button adds the symbol of that chart and the search button finds any symbol on any source. Drag a row by its handle to reorder it, or focus it and press `Alt+Up` or `Alt+Down`; `Delete` removes it. The first time you open Kandle the list has BTCUSDT, ETHUSDT and SOLUSDT on Binance.

Each row keeps its own data source, and the change it shows depends on that source:

- Binance, Coinbase, Bybit, OKX and Kraken: the last trade and the change over the last 24 hours (a rolling window, not since midnight), streamed live. Kandle opens one websocket per exchange for all of its symbols.
- Twelve Data, Alpaca and Polygon: the change since the previous daily close. Kandle reads the last two daily bars every 10 minutes on Twelve Data, every 2 minutes on Alpaca and every 30 minutes on Polygon, one request at a time, to stay within the free plans. When a chart on screen shows the same symbol, the row follows that chart's live price.
- CSV: the last close of the imported data against the bar before it.

Prices only update while the watchlist is showing. When you hide it, or leave the tab in the background for a minute, Kandle closes the connections and opens them again when you come back. On a phone the list opens over the chart from the list button at the bottom of the drawing toolbar. The list and whether it is showing are saved in your browser.

## Share a chart

Click the share button in the top bar, or press `Alt+K`, then **Copy link** to copy a link to the main chart. The exchange, symbol and timeframe are always in it. You pick the rest: chart type, price scale and visible range, indicators, drawings, scripts (with their input values and strategy settings) and the other charts of a layout. Scripts are off by default because they make links long. The popover shows how long the link is and warns when it passes 8,000 characters, which some chat apps cut.

Kandle stores the chart, compressed, after the `#` in the link. Browsers do not send that part to any server, so GitHub Pages never sees what you share. Charts of imported CSV files cannot be shared, because the data is only in your browser.

A link opens as a temporary view under a **Shared chart** bar, and your own saved chart is not changed. **Keep it** saves the shared chart as yours: its chart settings and indicators replace yours, and your own drawings and scripts stay. **Back to my chart** closes it. Scripts in a link do not run until you click **Run scripts**, and **Show code** lets you read them first. They run the same way as a script you paste into the editor. A damaged or edited link shows a message and opens your own chart.

Agents can make links with the `get_share_link` tool. In the page, `await window.kandle.share({ include: { scripts: true } })` returns the URL.

## Embed a chart

Put a live chart on a blog, docs page or any site that allows iframes. Open Share (`Alt+K`), switch to **Embed**, pick a size and theme, and click **Copy code**:

```html
<iframe src="https://kernel-hunter.github.io/kandle/?embed=1#s=zFcixCsIwFIbRd_nmf0gLBbmbWjfFweoS7hDbDmKM0Kog4ruLZzwfXlglZozzpaTSj4g3xqpbHw9th3hgVC3iitGnMuRxRiSMcp9uKSMmLJZnzlq4uGAxstktUayDmqA6BHdFTvstio2qf7m7GLDo3x8" title="Kandle chart: BTCUSDT 1D on Binance" width="640" height="400" style="border:0" loading="lazy"></iframe>
```

The embed shows the chart with its indicators and drawings, and the other charts of a layout if the link has them. Viewers can pan, zoom and use the crosshair. A footer shows the symbol, timeframe and last price, and **Open in Kandle** opens the same chart in a new tab as a normal share link. `width="100%"` fills the column. [docs/embed-example.html](docs/embed-example.html) is a minimal page with one embed.

An embed URL is a share link with `?embed=1` before the `#`. The chart stays in the fragment in the same format, so the query is the only part a server sees and it says nothing about the chart. Add `&theme=light` or `&theme=dark` to fix the colors; without it the embed follows the viewer's system setting.

What an embed leaves out:

- Scripts. Embed links never include them. If a link carries scripts anyway, the embed does not run them and says to open the chart in Kandle to run them.
- Browser storage. An embed reads and writes nothing there, so it never sees the viewer's own chart or API keys. Charts from sources that need a key (Twelve Data, Alpaca, Polygon) show a note instead, so embed charts from the crypto exchanges.
- Controls. There is no top bar, drawing toolbar, panel, alert, agent bridge, `window.kandle` or `postMessage` API, so the page around an embed cannot drive the chart.

Any site can frame Kandle. That is safe because Kandle has no account and nothing on a server: whatever it saves stays in the browser that uses it, and current browsers give a framed page storage of its own, apart from the viewer's Kandle tab. An embed has no action that changes or deletes anything. GitHub does not show iframes in README files, so link to the chart there instead.

Agents get the iframe from `get_share_link` with `embed: true`. In the page, `await window.kandle.share({ embed: true, theme: 'dark' })` returns the embed URL and `await window.kandle.embedCode({ width: 800, height: 450 })` returns the iframe.

## Roadmap

- Desktop app for macOS, Windows, and Linux.
- Larger CSV imports stored in IndexedDB.

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
  watchlist/         watchlist panel, quotes and their persistence
  share/             share links: encoding, the Share popover and the shared chart view
  embed/             embed mode: the chart alone in an iframe on another site
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
| CSV | Your own data | No | Never. See [CSV import](#csv-import) |

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

### CSV import

Load your own OHLCV data: click **Import CSV** in symbol search or in the CSV card of the **Data** dialog and pick a file, or drop a file on the chart. Kandle reads it in your browser and shows what it found, you give the dataset a name, and it opens on the chart. Nothing is uploaded.

Accepted files:

- A header row with a time column (`time`, `date`, `datetime`, `timestamp` or `open time`), `open`, `high`, `low`, `close` and an optional `volume`, in any order and any case. Separate `date` and `time` columns are joined. A file with no header is read as time, open, high, low, close and volume.
- Comma, semicolon or tab separated. In semicolon files a decimal comma (`1234,5`) works.
- Times as ISO 8601 (`2024-03-05T14:30:00Z`, with a zone), `YYYY-MM-DD`, `YYYY-MM-DD HH:mm` or `YYYY-MM-DD HH:mm:ss` (read as UTC), or Unix time in seconds or milliseconds.
- Rows are sorted by time. When two rows have the same time the later one is kept. Rows with an unreadable time or price, or a high below the low, are skipped and counted.

The timeframe comes from the median gap between bars, so daily stock data without weekends is still 1D. Bars that fit no timeframe but divide one, such as 30-minute bars, are combined into the next one (1H). The chart can show a dataset in its own timeframe and longer ones, which are built from its bars; shorter timeframe buttons are disabled.

Datasets are saved in this browser's local storage (up to 2.5 MB each and 4 MB in total, about 40,000 bars per dataset), appear in symbol search under **CSV** with a CSV badge, come back when you reload, and can be deleted in the Data dialog. Scripts, strategy backtests, `request.security` on higher timeframes, drawings, bar replay and multi-chart layouts work on them. The data never updates, so alerts on a CSV chart never fire. Agents can open a dataset with `set_symbol` and exchange `csv`.

![An imported BTC daily CSV file with a weekly EMA script, and the Import CSV dialog](docs/screenshot-csv.png)

## License

MIT. See [LICENSE](LICENSE).

Charts are drawn with [KLineChart](https://github.com/klinecharts/KLineChart), licensed under Apache-2.0. The script editor uses [CodeMirror](https://codemirror.net), licensed under MIT. Their notices are in `public/third-party-notices.txt`.
