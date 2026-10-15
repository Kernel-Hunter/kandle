---
name: kandle
description: Read, analyze and annotate live crypto charts in Kandle through the kandle MCP server. Use when the user asks about a chart, support and resistance, trend, indicators, levels to watch, alerts, bar replay, or wants their Kandle chart marked up.
---

# Kandle chart analysis

Kandle is an open-source charting app running in the user's browser. The `kandle` MCP server gives you tools to read the chart the user is looking at and to change it. Everything you draw appears on their screen right away.

## Before you start

1. Call `get_bridge_status`. If `connected` is false, give the user the pairing code from the result and ask them to click **Agent** in Kandle, paste it and turn on **Agent bridge**. Wait for them, then check again.
2. Call `get_chart_state` to learn the symbol, timeframe, last price, indicators (with ids and latest values), drawings (with ids), alerts, replay and layout.
3. If the user named a market or timeframe, call `set_symbol` and `set_timeframe` first. Symbols can be written as `BTCUSDT`, `BTC/USDT` or `BTC-USD` (Coinbase).

Use `get_candles` for numbers and `screenshot` to see what the user sees. Prefer numbers for analysis and a screenshot to check your drawings landed where you meant.

## Rules for every answer

- Describe what the chart shows. Do not tell the user to buy, sell or hold, do not give price targets as predictions, and do not size positions.
- End any analysis with one line such as: "This is a description of the chart, not financial advice."
- Quote the timeframe and the time range you looked at. Times from the tools are UTC.
- Round prices to the symbol's `price_precision`.
- Say when data is thin (few bars loaded, replay on, a fresh listing).
- Clean up after yourself if the user asks for a fresh chart: `clear_drawings`, `remove_indicator`.

## Workflow: support and resistance

1. `get_candles` with `limit` 300 on the current timeframe.
2. Find swing highs and lows: a bar whose high (low) is the highest (lowest) of the 5 bars on each side.
3. Cluster swings within about 0.5 percent of each other (use about 1 percent on 1D and 1W). Rank clusters by how many swings touch them and how recent the last touch is.
4. Keep the 2 or 3 strongest levels above the last price and the 2 or 3 below.
5. Draw each with `draw` type `horizontal_line` (only `price` is needed). Add a `text` note at the most recent touch, such as "R1, 4 touches".
6. Explain each level: how many touches, when, and how price reacted.

## Workflow: trend

1. `get_candles` with `limit` 200 and `include_indicators` true after making sure EMA 20, 50 and 200 are on the chart (`add_indicator` name `EMA` params `[20, 50, 200]` if not).
2. Classify: higher highs and higher lows with price above a rising EMA 50 is an uptrend; the mirror image is a downtrend; anything else is a range.
3. For a trend, connect the two most recent swing lows (uptrend) or swing highs (downtrend) with `draw` type `trend_line`, or `ray` to project it forward.
4. For a range, draw a `rectangle` from the first to the last bar of the range between its high and low.
5. State the evidence: swing points with times and prices, EMA order and slope.

## Workflow: indicator confluence

1. Make sure the indicators you need are on the chart: for example `RSI` `[14]`, `MACD` `[12, 26, 9]`, `BOLL` `[20, 2]`, `VOL`. `list_indicators` shows what is available and the line names of each.
2. `get_candles` with `include_indicators` true and `limit` 100.
3. Read each signal at the last closed bar (the last row can still be forming): RSI above 70 or below 30, MACD line against its signal line and zero, price against the Bollinger bands, volume against its average.
4. Report where signals agree and where they conflict. Agreement between unrelated indicators (momentum, trend, volatility, volume) counts for more than several momentum indicators saying the same thing.

## Workflow: annotate and explain

1. Do the analysis the user asked for with the workflows above.
2. Draw only what supports the explanation: levels, one or two trend lines, a `fib` from swing low to swing high (or high to low) if retracements matter, and short `text` notes.
3. `screenshot` and check the drawings are where you meant. Fix anything off with `remove_drawing` and `draw`.
4. Explain the chart in a few short paragraphs that point at the drawings by name.

## Alerts

- Price level: `set_alert` type `price`, `level`, `condition` (`crosses`, `crosses_up`, `crosses_down`, `touches`).
- A drawn line: draw it first, then `set_alert` type `drawing` with its `drawing_id`. Works for horizontal lines and rays, trend lines, rays and extended lines.
- An indicator: `set_alert` type `indicator`, `indicator_id` from `list_indicators`, `indicator_line` (for example `rsi1`), `level`.
- `frequency` `once` (default) or `every_time`. Alerts fire in the browser while the Kandle tab is open; tell the user that.

## Bar replay

Use replay to walk through history without seeing the future, for example to check how a level held. `start_replay` with `bars_back` or `start_time`, then `step_replay` and read the revealed bars. `stop_replay` returns to live data. While replay is on, `get_candles` only returns visible bars.

## Several charts

`set_layout` with `charts` 2 or 4 shows more charts; give `panes` a symbol and timeframe each, for example the same symbol on 1D, 4H, 1H and 15m. Pass `pane` to `get_chart_state`, `get_candles`, `add_indicator`, `screenshot` and the other pane tools. Drawings, alerts and replay apply to pane 1.
