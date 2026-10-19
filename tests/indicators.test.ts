import { describe, expect, it, vi } from 'vitest';
import { ichimoku, type Bar } from '../src/chart/ta';
import { rowPrice, volumeProfile, type VolumeProfile } from '../src/chart/profile';
import { INDICATORS, getIndicatorDef } from '../src/chart/indicators';
import { makeCandles } from './script/fixtures';

// The chart engine touches `window` on import; these tests only need the catalog and the math.
vi.mock('klinecharts', () => ({ registerIndicator: vi.fn() }));

// ------------------------------------------------------------------ reference implementations
// Whole-array versions written straight from the definitions. They share no code with src/chart.

type S = number[];

/** (highest high + lowest low) / 2 over the last n bars, NaN until n bars exist. */
function refMid(bars: Bar[], n: number): S {
  return bars.map((_, i) => {
    if (i < n - 1) return NaN;
    const w = bars.slice(i - n + 1, i + 1);
    return (Math.max(...w.map((b) => b.high)) + Math.min(...w.map((b) => b.low))) / 2;
  });
}

/** Moves a series `k` bars to the right (k > 0) or left (k < 0), padding with NaN. */
function shift(x: S, k: number): S {
  return x.map((_, i) => (i - k >= 0 && i - k < x.length ? x[i - k] : NaN));
}

function refIchimoku(bars: Bar[], conv: number, base: number, spanB: number, disp: number) {
  const tenkan = refMid(bars, conv);
  const kijun = refMid(bars, base);
  const leadA = tenkan.map((t, i) => (t + kijun[i]) / 2);
  const leadB = refMid(bars, spanB);
  return {
    conversion: tenkan,
    base: kijun,
    leadA,
    leadB,
    spanA: shift(leadA, disp),
    spanB: shift(leadB, disp),
    lagging: shift(bars.map((b) => b.close), -disp),
  };
}

/**
 * Volume profile by brute force: for every row and every bar, the share of the bar's range
 * that falls inside the row. Point of control and value area from sorted candidates.
 */
function refProfile(bars: Bar[], rows: number, percent: number) {
  const low = Math.min(...bars.map((b) => b.low));
  const high = Math.max(...bars.map((b) => b.high));
  const step = (high - low) / rows;
  const volumes: S = [];
  for (let r = 0; r < rows; r++) {
    const bottom = low + r * step;
    const top = r === rows - 1 ? high : low + (r + 1) * step;
    let sum = 0;
    for (const b of bars) {
      const v = b.volume ?? 0;
      if (b.high === b.low) {
        const row = Math.min(rows - 1, Math.floor((b.low - low) / step));
        if (row === r) sum += v;
      } else {
        sum += (v * Math.max(0, Math.min(top, b.high) - Math.max(bottom, b.low))) / (b.high - b.low);
      }
    }
    volumes.push(sum);
  }
  const total = bars.reduce((a, b) => a + (b.volume ?? 0), 0);
  const middle = (rows - 1) / 2;
  const order = volumes.map((v, r) => ({ v, r })).sort((a, b) => b.v - a.v || Math.abs(a.r - middle) - Math.abs(b.r - middle) || a.r - b.r);
  const poc = order[0].r;
  let lo = poc;
  let hi = poc;
  const inArea = () => volumes.slice(lo, hi + 1).reduce((a, b) => a + b, 0);
  while (inArea() < (total * percent) / 100 && (lo > 0 || hi < rows - 1)) {
    const up = hi + 1 < rows ? volumes[hi + 1] : -Infinity;
    const down = lo - 1 >= 0 ? volumes[lo - 1] : -Infinity;
    if (up >= down) hi++;
    else lo--;
  }
  return { low, high, volumes, total, poc, valueLow: lo, valueHigh: hi };
}

// ------------------------------------------------------------------ helpers

const BARS = makeCandles(300, 7);

function close(a: number | undefined, b: number): void {
  if (Number.isNaN(b)) expect(a).toBeUndefined();
  else {
    expect(a).toBeDefined();
    expect(Math.abs((a as number) - b)).toBeLessThan(1e-9);
  }
}

const bar = (low: number, high: number, volume: number): Bar => ({ low, high, close: (low + high) / 2, volume, timestamp: 0 });

// ------------------------------------------------------------------ Ichimoku

describe('Ichimoku', () => {
  it('matches the reference for default and other parameters', () => {
    for (const [c, b, s, d] of [
      [9, 26, 52, 26],
      [7, 22, 44, 22],
      [20, 60, 120, 30],
      [1, 1, 1, 0],
    ]) {
      const got = ichimoku(BARS, c, b, s, d);
      const want = refIchimoku(BARS, c, b, s, d);
      expect(got).toHaveLength(BARS.length);
      for (let i = 0; i < BARS.length; i++) {
        close(got[i].conversion, want.conversion[i]);
        close(got[i].base, want.base[i]);
        close(got[i].leadA, want.leadA[i]);
        close(got[i].leadB, want.leadB[i]);
        close(got[i].spanA, want.spanA[i]);
        close(got[i].spanB, want.spanB[i]);
        close(got[i].lagging, want.lagging[i]);
      }
    }
  });

  it('shifts the leading spans forward and the lagging span back by the displacement', () => {
    const d = 26;
    const rows = ichimoku(BARS, 9, 26, 52, d);
    const n = BARS.length;
    // First defined values: span B needs 52 bars, then moves 26 ahead.
    expect(rows[51 + d - 1].spanB).toBeUndefined();
    expect(rows[51 + d].spanB).toBe(rows[51].leadB);
    expect(rows[25 + d].spanA).toBe(rows[25].leadA);
    for (let i = d; i < n; i++) {
      expect(rows[i].spanA).toBe(rows[i - d].leadA);
      expect(rows[i].spanB).toBe(rows[i - d].leadB);
    }
    // The lagging span shows the close from d bars later, so the newest d bars have none.
    expect(rows[n - d - 1].lagging).toBe(BARS[n - 1].close);
    for (let i = n - d; i < n; i++) expect(rows[i].lagging).toBeUndefined();
    // The cloud ahead of the last bar comes from the unshifted values of the last d bars.
    expect(rows.slice(n - d).every((r) => r.leadA !== undefined && r.leadB !== undefined)).toBe(true);
  });

  it('computes a small case by hand', () => {
    const bars = [bar(1, 3, 1), bar(2, 6, 1), bar(4, 5, 1), bar(0, 2, 1)];
    const rows = ichimoku(bars, 2, 3, 4, 1);
    // Conversion over 2 bars: (6+1)/2, (6+2)/2, (5+0)/2
    expect(rows.map((r) => r.conversion)).toEqual([undefined, 3.5, 4, 2.5]);
    // Base over 3 bars: (6+1)/2, (6+0)/2
    expect(rows.map((r) => r.base)).toEqual([undefined, undefined, 3.5, 3]);
    expect(rows.map((r) => r.leadA)).toEqual([undefined, undefined, 3.75, 2.75]);
    expect(rows.map((r) => r.leadB)).toEqual([undefined, undefined, undefined, 3]);
    expect(rows.map((r) => r.spanA)).toEqual([undefined, undefined, undefined, 3.75]);
    expect(rows.map((r) => r.lagging)).toEqual([4, 4.5, 1, undefined]);
  });
});

// ------------------------------------------------------------------ volume profile

describe('volume profile', () => {
  it('splits each bar over the rows it spans', () => {
    // Range 0..10 in 5 rows of 2. A covers everything (20 per row), B sits in row 1,
    // C has no range at price 4, which is the bottom of row 2.
    const p = volumeProfile([bar(0, 10, 100), bar(2, 4, 30), bar(4, 4, 10)], 5, 70) as VolumeProfile;
    expect(p.low).toBe(0);
    expect(p.high).toBe(10);
    expect(p.step).toBe(2);
    expect(p.volumes).toEqual([20, 50, 30, 20, 20]);
    expect(p.total).toBe(140);
    expect(p.poc).toBe(1);
    expect(rowPrice(p, p.poc)).toBe(3);
    // 70% of 140 is 98: 50, then 30 above beats 20 below (80), then the 20/20 tie goes up (100).
    expect([p.valueLow, p.valueHigh]).toEqual([1, 3]);
  });

  it('splits a bar unevenly when it covers part of a row', () => {
    // Range 0..4 in 4 rows. The second bar covers 1.5..3: half of row 1, all of row 2.
    const p = volumeProfile([bar(0, 4, 0), bar(1.5, 3, 30)], 4, 50) as VolumeProfile;
    expect(p.volumes).toEqual([0, 10, 20, 0]);
    expect(p.poc).toBe(2);
    // 50% of 30 is 15, and the point of control alone holds 20.
    expect([p.valueLow, p.valueHigh]).toEqual([2, 2]);
  });

  it('breaks point of control ties toward the middle, then downward', () => {
    // Four rows of 1 between 0 and 4, volumes 10, 10, 5, 10. Middle is 1.5, so row 1 wins.
    let p = volumeProfile([bar(0, 1, 10), bar(1, 2, 10), bar(2, 3, 5), bar(3, 4, 10)], 4, 70) as VolumeProfile;
    expect(p.volumes).toEqual([10, 10, 5, 10]);
    expect(p.poc).toBe(1);
    // Rows 1 and 2 are equally near the middle: the lower one wins.
    p = volumeProfile([bar(0, 1, 1), bar(1, 2, 10), bar(2, 3, 10), bar(3, 4, 1)], 4, 70) as VolumeProfile;
    expect(p.poc).toBe(1);
    // 70% of 22 is 15.4: the point of control (10) plus the bigger neighbour above (10).
    expect([p.valueLow, p.valueHigh]).toEqual([1, 2]);
  });

  it('extends the value area toward the bigger neighbour', () => {
    // Rows 0..4 with volumes 30, 5, 40, 10, 15 (total 100).
    const p = volumeProfile([bar(0, 1, 30), bar(1, 2, 5), bar(2, 3, 40), bar(3, 4, 10), bar(4, 5, 15)], 5, 70) as VolumeProfile;
    expect(p.volumes).toEqual([30, 5, 40, 10, 15]);
    expect(p.poc).toBe(2);
    // 40, then 10 above beats 5 below (50), then 15 above beats 5 (65), then only 5 below is left (70).
    expect([p.valueLow, p.valueHigh]).toEqual([1, 4]);
  });

  it('puts a bar at the very top in the last row and handles flat ranges', () => {
    const p = volumeProfile([bar(0, 0, 4), bar(8, 8, 6)], 4, 70) as VolumeProfile;
    expect(p.volumes).toEqual([4, 0, 0, 6]);
    expect(p.poc).toBe(3);
    const flat = volumeProfile([bar(5, 5, 3), bar(5, 5, 4)], 10, 70) as VolumeProfile;
    expect(flat.volumes[0]).toBe(7);
    expect(flat.poc).toBe(0);
    expect(volumeProfile([], 24, 70)).toBeNull();
  });

  it('only uses the bars in [from, to)', () => {
    const p = volumeProfile(BARS, 24, 70, 100, 180) as VolumeProfile;
    const q = volumeProfile(BARS.slice(100, 180), 24, 70) as VolumeProfile;
    expect(p).toEqual(q);
  });

  it('matches the brute-force reference on random bars', () => {
    for (const [rows, percent, from, to] of [
      [24, 70, 0, 300],
      [12, 70, 150, 220],
      [50, 68, 10, 60],
      [7, 100, 0, 40],
      [1, 70, 0, 10],
    ]) {
      const slice = BARS.slice(from, to);
      const got = volumeProfile(BARS, rows, percent, from, to) as VolumeProfile;
      const want = refProfile(slice, rows, percent);
      expect(got.low).toBe(want.low);
      expect(got.high).toBe(want.high);
      expect(got.total).toBe(want.total);
      got.volumes.forEach((v, i) => expect(Math.abs(v - want.volumes[i])).toBeLessThan(1e-6));
      expect(Math.abs(got.volumes.reduce((a, b) => a + b, 0) - got.total)).toBeLessThan(1e-6);
      expect(got.poc).toBe(want.poc);
      expect([got.valueLow, got.valueHigh]).toEqual([want.valueLow, want.valueHigh]);
    }
  });
});

describe('indicator registry', () => {
  it('lists Ichimoku and the volume profile as price overlays with editable defaults', () => {
    expect(INDICATORS).toHaveLength(36);
    expect(getIndicatorDef('ICHIMOKU')).toMatchObject({ pane: 'main', defaults: [9, 26, 52, 26], paramLabels: ['Conversion', 'Base', 'Span B', 'Displacement'] });
    expect(getIndicatorDef('VP')).toMatchObject({ pane: 'main', defaults: [24, 70], paramLabels: ['Rows', 'Value area %'] });
  });
});
