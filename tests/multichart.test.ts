import { describe, expect, it } from 'vitest';
import { defaultConfig, gridShape, loadConfig, sanitizeConfig, saveConfig } from '../src/layout/config';
import { loadAgentSettings, saveAgentSettings } from '../src/agent/panel';
import { MemoryStorage } from '../src/store/layout';

describe('multi-chart config', () => {
  it('starts with one chart and three default extra panes', () => {
    const c = defaultConfig();
    expect(c.count).toBe(1);
    expect(c.panes.map((p) => p.symbol)).toEqual(['ETHUSDT', 'SOLUSDT', 'BNBUSDT']);
    expect(c.sync).toEqual({ crosshair: true, timeframe: false, symbol: false });
  });

  it('repairs bad stored data', () => {
    const c = sanitizeConfig({
      count: 3,
      sync: { crosshair: false, symbol: true },
      panes: [{ symbol: 'XRPUSDT', timeframe: '15m', indicators: [{ name: 'RSI', params: [14, 'x'] }, { bogus: 1 }] }, 'junk'],
    });
    expect(c.count).toBe(1);
    expect(c.sync).toEqual({ crosshair: false, timeframe: false, symbol: true });
    expect(c.panes[0]).toEqual({ source: 'binance', symbol: 'XRPUSDT', timeframe: '15m', indicators: [{ name: 'RSI', params: [14] }] });
    expect(c.panes[1].symbol).toBe('SOLUSDT');
    expect(c.panes).toHaveLength(3);
    expect(sanitizeConfig('nonsense')).toEqual(defaultConfig());
  });

  it('round-trips through storage', () => {
    const storage = new MemoryStorage();
    const c = { ...defaultConfig(), count: 4 as const };
    c.panes[2] = { source: 'coinbase', symbol: 'BTC-USD', timeframe: '1D', indicators: [] };
    expect(saveConfig(storage, c)).toBe(true);
    expect(loadConfig(storage)).toEqual(c);
    storage.setItem('kandle:multichart', '{oops');
    expect(loadConfig(storage)).toEqual(defaultConfig());
  });

  it('maps chart counts to grid shapes', () => {
    expect(gridShape(1)).toEqual({ columns: 1, rows: 1 });
    expect(gridShape(2)).toEqual({ columns: 2, rows: 1 });
    expect(gridShape(4)).toEqual({ columns: 2, rows: 2 });
  });
});

describe('agent settings', () => {
  it('are off by default and survive a round trip', () => {
    const storage = new MemoryStorage();
    expect(loadAgentSettings(storage)).toEqual({ enabled: false, port: 7457, token: '' });
    saveAgentSettings(storage, { enabled: true, port: 9000, token: 'ABCD-EFGH-JKLM' });
    expect(loadAgentSettings(storage)).toEqual({ enabled: true, port: 9000, token: 'ABCD-EFGH-JKLM' });
    storage.setItem('kandle:agent', JSON.stringify({ enabled: 'yes', port: 99999 }));
    expect(loadAgentSettings(storage)).toEqual({ enabled: false, port: 7457, token: '' });
  });
});
