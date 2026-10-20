# Kandle

**免费、开源的加密货币、股票和外汇图表工具，并且可以让你的 AI 助手直接操作。**

指标、画线工具、自定义脚本、价格提醒、K 线回放，以及最多四个图表同屏显示。无需注册，没有付费墙，指标数量不限。在浏览器中运行，所有数据都保存在你自己的电脑上。

Claude Code、Codex、Cursor 或 Gemini CLI 可以读取图表、画出支撑位和阻力位、添加指标、编写脚本、设置提醒，你可以在旁边实时看到每一步。

**[在浏览器中打开 Kandle](https://kernel-hunter.github.io/kandle/)** · [连接 AI 助手](#连接-ai-助手) · [编写脚本](#脚本)

[English](README.md) · [简体中文](README.zh-CN.md)

![Kandle 在 BTC/USDT 4 小时图上显示阻力位、支撑区、EMA 交叉脚本和 RSI](docs/hero.png)

## 连接 AI 助手

Claude Code 只需一行：

```sh
claude mcp add kandle -- npx -y --package=https://github.com/Kernel-Hunter/kandle/releases/download/v0.6.0/kandle-mcp-0.6.0.tgz kandle-mcp
```

然后打开 Kandle，点击顶部的 **Agent**，粘贴助手给你的配对码（它会调用 `get_bridge_status`，配对码也保存在 `~/.kandle/bridge-token`），再打开 **Agent bridge**。之后可以直接说：“在 BTC 上标出最近的波段高点和低点，并在两者之间画斐波那契回撤。”

Codex（`~/.codex/config.toml`）：

```toml
[mcp_servers.kandle]
command = "npx"
args = ["-y", "--package=https://github.com/Kernel-Hunter/kandle/releases/download/v0.6.0/kandle-mcp-0.6.0.tgz", "kandle-mcp"]
```

Cursor（`~/.cursor/mcp.json`）和 Gemini CLI（`~/.gemini/settings.json`）：

```json
{
  "mcpServers": {
    "kandle": {
      "command": "npx",
      "args": ["-y", "--package=https://github.com/Kernel-Hunter/kandle/releases/download/v0.6.0/kandle-mcp-0.6.0.tgz", "kandle-mcp"]
    }
  }
}
```

Claude Desktop：下载 [kandle-mcp-0.6.0.mcpb](https://github.com/Kernel-Hunter/kandle/releases/download/v0.6.0/kandle-mcp-0.6.0.mcpb) 并打开即可安装。Kandle 也已收录在 [MCP Registry](https://registry.modelcontextprotocol.io/)，名称为 `io.github.Kernel-Hunter/kandle`。

只需要 Node.js 22.12 或更高版本。使用在线版时，浏览器可能会询问该页面是否可以访问本地网络设备，请允许，这样页面才能连接到 `127.0.0.1` 上的 `kandle-mcp`。

助手可以使用 22 个工具：读取图表状态和 K 线数据、切换品种和周期、添加或删除指标、画线（趋势线、水平线、射线、矩形、斐波那契回撤、文字标注等）、截图、设置提醒、K 线回放、多图布局、图表类型和价格坐标，运行脚本以及读取策略回测结果。[`skills/kandle/SKILL.md`](skills/kandle/SKILL.md) 提供了支撑阻力、趋势分析、指标共振等分析流程。

安全性：桥接服务只监听 `127.0.0.1`；默认关闭，需要你手动打开；每个连接都必须先发送配对码；只接受来自本机页面和官方在线版的连接，并检查 `Host` 头以防止 DNS 重绑定。完整说明见 [English README](README.md#security-model)。

![AI 助手在 BTC/USDT 上标出了 120 根 K 线的最高点和最低点、斐波那契回撤和一条注释](docs/screenshot-agent.png)

## 功能

- 来自 Binance、Coinbase、Bybit、OKX 和 Kraken 公开行情接口的实时加密货币 K 线，无需 API key。
- 使用你自己的免费 key，通过 Twelve Data、Alpaca 或 Polygon 查看美股及全球股票、ETF 和外汇。key 只保存在你的浏览器中，只会发送给对应的数据提供商。
- 周期：1m、5m、15m、1H、4H、1D、1W。向左滚动可加载更早的历史数据。
- 图表类型：蜡烛图、空心蜡烛图、美国线（OHLC）、折线图、面积图和平均 K 线（Heikin Ashi），价格坐标可选普通、对数或百分比（`Alt+C` 切换类型）。平均 K 线只改变画法，指标、脚本、回测、提醒和 AI 工具仍使用真实价格。
- 36 个内置指标，数量不限，所有参数都可以修改：MA、EMA、布林带、VWAP、Supertrend、一目均衡表、成交量分布、MACD、RSI、KDJ、ATR、OBV、DMI/ADX 等。
- 一目均衡表（Ichimoku）的云带会画到最新一根 K 线之后；成交量分布（Volume Profile）统计当前屏幕上的 K 线，标出成交量最大的价位（POC）和价值区域，滚动或缩放时自动更新。
- 画线工具：趋势线、射线、水平线、平行通道、矩形、斐波那契回撤、价格区间、文字标注，支持磁吸到 K 线价格。
- 价格提醒：价格穿越某个价位、你画的线或指标数值时，通过浏览器通知提醒。
- K 线回放：从历史上任意一根 K 线开始逐根播放。
- 1、2 或 4 个图表同屏，每个图表有自己的品种、周期和指标。
- 深色和浅色主题，键盘快捷键（在应用中按 `?` 查看），图表可导出为 PNG。

![BTC/USDT 4 小时图上的一目均衡表和可见区间成交量分布](docs/screenshot-ichimoku.png)

## 脚本

Kandle Script 可以编写自己的指标。它兼容大多数图表用户熟悉的脚本语言，很多现有的指标脚本几乎不用修改就能运行。点击 **Scripts**（或按 `Alt+S`）打开编辑器，按 `Ctrl+Enter`（Mac 上是 `Cmd+Enter`）添加到图表。

```
//@version=5
indicator("EMA cross", overlay = true)
fast = ta.ema(close, input.int(9, "Fast"))
slow = ta.ema(close, input.int(21, "Slow"))
plot(fast, "Fast", color.orange, 2)
plot(slow, "Slow", color.blue, 2)
plotshape(ta.crossover(fast, slow), "Up", shape.triangleup, location.belowbar, color.green)
```

### 策略回测

把 `indicator()` 换成 `strategy()`，脚本就会在图表已加载的 K 线上回测：用 `strategy.entry`、`strategy.exit`（止损、止盈、移动止损）、`strategy.close` 下单，成交以箭头标在 K 线图上，图表下方的 **Strategy** 标签页显示净利润、胜率、盈亏比、最大回撤、夏普比率、资金曲线和逐笔交易列表。订单在下一根 K 线成交：市价单按开盘价，限价单和止损单在价格触及时成交；同一根 K 线同时触及止损和止盈时，假设价格先走向离开盘价较近的高点或低点。在 **Indicators** 对话框里可以直接修改策略的回测设置（初始资金、下单数量、手续费、滑点、加仓次数、按收盘价成交），不用改代码，修改会随布局保存，**Reset** 恢复脚本里的设置。AI 助手通过 `run_script` 和 `get_backtest` 也能拿到同样的结果，`run_script` 的 `strategy` 参数也可以修改这些设置。完整说明见 [English README](README.md#strategies-and-backtesting)。

### 其他品种和周期

`request.security(symbol, timeframe, expression)` 可以在更高或更低的周期上计算表达式，也可以读取同一数据源的其他品种，例如在 Binance 的 BTCUSDT 图上用 `request.security("ETHUSDT", "D", close)` 读取 ETH 的日线收盘价，或用 `request.security(syminfo.tickerid, "D", ta.ema(close, 20))` 得到日线 EMA。品种和周期在一次运行中必须保持不变：可以是字符串，也可以来自输入项 `input.symbol`、`input.timeframe` 或 `input.string`。`input.timeframe` 在 **Indicators** 对话框中显示为周期下拉框（选 Chart 即跟随图表周期），`input.symbol` 显示为品种输入框，会提示当前数据源的品种；修改后脚本会重新运行并加载新的数据。随 K 线变化的值（例如 `close > open ? "ETHUSDT" : "SOLUSDT"`）会报错。每个脚本最多 5 组不同的品种和周期，一个输入项无论取什么值都只算一组。默认不使用未来数据：每根 K 线只看到在它收盘时已经收盘的那根高周期 K 线，只有最新一根 K 线会显示当天正在形成的值；`lookahead = barmerge.lookahead_on` 会在历史上看到未来数据，`gaps = barmerge.gaps_on` 只在高周期 K 线收盘的那根 K 线上返回值。详见 [English README](README.md#other-symbols-and-timeframes)。

支持的语法和函数列表见 [English README](README.md#what-is-supported)。除 `request.security` 外，其他 `request.*` 函数暂不支持。

## 导入 CSV

在品种搜索或 **Data** 对话框中点击 **Import CSV** 选择文件，或直接把文件拖到图表上，即可导入你自己的 OHLCV 数据。文件需要有表头，包含时间（time、date、datetime 或 timestamp）、open、high、low、close 和可选的 volume 列，顺序和大小写不限；支持逗号、分号或制表符分隔；时间可以是 ISO 8601、`YYYY-MM-DD`、`YYYY-MM-DD HH:mm`（按 UTC）或 Unix 秒、毫秒。周期由 K 线的中位间隔自动识别，图表可以切换到该周期及更高周期。数据只保存在浏览器本地，刷新后仍在，可以在 Data 对话框中删除。脚本、回测、画线、回放和多图布局都可以使用；数据不会更新，所以提醒不会触发。详见 [English README](README.md#csv-import)。

## 本地运行

需要 Node.js 22.12 或更高版本，以及 pnpm。

```sh
pnpm install
pnpm dev
```

## 许可证

MIT，见 [LICENSE](LICENSE)。图表使用 [KLineChart](https://github.com/klinecharts/KLineChart)（Apache-2.0），脚本编辑器使用 [CodeMirror](https://codemirror.net)（MIT）。
