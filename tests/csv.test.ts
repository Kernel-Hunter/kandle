import { describe, expect, it } from 'vitest';
import {
  CsvError,
  CsvSource,
  CsvStore,
  MAX_DATASET_CHARS,
  datasetTimeframes,
  detectTimeframe,
  medianSpacing,
  parseCsv,
  parseTime,
  splitCsvLine,
  symbolForName,
} from '../src/data/csv';
import { loadSymbols } from '../src/data/sources';
import { MemoryStorage } from '../src/store/layout';

const DAY = 86_400_000;
const D0 = Date.UTC(2024, 0, 1);

/** `n` daily rows starting 2024-01-01 with a header in the given order. */
function dailyCsv(n: number, header = 'time,open,high,low,close,volume', delim = ','): string {
  const rows = Array.from({ length: n }, (_, i) => {
    const date = new Date(D0 + i * DAY).toISOString().slice(0, 10);
    const values: Record<string, string> = { time: date, date, open: `${100 + i}`, high: `${102 + i}.5`, low: `${99 + i}`, close: `${101 + i}.25`, volume: `${1000 + i}` };
    return header.split(delim).map((h) => values[h.toLowerCase()] ?? '').join(delim);
  });
  return [header, ...rows].join('\n');
}

describe('CSV times', () => {
  it('reads ISO 8601, dates, date and time, and Unix times', () => {
    expect(parseTime('2024-03-05')).toBe(Date.UTC(2024, 2, 5));
    expect(parseTime('2024-03-05 14:30')).toBe(Date.UTC(2024, 2, 5, 14, 30));
    expect(parseTime('2024-03-05 14:30:15')).toBe(Date.UTC(2024, 2, 5, 14, 30, 15));
    expect(parseTime('2024-03-05T14:30:15Z')).toBe(Date.UTC(2024, 2, 5, 14, 30, 15));
    expect(parseTime('2024-03-05T14:30:15.250Z')).toBe(Date.UTC(2024, 2, 5, 14, 30, 15, 250));
    expect(parseTime('2024-03-05T16:30:00+02:00')).toBe(Date.UTC(2024, 2, 5, 14, 30));
    expect(parseTime('2024/03/05')).toBe(Date.UTC(2024, 2, 5));
    expect(parseTime('1709648400')).toBe(1709648400000);
    expect(parseTime('1709648400000')).toBe(1709648400000);
    expect(parseTime('1709648400000000')).toBe(1709648400000);
    expect(parseTime('2024-02-30')).toBeNaN();
    expect(parseTime('yesterday')).toBeNaN();
    expect(parseTime('42')).toBeNaN();
  });

  it('splits quoted fields', () => {
    expect(splitCsvLine('a,"b,c",d', ',')).toEqual(['a', 'b,c', 'd']);
    expect(splitCsvLine('"say ""hi""";2', ';')).toEqual(['say "hi"', '2']);
  });
});

describe('CSV parsing', () => {
  it('reads a header in any order and case', () => {
    const r = parseCsv(dailyCsv(5, 'Close,Volume,Date,High,Low,Open'));
    expect(r.candles).toHaveLength(5);
    expect(r.candles[0]).toEqual({ time: D0, open: 100, high: 102.5, low: 99, close: 101.25, volume: 1000 });
    expect(r.timeframe).toBe('1D');
    expect(r.resampled).toBe(false);
    expect(r.pricePrecision).toBe(2);
    expect(r.malformed).toBe(0);
  });

  it('accepts semicolons with decimal commas, tabs, and no volume', () => {
    const semi = 'Datetime;Open;High;Low;Close\n2024-01-01 00:00;1,5;2,5;1,0;2,0\n2024-01-01 01:00;2,0;3,0;1,5;2,5';
    const r = parseCsv(semi);
    expect(r.candles.map((c) => c.close)).toEqual([2, 2.5]);
    expect(r.candles[0].volume).toBe(0);
    expect(r.timeframe).toBe('1h');
    const tab = 'timestamp\topen\thigh\tlow\tclose\n1704067200\t1\t2\t0.5\t1.5\n1704067500\t1.5\t2\t1\t1.8';
    expect(parseCsv(tab).timeframe).toBe('5m');
  });

  it('reads files without a header as time, open, high, low, close, volume', () => {
    const rows = [0, 1, 2].map((i) => `${D0 + i * 60_000},1,2,0.5,1.5,10,${D0 + i * 60_000 + 59_999}`).join('\n');
    const r = parseCsv(rows);
    expect(r.candles).toHaveLength(3);
    expect(r.timeframe).toBe('1m');
    expect(r.candles[2].volume).toBe(10);
    expect(parseCsv('date,open,high,low,close\n2024-01-01,1.50000000,2.25000000,1.00000000,2.10000000\n2024-01-02,1,2,1,2').pricePrecision).toBe(2);
  });

  it('joins separate date and time columns', () => {
    const r = parseCsv('<DATE>,<TIME>,<OPEN>,<HIGH>,<LOW>,<CLOSE>,<TICKVOL>\n2024.01.02,09:00,1,2,0.5,1.5,7\n2024.01.02,09:15,1,2,0.5,1.6,8');
    expect(r.candles.map((c) => c.time)).toEqual([Date.UTC(2024, 0, 2, 9), Date.UTC(2024, 0, 2, 9, 15)]);
    expect(r.timeframe).toBe('15m');
  });

  it('sorts by time, keeps the last of repeated times, and counts malformed rows', () => {
    const text = [
      'date,open,high,low,close',
      '2024-01-03,3,4,2,3.5',
      '2024-01-01,1,2,0.5,1.5',
      'not a date,1,2,0.5,1.5',
      '2024-01-02,2,3,1,2.5',
      '2024-01-02,2,3,1,2.9',
      '2024-01-04,abc,5,3,4.5',
      '2024-01-05,5,4,6,5',
      '',
      '2024-01-06,6,7,5,6.5',
    ].join('\r\n');
    const r = parseCsv(text);
    expect(r.candles.map((c) => c.close)).toEqual([1.5, 2.9, 3.5, 6.5]);
    expect(r.duplicates).toBe(1);
    // An unreadable time, a non-numeric open, and a high below the low.
    expect(r.malformed).toBe(3);
    expect(r.rows).toBe(8);
  });

  it('explains what is wrong with a file it cannot use', () => {
    expect(() => parseCsv('')).toThrow(CsvError);
    expect(() => parseCsv('date,open,high,close\n2024-01-01,1,2,1')).toThrow('The header has no low column. Columns found: date, open, high, close.');
    expect(() => parseCsv('date,open,high,low,close\nx,1,2,0,1')).toThrow('No row has a readable time and prices.');
    expect(() => parseCsv('date,open,high,low,close\n2024-01-01,1,2,0,1\n2024-01-04,1,2,0,1\n2024-01-07,1,2,0,1')).toThrow(
      'Bars are 3 days apart, which does not fit the 1m, 5m, 15m, 1H, 4H, 1D or 1W timeframes.',
    );
  });
});

describe('CSV timeframe detection', () => {
  it('uses the median bar spacing', () => {
    expect(medianSpacing([0, 60_000, 120_000, 600_000, 660_000])).toBe(60_000);
    expect(detectTimeframe(DAY)).toEqual({ timeframe: '1D', resampled: false });
    expect(detectTimeframe(7 * DAY)).toEqual({ timeframe: '1W', resampled: false });
    expect(detectTimeframe(30 * 60_000)).toEqual({ timeframe: '1h', resampled: true });
    expect(detectTimeframe(2 * 3_600_000)).toEqual({ timeframe: '4h', resampled: true });
    expect(detectTimeframe(30 * 1000)).toEqual({ timeframe: '1m', resampled: true });
    expect(detectTimeframe(3 * DAY)).toBeNull();
  });

  it('treats weekday-only stock data as daily', () => {
    const days = [1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 15].map((d) => `2024-01-${String(d).padStart(2, '0')},1,2,0.5,1.5`);
    expect(parseCsv(['date,open,high,low,close', ...days].join('\n')).timeframe).toBe('1D');
  });

  it('combines bars that fit no timeframe into the next one up', () => {
    const rows = Array.from({ length: 4 }, (_, i) => `${new Date(D0 + i * 1_800_000).toISOString()},${i + 1},${i + 2},${i},${i + 1.5},10`);
    const r = parseCsv(['time,open,high,low,close,volume', ...rows].join('\n'));
    expect(r.resampled).toBe(true);
    expect(r.timeframe).toBe('1h');
    expect(r.candles).toEqual([
      { time: D0, open: 1, high: 3, low: 0, close: 2.5, volume: 20 },
      { time: D0 + 3_600_000, open: 3, high: 5, low: 2, close: 4.5, volume: 20 },
    ]);
  });
});

describe('CSV storage and source', () => {
  it('saves, lists, reloads and deletes datasets', async () => {
    const storage = new MemoryStorage();
    const store = new CsvStore(storage);
    let changes = 0;
    store.onChange(() => changes++);
    const parsed = parseCsv(dailyCsv(30));
    const d = store.save('  My BTC daily ', parsed);
    expect(d).toMatchObject({ symbol: 'MY-BTC-DAILY', name: 'My BTC daily', timeframe: '1D', bars: 30, first: D0, last: D0 + 29 * DAY });
    expect(store.save('My BTC daily', parsed).symbol).toBe('MY-BTC-DAILY-2');
    // A new store on the same storage, as after a reload.
    const again = new CsvStore(storage);
    expect(again.list().map((x) => x.symbol)).toEqual(['MY-BTC-DAILY', 'MY-BTC-DAILY-2']);
    expect(again.candles('MY-BTC-DAILY')).toEqual(parsed.candles);
    expect(again.remove('MY-BTC-DAILY')).toBe(true);
    expect(again.list()).toHaveLength(1);
    expect(() => again.candles('MY-BTC-DAILY')).toThrow(/no longer in this browser/);
    expect(changes).toBe(2);
  });

  it('refuses data that is too big for browser storage', () => {
    const store = new CsvStore(new MemoryStorage());
    const parsed = parseCsv(dailyCsv(3));
    const many = Array.from({ length: 120_000 }, (_, i) => ({ time: D0 + i * 60_000, open: 12345.678901, high: 12346.678901, low: 12344.678901, close: 12345.123456, volume: 98765.4321 }));
    expect(() => store.save('Big', { ...parsed, candles: many })).toThrow(/more than the 2\.5 MB a dataset can use/);
    expect(() => store.save(' ', parsed)).toThrow('Give the dataset a name.');
    expect(MAX_DATASET_CHARS).toBeGreaterThan(1_000_000);
  });

  it('serves bars by page and in longer timeframes, never shorter ones', async () => {
    const store = new CsvStore(new MemoryStorage());
    const d = store.save('Data', parseCsv(dailyCsv(30)));
    const source = new CsvSource(() => store);
    expect(await source.listSymbols()).toEqual([{ symbol: 'DATA', base: 'Data', quote: '', name: 'Data', pricePrecision: 2, volumePrecision: 0 }]);
    expect(source.timeframesFor('DATA')).toEqual(['1D', '1W']);
    expect(datasetTimeframes({ timeframe: '15m' })).toEqual(['15m', '1h', '4h', '1D', '1W']);
    const latest = await source.fetchCandles('DATA', '1D', { limit: 10 });
    expect(latest.map((c) => c.time)).toEqual(Array.from({ length: 10 }, (_, i) => D0 + (20 + i) * DAY));
    const older = await source.fetchCandles('DATA', '1D', { before: latest[0].time, limit: 100 });
    expect(older).toHaveLength(20);
    expect(await source.fetchCandles('DATA', '1D', { before: D0 })).toEqual([]);
    const weekly = await source.fetchCandles('DATA', '1W');
    // 2024-01-01 is a Monday, so 30 days make 4 full weeks and 2 days.
    expect(weekly.map((c) => c.time)).toEqual([0, 1, 2, 3, 4].map((w) => D0 + w * 7 * DAY));
    expect(weekly[0]).toMatchObject({ open: 100, high: 108.5, low: 99, close: 107.25, volume: 7021 });
    await expect(source.fetchCandles('DATA', '1h')).rejects.toThrow('Data has 1D bars, so it can be shown in 1D, 1W');
    await expect(source.fetchCandles('GONE', '1D')).rejects.toThrow(/No imported dataset GONE/);
    expect(d.symbol).toBe('DATA');
  });

  it('is never cached in the symbol list cache', async () => {
    const store = new CsvStore(new MemoryStorage());
    const source = new CsvSource(() => store);
    const storage = new MemoryStorage();
    expect(await loadSymbols(source, storage)).toEqual([]);
    store.save('Later', parseCsv(dailyCsv(3)));
    expect((await loadSymbols(source, storage)).map((s) => s.symbol)).toEqual(['LATER']);
  });

  it('makes symbol ids from names', () => {
    expect(symbolForName('btc / usd (daily)', [])).toBe('BTC-USD-DAILY');
    expect(symbolForName('***', [])).toBe('DATA');
    expect(symbolForName('x', ['X', 'X-2'])).toBe('X-3');
  });
});
