/**
 * Compare symbols: other markets drawn as lines over the main chart. This file has the math
 * and the checks, with no chart or DOM, so it can be tested on its own.
 *
 * A compared series is lined up with the chart's bars by time, then scaled so it starts at
 * the chart's close on the first bar on screen (the anchor). On a percent price scale, which
 * also measures from that bar, every line then reads as its own change since the left edge.
 */

/** Lines one chart can compare at once. */
export const MAX_COMPARE = 5;

/** A compared market. */
export interface CompareSymbol {
  source: string;
  symbol: string;
}

/** Line colors, in the order lines are added. Picked to stand apart from the default indicator colors. */
export const COMPARE_COLORS = ['#e6b000', '#e040fb', '#00bcd4', '#ff7043', '#8bc34a'] as const;

const SYMBOL = /^[A-Za-z0-9._:/-]{1,40}$/;
const SOURCE = /^[a-z0-9_-]{1,32}$/;

export const sameCompare = (a: CompareSymbol, b: CompareSymbol): boolean => a.source === b.source && a.symbol === b.symbol;

/**
 * Keeps entries with a valid source id and symbol, drops duplicates and caps the list. The
 * chart skips sources this version does not have when it restores the list.
 */
export function sanitizeCompare(raw: unknown): CompareSymbol[] {
  if (!Array.isArray(raw)) return [];
  const out: CompareSymbol[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { source, symbol } = item as Record<string, unknown>;
    if (typeof source !== 'string' || !SOURCE.test(source)) continue;
    if (typeof symbol !== 'string' || !SYMBOL.test(symbol)) continue;
    const entry = { source, symbol };
    if (out.some((o) => sameCompare(o, entry))) continue;
    out.push(entry);
    if (out.length >= MAX_COMPARE) break;
  }
  return out;
}

/**
 * The compared close for each chart bar: the last compared bar that opened at or before the
 * chart bar, or NaN before the compared series starts. Gaps in the compared series (a market
 * that is closed while the chart's trades) repeat the last close. Both lists are oldest first.
 */
export function alignCloses(chartTimes: ArrayLike<number>, bars: ReadonlyArray<{ timestamp: number; close: number }>): Float64Array {
  const out = new Float64Array(chartTimes.length).fill(Number.NaN);
  let j = -1;
  for (let i = 0; i < chartTimes.length; i++) {
    const t = chartTimes[i];
    while (j + 1 < bars.length && bars[j + 1].timestamp <= t) j++;
    if (j >= 0) out[i] = bars[j].close;
  }
  return out;
}

/** The first bar at or after `from` where both series have a usable price, or -1. */
export function anchorIndex(raw: ArrayLike<number>, main: ArrayLike<number>, from: number): number {
  for (let i = Math.max(0, from); i < raw.length && i < main.length; i++) {
    if (raw[i] > 0 && main[i] > 0 && Number.isFinite(raw[i]) && Number.isFinite(main[i])) return i;
  }
  return -1;
}

/** Multiplier that puts the compared series on the chart's price at the anchor, or NaN. */
export function rebaseFactor(raw: ArrayLike<number>, main: ArrayLike<number>, anchor: number): number {
  if (anchor < 0) return Number.NaN;
  return main[anchor] / raw[anchor];
}

/** Percent change of the compared close at `index` since the anchor, or null. */
export function changeSince(raw: ArrayLike<number>, anchor: number, index: number): number | null {
  if (anchor < 0 || index < 0 || index >= raw.length) return null;
  const base = raw[anchor];
  const v = raw[index];
  if (!(base > 0) || !Number.isFinite(v)) return null;
  return ((v - base) / base) * 100;
}
