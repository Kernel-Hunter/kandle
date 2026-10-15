import { describe, expect, it } from 'vitest';
import { AlertEngine, crossed, describeAlert, lineValueAt, sanitizeAlert, touches, type NewAlert, type Tick } from '../src/alerts/engine';
import { MemoryStorage } from '../src/store/layout';

const H = 3_600_000;
const tick = (price: number, time = 0, high = price, low = price): Tick => ({ time, price, high, low });
const priceAlert = (level: number, extra: Partial<NewAlert> = {}): NewAlert => ({
  source: 'binance',
  symbol: 'BTCUSDT',
  kind: 'price',
  condition: 'crosses',
  frequency: 'once',
  level,
  ...extra,
});

describe('lineValueAt', () => {
  it('keeps horizontal lines flat everywhere', () => {
    const g = { name: 'horizontalStraightLine', points: [{ timestamp: 5 * H, value: 100 }] };
    expect(lineValueAt(g, 0)).toBe(100);
    expect(lineValueAt(g, 50 * H)).toBe(100);
  });

  it('starts horizontal rays at their anchor', () => {
    const g = { name: 'horizontalRayLine', points: [{ timestamp: 5 * H, value: 100 }] };
    expect(lineValueAt(g, 4 * H)).toBeNull();
    expect(lineValueAt(g, 6 * H)).toBe(100);
  });

  it('interpolates trend lines only between their points', () => {
    const g = { name: 'segment', points: [{ timestamp: 0, value: 100 }, { timestamp: 10 * H, value: 200 }] };
    expect(lineValueAt(g, 5 * H)).toBe(150);
    expect(lineValueAt(g, 11 * H)).toBeNull();
    expect(lineValueAt(g, -H)).toBeNull();
  });

  it('extends rays past the second point and extended lines both ways', () => {
    const points = [{ timestamp: 0, value: 100 }, { timestamp: 10 * H, value: 200 }];
    expect(lineValueAt({ name: 'rayLine', points }, 20 * H)).toBe(300);
    expect(lineValueAt({ name: 'rayLine', points }, -H)).toBeNull();
    expect(lineValueAt({ name: 'straightLine', points }, -10 * H)).toBe(0);
  });

  it('has no level for vertical or unknown drawings', () => {
    expect(lineValueAt({ name: 'segment', points: [{ timestamp: 1, value: 1 }, { timestamp: 1, value: 2 }] }, 1)).toBeNull();
    expect(lineValueAt({ name: 'rectangle', points: [{ timestamp: 0, value: 1 }, { timestamp: 1, value: 2 }] }, 0)).toBeNull();
  });
});

describe('crossed and touches', () => {
  it('detects direction from the gap to the level', () => {
    expect(crossed('crosses_up', -1, 1)).toBe(true);
    expect(crossed('crosses_up', 1, -1)).toBe(false);
    expect(crossed('crosses_down', 1, -1)).toBe(true);
    expect(crossed('crosses', 1, -1)).toBe(true);
    expect(crossed('crosses', 1, 2)).toBe(false);
  });

  it('counts landing on the level as a cross, once', () => {
    expect(crossed('crosses_up', -1, 0)).toBe(true);
    expect(crossed('crosses_up', 0, 1)).toBe(false);
  });

  it('touches when the level is inside the bar range', () => {
    expect(touches(100, 101, 99)).toBe(true);
    expect(touches(100, 99.5, 98)).toBe(false);
  });
});

describe('AlertEngine', () => {
  it('needs a baseline, then fires a once alert and disarms it', () => {
    const engine = new AlertEngine(new MemoryStorage());
    const a = engine.add(priceAlert(100));
    expect(engine.onTick('binance', 'BTCUSDT', tick(99))).toEqual([]);
    const fired = engine.onTick('binance', 'BTCUSDT', tick(101));
    expect(fired.map((f) => f.alert.id)).toEqual([a.id]);
    expect(fired[0].level).toBe(100);
    expect(engine.get(a.id)?.active).toBe(false);
    expect(engine.onTick('binance', 'BTCUSDT', tick(99))).toEqual([]);
  });

  it('can fire on the first update when seeded', () => {
    const engine = new AlertEngine(new MemoryStorage());
    engine.add(priceAlert(100, { condition: 'crosses_down' }), { value: 105, level: 100 });
    expect(engine.onTick('binance', 'BTCUSDT', tick(98))).toHaveLength(1);
  });

  it('ignores other symbols and exchanges', () => {
    const engine = new AlertEngine(new MemoryStorage());
    engine.add(priceAlert(100), { value: 99, level: 100 });
    expect(engine.onTick('binance', 'ETHUSDT', tick(101))).toEqual([]);
    expect(engine.onTick('coinbase', 'BTCUSDT', tick(101))).toEqual([]);
  });

  it('fires every-time alerts at most once per bar', () => {
    const engine = new AlertEngine(new MemoryStorage());
    engine.add(priceAlert(100, { frequency: 'every' }), { value: 99, level: 100 });
    expect(engine.onTick('binance', 'BTCUSDT', tick(101, 0))).toHaveLength(1);
    expect(engine.onTick('binance', 'BTCUSDT', tick(99, 0))).toHaveLength(0);
    expect(engine.onTick('binance', 'BTCUSDT', tick(101, 0))).toHaveLength(0);
    expect(engine.onTick('binance', 'BTCUSDT', tick(99, H))).toHaveLength(1);
  });

  it('respects crosses_up and crosses_down', () => {
    const engine = new AlertEngine(new MemoryStorage());
    engine.add(priceAlert(100, { condition: 'crosses_up', frequency: 'every' }), { value: 101, level: 100 });
    expect(engine.onTick('binance', 'BTCUSDT', tick(99, 0))).toHaveLength(0);
    expect(engine.onTick('binance', 'BTCUSDT', tick(101, H))).toHaveLength(1);
  });

  it('uses the bar range for touches, but not on the bar it was created in', () => {
    const engine = new AlertEngine(new MemoryStorage());
    engine.add(priceAlert(100, { condition: 'touches' }));
    expect(engine.onTick('binance', 'BTCUSDT', tick(102, 0, 103, 99))).toHaveLength(0);
    expect(engine.onTick('binance', 'BTCUSDT', tick(102, H, 103, 99.5))).toHaveLength(1);
  });

  it('follows a trend line as it rises', () => {
    const engine = new AlertEngine(new MemoryStorage());
    engine.add({
      source: 'binance',
      symbol: 'BTCUSDT',
      kind: 'drawing',
      condition: 'crosses_down',
      frequency: 'once',
      drawing: { name: 'rayLine', points: [{ timestamp: 0, value: 100 }, { timestamp: 10 * H, value: 110 }] },
    });
    // Price stays at 108 while the line climbs through it.
    expect(engine.onTick('binance', 'BTCUSDT', tick(108, 5 * H))).toHaveLength(0); // line 105
    expect(engine.onTick('binance', 'BTCUSDT', tick(108, 10 * H))).toHaveLength(1); // line 110
  });

  it('follows a moved drawing and stores its new position', () => {
    const storage = new MemoryStorage();
    const engine = new AlertEngine(storage);
    const a = engine.add({
      source: 'binance',
      symbol: 'BTCUSDT',
      kind: 'drawing',
      condition: 'crosses',
      frequency: 'once',
      drawing: { id: 'o1', name: 'horizontalStraightLine', points: [{ timestamp: 0, value: 100 }] },
    });
    const moved = { id: 'o1', name: 'horizontalStraightLine', points: [{ timestamp: 0, value: 120 }] };
    engine.onTick('binance', 'BTCUSDT', tick(119), { drawing: () => moved });
    expect(engine.onTick('binance', 'BTCUSDT', tick(121), { drawing: () => moved })).toHaveLength(1);
    expect(new AlertEngine(storage).get(a.id)?.drawing?.points[0].value).toBe(120);
  });

  it('watches indicator values and can be limited by kind', () => {
    const engine = new AlertEngine(new MemoryStorage());
    engine.add({ source: 'binance', symbol: 'BTCUSDT', kind: 'indicator', condition: 'crosses_up', frequency: 'once', level: 70, indicator: { name: 'RSI', line: 'rsi1' } });
    let rsi = 65;
    const ctx = { indicatorValue: () => rsi };
    expect(engine.onTick('binance', 'BTCUSDT', tick(1), ctx, ['indicator'])).toHaveLength(0);
    rsi = 72;
    expect(engine.onTick('binance', 'BTCUSDT', tick(1), ctx, ['price'])).toHaveLength(0);
    expect(engine.onTick('binance', 'BTCUSDT', tick(1), ctx, ['indicator'])).toHaveLength(1);
  });

  it('skips indicator alerts when the indicator is gone', () => {
    const engine = new AlertEngine(new MemoryStorage());
    engine.add({ source: 'binance', symbol: 'BTCUSDT', kind: 'indicator', condition: 'crosses', frequency: 'once', level: 70, indicator: { name: 'RSI', line: 'rsi1' } }, { value: 60, level: 70 });
    expect(engine.onTick('binance', 'BTCUSDT', tick(1), { indicatorValue: () => null })).toHaveLength(0);
  });

  it('persists, re-arms, removes and clears', () => {
    const storage = new MemoryStorage();
    const engine = new AlertEngine(storage);
    const a = engine.add(priceAlert(100), { value: 99, level: 100 });
    engine.add(priceAlert(200));
    engine.onTick('binance', 'BTCUSDT', tick(101));
    const reloaded = new AlertEngine(storage);
    expect(reloaded.list()).toHaveLength(2);
    expect(reloaded.get(a.id)).toMatchObject({ active: false, triggerCount: 1 });
    reloaded.setActive(a.id, true);
    expect(reloaded.get(a.id)?.active).toBe(true);
    expect(reloaded.remove(a.id)).toBe(true);
    expect(reloaded.remove('missing')).toBe(false);
    expect(reloaded.clear()).toBe(1);
    expect(new AlertEngine(storage).list()).toEqual([]);
  });

  it('notifies listeners on change', () => {
    const engine = new AlertEngine(new MemoryStorage());
    let calls = 0;
    engine.onChange(() => calls++);
    engine.add(priceAlert(1));
    expect(calls).toBe(1);
  });

  it('survives corrupt storage', () => {
    const storage = new MemoryStorage();
    storage.setItem('kandle:alerts', '{not json');
    expect(new AlertEngine(storage).list()).toEqual([]);
  });
});

describe('sanitizeAlert and describeAlert', () => {
  it('rejects incomplete alerts', () => {
    expect(sanitizeAlert({ id: 'a', source: 's', symbol: 'X', kind: 'price', condition: 'crosses' })).toBeNull();
    expect(sanitizeAlert({ id: 'a', source: 's', symbol: 'X', kind: 'drawing', condition: 'crosses' })).toBeNull();
    expect(sanitizeAlert({ id: 'a', source: 's', symbol: 'X', kind: 'price', condition: 'sideways', level: 1 })).toBeNull();
    expect(sanitizeAlert(null)).toBeNull();
  });

  it('describes alerts for people', () => {
    const a = sanitizeAlert({ id: 'a', source: 'binance', symbol: 'BTCUSDT', kind: 'price', condition: 'crosses_up', level: 65000.5 })!;
    expect(describeAlert(a)).toBe('BTCUSDT price crosses up 65000.5');
    const d = sanitizeAlert({ id: 'b', source: 'binance', symbol: 'BTCUSDT', kind: 'drawing', condition: 'crosses', drawing: { name: 'horizontalStraightLine', points: [{ timestamp: 0, value: 60000 }] } })!;
    expect(describeAlert(d)).toBe('BTCUSDT price crosses horizontal line at 60000');
    const i = sanitizeAlert({ id: 'c', source: 'binance', symbol: 'BTCUSDT', kind: 'indicator', condition: 'crosses_down', level: 30, indicator: { name: 'RSI', line: 'rsi1', params: [14] } })!;
    expect(describeAlert(i)).toBe('BTCUSDT RSI(14) rsi1 crosses down 30');
  });
});
