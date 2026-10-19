/** Example scripts shown in the editor's Examples menu. Written for Kandle; free to copy. */
export interface ScriptExample {
  name: string;
  source: string;
}

export const EXAMPLES: readonly ScriptExample[] = [
  {
    name: 'Moving average cross',
    source: `//@version=5
indicator("MA Cross", overlay = true)
fastLen = input.int(9, "Fast length", minval = 1)
slowLen = input.int(21, "Slow length", minval = 1)

fast = ta.sma(close, fastLen)
slow = ta.sma(close, slowLen)

plot(fast, "Fast", color.orange, 2)
plot(slow, "Slow", color.blue, 2)
plotshape(ta.crossover(fast, slow), "Cross up", shape.triangleup, location.belowbar, color.green, size = size.small)
plotshape(ta.crossunder(fast, slow), "Cross down", shape.triangledown, location.abovebar, color.red, size = size.small)
`,
  },
  {
    name: 'RSI with bands',
    source: `//@version=5
indicator("RSI Bands", shorttitle = "RSI")
len = input.int(14, "Length", minval = 1)
src = input.source(close, "Source")
upper = input.int(70, "Overbought")
lower = input.int(30, "Oversold")

r = ta.rsi(src, len)
lineColor = r > upper ? color.red : r < lower ? color.green : color.purple

plot(r, "RSI", lineColor, 2)
top = hline(upper, "Overbought", color.gray, hline.style_dashed)
bottom = hline(lower, "Oversold", color.gray, hline.style_dashed)
hline(50, "Middle", color.new(color.gray, 60), hline.style_dotted)
fill(top, bottom, color.new(color.purple, 92))
`,
  },
  {
    name: 'MACD',
    source: `//@version=5
indicator("MACD Histogram", shorttitle = "MACD")
fastLen = input.int(12, "Fast length")
slowLen = input.int(26, "Slow length")
signalLen = input.int(9, "Signal length")

[macdLine, signalLine, hist] = ta.macd(close, fastLen, slowLen, signalLen)

// Brighter bars while the histogram grows, faded while it shrinks.
growing = hist > nz(hist[1])
histColor = hist >= 0 ? (growing ? color.teal : color.new(color.teal, 55)) : (growing ? color.new(color.red, 55) : color.red)

plot(hist, "Histogram", histColor, style = plot.style_columns)
plot(macdLine, "MACD", color.blue, 2)
plot(signalLine, "Signal", color.orange, 2)
hline(0, "Zero", color.gray)
`,
  },
  {
    name: 'Bollinger Bands',
    source: `//@version=5
indicator("Bollinger Bands", shorttitle = "BB", overlay = true)
len = input.int(20, "Length", minval = 1)
mult = input.float(2.0, "Deviations", minval = 0.1, step = 0.1)

[basis, upper, lower] = ta.bb(close, len, mult)

plot(basis, "Basis", color.orange)
pUpper = plot(upper, "Upper", color.blue)
pLower = plot(lower, "Lower", color.blue)
fill(pUpper, pLower, color.new(color.blue, 92))
`,
  },
  {
    name: 'Supertrend',
    source: `//@version=5
indicator("Supertrend Lines", shorttitle = "ST", overlay = true)
factor = input.float(3.0, "Factor", minval = 0.1, step = 0.1)
atrLen = input.int(10, "ATR length", minval = 1)

[line, dir] = ta.supertrend(factor, atrLen)
upTrend = dir < 0

plot(upTrend ? line : na, "Up trend", color.green, 2, plot.style_linebr)
plot(upTrend ? na : line, "Down trend", color.red, 2, plot.style_linebr)
plotshape(upTrend and dir[1] > 0, "Turned up", shape.labelup, location.belowbar, color.green, text = "Up", textcolor = color.green)
plotshape(not upTrend and dir[1] < 0, "Turned down", shape.labeldown, location.abovebar, color.red, text = "Down", textcolor = color.red)
`,
  },
  {
    name: 'VWAP bands',
    source: `//@version=5
indicator("VWAP Bands", overlay = true)
mult = input.float(1.0, "Band width (std dev)", minval = 0.1, step = 0.5)

// Restart the average at the start of every UTC day.
[vwapLine, upper, lower] = ta.vwap(hlc3, timeframe.change("D"), mult)

plot(vwapLine, "VWAP", color.purple, 2, plot.style_linebr)
pUpper = plot(upper, "Upper", color.new(color.purple, 50), style = plot.style_linebr)
pLower = plot(lower, "Lower", color.new(color.purple, 50), style = plot.style_linebr)
fill(pUpper, pLower, color.new(color.purple, 94))
`,
  },
  {
    name: 'Stochastic',
    source: `//@version=5
indicator("Stochastic Oscillator", shorttitle = "Stoch")
kLen = input.int(14, "%K length", minval = 1)
kSmooth = input.int(3, "%K smoothing", minval = 1)
dLen = input.int(3, "%D length", minval = 1)

k = ta.sma(ta.stoch(close, high, low, kLen), kSmooth)
d = ta.sma(k, dLen)

plot(k, "%K", color.blue)
plot(d, "%D", color.orange)
h1 = hline(80, "Upper", color.gray, hline.style_dashed)
h2 = hline(20, "Lower", color.gray, hline.style_dashed)
fill(h1, h2, color.new(color.blue, 94))
`,
  },
  {
    name: 'ATR trailing stop',
    source: `//@version=5
indicator("ATR Trailing Stop", overlay = true)
len = input.int(14, "ATR length", minval = 1)
mult = input.float(3.0, "ATR multiplier", minval = 0.1, step = 0.5)

loss = mult * ta.atr(len)
var float stop = na
prev = nz(stop, close)

// The stop only moves in the direction of the trend, and flips when price crosses it.
stop := if close > prev and close[1] > prev
    math.max(prev, close - loss)
else if close < prev and close[1] < prev
    math.min(prev, close + loss)
else if close > prev
    close - loss
else
    close + loss

isLong = close > stop
plot(stop, "Stop", isLong ? color.green : color.red, 2, plot.style_stepline)
plotshape(isLong and not isLong[1], "Long", shape.circle, location.belowbar, color.green, size = size.tiny)
plotshape(not isLong and isLong[1], "Short", shape.circle, location.abovebar, color.red, size = size.tiny)
`,
  },
  {
    name: 'Donchian breakout',
    source: `//@version=5
indicator("Donchian Breakout", overlay = true)
len = input.int(20, "Length", minval = 1)

// Channel of the previous bars, so the current bar can break out of it.
upper = ta.highest(high, len)[1]
lower = ta.lowest(low, len)[1]
middle = (upper + lower) / 2

pUpper = plot(upper, "Upper", color.teal)
pLower = plot(lower, "Lower", color.teal)
plot(middle, "Middle", color.new(color.teal, 50))
fill(pUpper, pLower, color.new(color.teal, 94))
plotshape(close > upper, "Breakout", shape.triangleup, location.belowbar, color.green, size = size.tiny)
plotshape(close < lower, "Breakdown", shape.triangledown, location.abovebar, color.red, size = size.tiny)
`,
  },
  {
    name: 'Volume spikes',
    source: `//@version=5
indicator("Volume Spikes", format = format.volume)
len = input.int(20, "Average length", minval = 1)
mult = input.float(2.0, "Spike multiple", minval = 1, step = 0.1)

avg = ta.sma(volume, len)
spike = volume > avg * mult
barColor = spike ? color.orange : close >= open ? color.new(color.teal, 40) : color.new(color.red, 40)

plot(volume, "Volume", barColor, style = plot.style_columns)
plot(avg, "Average", color.blue)
bgcolor(spike ? color.new(color.orange, 88) : na)
`,
  },
  {
    name: 'Daily EMA trend filter',
    source: `//@version=5
indicator("Daily EMA Trend", overlay = true)
dailyLen = input.int(20, "Daily EMA length", minval = 1)
chartLen = input.int(21, "Chart EMA length", minval = 1)

// The daily EMA only changes once a day has closed, so history shows what was known then.
dailyEma = request.security(syminfo.tickerid, "D", ta.ema(close, dailyLen))
chartEma = ta.ema(close, chartLen)
trendUp = close > dailyEma and chartEma > dailyEma
trendDown = close < dailyEma and chartEma < dailyEma

plot(dailyEma, "Daily EMA", color.orange, 2, plot.style_stepline)
plot(chartEma, "Chart EMA", color.blue, 1)
bgcolor(trendUp ? color.new(color.green, 92) : trendDown ? color.new(color.red, 92) : na)
`,
  },
  {
    name: 'EMA cross strategy',
    source: `//@version=5
strategy("EMA Cross Strategy", shorttitle = "EMA Cross", overlay = true, initial_capital = 10000, default_qty_type = strategy.percent_of_equity, default_qty_value = 100, commission_type = strategy.commission.percent, commission_value = 0.05)
fastLen = input.int(12, "Fast EMA", minval = 1)
slowLen = input.int(26, "Slow EMA", minval = 1)

fast = ta.ema(close, fastLen)
slow = ta.ema(close, slowLen)

// Always in the market: a cross up goes long, a cross down reverses to short.
// Orders fill at the open of the next bar.
if ta.crossover(fast, slow)
    strategy.entry("Long", strategy.long)
if ta.crossunder(fast, slow)
    strategy.entry("Short", strategy.short)

plot(fast, "Fast", color.orange, 2)
plot(slow, "Slow", color.blue, 2)
`,
  },
  {
    name: 'RSI mean reversion strategy',
    source: `//@version=5
strategy("RSI Mean Reversion", shorttitle = "RSI MR", overlay = true, initial_capital = 10000, default_qty_type = strategy.percent_of_equity, default_qty_value = 50, commission_value = 0.05)
len = input.int(14, "RSI length", minval = 2)
oversold = input.int(30, "Buy when RSI crosses up")
overbought = input.int(70, "Sell when RSI crosses up")
stopPct = input.float(3.0, "Stop loss %", minval = 0.1, step = 0.5)
targetPct = input.float(4.0, "Take profit %", minval = 0.1, step = 0.5)

r = ta.rsi(close, len)

if ta.crossover(r, oversold) and strategy.position_size == 0
    strategy.entry("Long", strategy.long)
    // Stop and target in ticks from the fill price, placed together with the entry.
    ticksPerPct = close / 100 / syminfo.mintick
    strategy.exit("Exit", "Long", profit = targetPct * ticksPerPct, loss = stopPct * ticksPerPct, comment_profit = "Target", comment_loss = "Stop")
if ta.crossover(r, overbought)
    strategy.close("Long", comment = "RSI high")

inTrade = strategy.position_size > 0
plot(inTrade ? strategy.position_avg_price * (1 + targetPct / 100) : na, "Target", color.green, 1, plot.style_linebr)
plot(inTrade ? strategy.position_avg_price * (1 - stopPct / 100) : na, "Stop", color.red, 1, plot.style_linebr)
`,
  },
  {
    name: 'Donchian breakout strategy',
    source: `//@version=5
strategy("Donchian Breakout Strategy", shorttitle = "Breakout", overlay = true, initial_capital = 10000, default_qty_type = strategy.percent_of_equity, default_qty_value = 100, commission_value = 0.05, slippage = 2)
entryLen = input.int(20, "Entry channel", minval = 1)
exitLen = input.int(10, "Exit channel", minval = 1)

upper = ta.highest(high, entryLen)
lower = ta.lowest(low, entryLen)
exitLow = ta.lowest(low, exitLen)
exitHigh = ta.highest(high, exitLen)

// Stop orders just outside the channel fill on the breakout bar itself.
if strategy.position_size <= 0
    strategy.entry("Long", strategy.long, stop = upper + syminfo.mintick)
if strategy.position_size >= 0
    strategy.entry("Short", strategy.short, stop = lower - syminfo.mintick)
// Exit on a break of the shorter channel in the other direction.
strategy.exit("Long exit", "Long", stop = exitLow - syminfo.mintick)
strategy.exit("Short exit", "Short", stop = exitHigh + syminfo.mintick)

plot(upper, "Upper", color.teal)
plot(lower, "Lower", color.teal)
pos = strategy.position_size
plot(pos > 0 ? exitLow : pos < 0 ? exitHigh : na, "Exit level", color.orange, 1, plot.style_linebr)
`,
  },
];

/** What a new, empty script starts with. */
export const NEW_SCRIPT = `//@version=5
indicator("My script", overlay = true)
len = input.int(20, "Length", minval = 1)

plot(ta.ema(close, len), "EMA", color.blue, 2)
`;
