import { describe, expect, it } from 'vitest';
import { bucketStart, precisionFromIncrement } from '../src/data/timeframes';
import { searchSymbols } from '../src/data/search';
import { atr, rsi, wma } from '../src/chart/ta';
import type { SymbolMeta } from '../src/data/types';

describe('timeframes', () => {
  it('derives decimals from increments', () => {
    expect(precisionFromIncrement('0.01000000')).toBe(2);
    expect(precisionFromIncrement('1.00000000')).toBe(0);
    expect(precisionFromIncrement('0.00000001')).toBe(8);
    expect(precisionFromIncrement('1e-7')).toBe(7);
    expect(precisionFromIncrement('10')).toBe(0);
  });

  it('aligns weekly buckets to Monday 00:00 UTC', () => {
    const sunday = Date.UTC(2026, 9, 18, 15, 30);
    expect(new Date(bucketStart('1W', sunday)).toISOString()).toBe('2026-10-12T00:00:00.000Z');
    const monday = Date.UTC(2026, 9, 12);
    expect(bucketStart('1W', monday)).toBe(monday);
    expect(new Date(bucketStart('4h', Date.UTC(2026, 9, 12, 7, 59))).toISOString()).toBe('2026-10-12T04:00:00.000Z');
  });
});

describe('searchSymbols', () => {
  const s = (symbol: string, base: string, quote: string): SymbolMeta => ({ symbol, base, quote, pricePrecision: 2, volumePrecision: 2 });
  const list = [s('ETHBTC', 'ETH', 'BTC'), s('WBETHETH', 'WBETH', 'ETH'), s('ETHUSDT', 'ETH', 'USDT'), s('BTCUSDT', 'BTC', 'USDT'), s('ETH-USD', 'ETH', 'USD')];

  it('puts base-asset matches on popular quotes first', () => {
    expect(searchSymbols(list, 'eth').map((x) => x.symbol)).toEqual(['ETHUSDT', 'ETH-USD', 'ETHBTC', 'WBETHETH']);
  });

  it('ignores separators and case', () => {
    expect(searchSymbols(list, 'eth/usdt')[0].symbol).toBe('ETHUSDT');
    expect(searchSymbols(list, 'eth usd')[0].symbol).toBe('ETH-USD');
  });
});

describe('technical analysis helpers', () => {
  const bars = [10, 11, 12, 11, 13, 14].map((c, i) => ({ timestamp: i, high: c + 1, low: c - 1, close: c }));

  it('computes Wilder ATR', () => {
    const out = atr(bars, 3);
    expect(out.slice(0, 2)).toEqual([undefined, undefined]);
    // True ranges: 2, 2, 2, 2, 3, 2
    expect(out[2]).toBeCloseTo(2);
    expect(out[4]).toBeCloseTo((2 * 2 + 3) / 3);
  });

  it('computes WMA', () => {
    expect(wma([1, 2, 3], 3)[2]).toBeCloseTo((1 + 4 + 9) / 6);
  });

  it('keeps RSI within 0..100', () => {
    const values = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i) * 5);
    const out = rsi(values, 14).filter((v): v is number => v !== undefined);
    expect(out.length).toBe(36);
    expect(out.every((v) => v >= 0 && v <= 100)).toBe(true);
  });
});
