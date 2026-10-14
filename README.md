# Kandle

Kandle is a free, open-source charting app for crypto markets. It runs in your browser, needs no account or API key, and keeps your layouts on your own machine.

Week 1 covers the core charting experience. Later work will add scripts, alerts, bar replay, multi-chart layouts, and an interface that AI agents can use to read and mark up charts.

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

## Roadmap

- Scripts: a scripting language for custom indicators, with an editor panel. Classic indicators will be rewritten as example scripts.
- Alerts on price, indicator values, and drawing crosses, delivered as browser notifications.
- Bar replay to step through history one candle at a time.
- Multi-chart layouts in a grid, free and without limits.
- AI agent support through an MCP server, so tools like Claude Code, Codex, Cursor, and Gemini CLI can read chart state, change symbols, add indicators, draw levels, and run scripts.
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
pnpm build    # type check and production build in dist/
pnpm preview  # serve the production build
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
tests/               unit tests
```

To add an exchange, implement the `DataSource` interface in `src/data/types.ts` and register it in `src/data/sources.ts`.

## Data

Market data comes straight from each exchange's public API in your browser. Kandle has no server and does not store or redistribute data. Exchange availability depends on your region; for Binance the app uses the public market data hosts first.

## License

MIT. See [LICENSE](LICENSE).

Charts are drawn with [KLineChart](https://github.com/klinecharts/KLineChart), licensed under Apache-2.0. Its notices are in `public/third-party-notices.txt`.
