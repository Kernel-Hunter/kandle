import { describe, expect, it } from 'vitest';
import { TOPBAR_STEPS, planTopbar, type TopbarItemId, type TopbarSizes } from '../src/ui/topbarFit';

const items = (width: number, overrides: Partial<Record<TopbarItemId, number>> = {}): TopbarSizes['items'] => ({
  chartType: width,
  indicators: width,
  scripts: width,
  alerts: width,
  replay: width,
  layout: width,
  watchlist: width,
  data: width,
  agent: width,
  image: width,
  shortcuts: width,
  theme: width,
  ...overrides,
});

// Measured in Chrome with BTC/USDT on Binance. Phones and touch screens use 40px buttons.
const PHONE = { withLabels: 1292, iconsOnly: 998, items: items(44, { agent: 59 }), timeframes: 189, more: 44 };
const TABLET = { withLabels: 1543, iconsOnly: 1096, items: items(46, { chartType: 40, agent: 61, image: 38, shortcuts: 38, theme: 38 }), timeframes: 189, more: 38 };
const DESKTOP = { withLabels: 1691, iconsOnly: 1244, items: items(48, { chartType: 42, agent: 63, image: 40, shortcuts: 40, theme: 40 }), timeframes: 217, more: 40 };

describe('planTopbar', () => {
  it('keeps everything with labels on a wide screen', () => {
    expect(planTopbar({ ...DESKTOP, available: 1920 })).toEqual({ labels: true, overflow: [], compactTimeframes: false });
  });

  it('drops the labels first', () => {
    expect(planTopbar({ ...DESKTOP, available: 1440 })).toEqual({ labels: false, overflow: [], compactTimeframes: false });
  });

  it('moves the least needed buttons into the menu at 1024px', () => {
    expect(planTopbar({ ...DESKTOP, available: 1024 })).toEqual({
      labels: false,
      overflow: ['shortcuts', 'image', 'theme', 'data', 'agent', 'layout'],
      compactTimeframes: false,
    });
  });

  it('keeps the row of timeframes on a 768px tablet', () => {
    const plan = planTopbar({ ...TABLET, available: 768 });
    expect(plan.compactTimeframes).toBe(false);
    expect(plan.overflow).toEqual(['shortcuts', 'image', 'theme', 'data', 'agent', 'layout', 'replay', 'scripts', 'alerts']);
  });

  it.each([375, 390])('keeps the symbol, a timeframe dropdown and Indicators on a %ipx phone', (available) => {
    const plan = planTopbar({ ...PHONE, available });
    expect(plan.compactTimeframes).toBe(true);
    expect(plan.overflow).not.toContain('indicators');
    expect(plan.overflow).toEqual(TOPBAR_STEPS.filter((s) => s !== 'timeframes' && s !== 'indicators'));
  });

  it('counts the More button once', () => {
    // Moving one 40px button out adds the 40px More button, so it takes two to save room.
    const plan = planTopbar({ available: 960, withLabels: 1200, iconsOnly: 1000, items: items(40), timeframes: 200, more: 40 });
    expect(plan.overflow).toEqual(['shortcuts', 'image']);
  });

  it('skips items that are not in the bar', () => {
    const { data: _data, ...rest } = items(40);
    const plan = planTopbar({ available: 900, withLabels: 1200, iconsOnly: 1000, items: rest, timeframes: 200, more: 40 });
    expect(plan.overflow).toEqual(['shortcuts', 'image', 'theme', 'agent']);
  });

  it('brings back the most needed buttons when the dropdown frees more room than was missing', () => {
    // After 10 buttons and the dropdown the bar is at 440 of 500px, so Watchlist fits again but Alerts does not.
    const plan = planTopbar({ available: 500, withLabels: 1200, iconsOnly: 1000, items: items(40), timeframes: 200, more: 40 });
    expect(plan.compactTimeframes).toBe(true);
    expect(plan.overflow).toEqual(['shortcuts', 'image', 'theme', 'data', 'agent', 'layout', 'replay', 'scripts', 'alerts']);
  });

  it('removes the More button when every button comes back', () => {
    const plan = planTopbar({ available: 600, withLabels: 900, iconsOnly: 700, items: { theme: 40 }, timeframes: 200, more: 40 });
    expect(plan).toEqual({ labels: false, overflow: [], compactTimeframes: true });
  });

  it('moves everything when even that is not enough', () => {
    const plan = planTopbar({ available: 200, withLabels: 1200, iconsOnly: 1000, items: items(40), timeframes: 200, more: 40 });
    expect(plan.compactTimeframes).toBe(true);
    expect(plan.overflow).toHaveLength(12);
  });
});
