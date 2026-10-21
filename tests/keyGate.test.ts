import { describe, expect, it, vi } from 'vitest';
import type { SharedChart } from '../src/share/codec';
import { KeyGate, keyedSources } from '../src/share/keyGate';

const chart = (source: string, panes: string[] = []): SharedChart => ({
  source,
  symbol: 'AAPL',
  timeframe: '1h',
  ...(panes.length
    ? { layout: { count: 4, sync: { crosshair: false, timeframe: false, symbol: false }, panes: panes.map((p) => ({ source: p, symbol: 'AAPL', timeframe: '1h' as const, indicators: [] })) } }
    : {}),
});

describe('keyed sources in a shared view', () => {
  it('holds the keyed sources of the chart and its layout that have a key saved', () => {
    const saved = () => true;
    expect(keyedSources(chart('binance'), saved)).toEqual([]);
    expect(keyedSources(chart('polygon'), saved)).toEqual(['polygon']);
    expect(keyedSources(chart('binance', ['twelvedata', 'okx', 'alpaca']), saved).sort()).toEqual(['alpaca', 'twelvedata']);
    // Without a saved key there is nothing of the viewer's to spend.
    expect(keyedSources(chart('polygon', ['alpaca']), (s) => s.id === 'alpaca')).toEqual(['alpaca']);
  });

  it('lets a source go once, telling every listener', () => {
    const gate = new KeyGate();
    const seen = vi.fn();
    const off = gate.onRelease(seen);
    gate.hold(['polygon', 'alpaca']);
    expect(gate.holds('polygon')).toBe(true);
    expect(gate.holds('binance')).toBe(false);

    gate.release('polygon');
    gate.release('polygon');
    expect(gate.holds('polygon')).toBe(false);
    expect(seen.mock.calls).toEqual([['polygon']]);

    gate.releaseAll();
    expect(gate.holds('alpaca')).toBe(false);
    expect(seen.mock.calls).toEqual([['polygon'], ['alpaca']]);

    off();
    gate.hold(['polygon']);
    gate.releaseAll();
    expect(seen).toHaveBeenCalledTimes(2);
  });
});
