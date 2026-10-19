/**
 * Your own OHLCV data from a CSV file: a parser for the common layouts, a store that keeps
 * imported datasets in this browser, and a DataSource that serves them to the chart.
 * Nothing here touches the network.
 */
import { APP } from '../config';
import { TIMEFRAMES, canResample, getTimeframe, resampleCandles, type TimeframeId } from './timeframes';
import type { Candle, DataSource, FetchCandlesOptions, MarketType, SubscribeOptions, SymbolMeta } from './types';
import { browserStorage, type KeyValueStorage } from '../store/layout';

export const CSV_SOURCE_ID = 'csv';

export interface CsvParseResult {
  candles: Candle[];
  /** Bar size the data is shown in. */
  timeframe: TimeframeId;
  /** Median spacing of the file's bars in ms. */
  spacing: number;
  /** True when the file's bars were combined into longer `timeframe` bars. */
  resampled: boolean;
  /** Data rows read, not counting the header. */
  rows: number;
  /** Rows skipped because a time or price could not be read. */
  malformed: number;
  /** Rows dropped because a later row had the same time. */
  duplicates: number;
  pricePrecision: number;
  volumePrecision: number;
}

export class CsvError extends Error {}

const TIME_NAMES = ['time', 'date', 'datetime', 'timestamp', 'opentime', 'unix', 'ts', 'day'];
const COLUMN_NAMES: Record<'open' | 'high' | 'low' | 'close' | 'volume', string[]> = {
  open: ['open', 'o', 'openprice'],
  high: ['high', 'h', 'highprice'],
  low: ['low', 'l', 'lowprice'],
  close: ['close', 'c', 'closeprice', 'last', 'price'],
  volume: ['volume', 'vol', 'v', 'basevolume', 'tickvol', 'tickvolume'],
};

/** "Open Time", "<CLOSE>" and "open_time" all become "opentime" and "close". */
const normalizeHeader = (h: string) => h.toLowerCase().replace(/[^a-z]/g, '');

/** Splits one line on `delim`, honouring double-quoted fields. */
export function splitCsvLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function detectDelimiter(line: string): string {
  const counts = [',', ';', '\t'].map((d) => ({ d, n: splitCsvLine(line, d).length }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0].n > 1 ? counts[0].d : ',';
}

const DATE_TIME = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?)?$/;

/**
 * Parses a time as ISO 8601 (with Z or an offset), "YYYY-MM-DD", "YYYY-MM-DD HH:mm[:ss]"
 * (read as UTC), or a Unix time in seconds, milliseconds or microseconds. NaN when unreadable.
 */
export function parseTime(text: string): number {
  const t = text.trim();
  if (!t) return NaN;
  if (/^\d+(\.\d+)?$/.test(t)) {
    const n = Number(t);
    if (n >= 1e14) return Math.round(n / 1000); // microseconds
    if (n >= 1e11) return Math.round(n); // milliseconds
    if (n >= 1e8) return Math.round(n * 1000); // seconds
    return NaN;
  }
  const m = DATE_TIME.exec(t);
  if (m) {
    const [, y, mo, d, hh, mm, ss, ms] = m;
    const time = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh ?? 0), Number(mm ?? 0), Number(ss ?? 0), Number((ms ?? '0').padEnd(3, '0')));
    const check = new Date(time);
    return check.getUTCMonth() === Number(mo) - 1 && check.getUTCDate() === Number(d) ? time : NaN;
  }
  // ISO 8601 with a zone ("2024-01-02T03:04:05Z", "+02:00"). Without one, browsers would use local time.
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})$/i.test(t)) {
    const v = Date.parse(t);
    return Number.isFinite(v) ? v : NaN;
  }
  return NaN;
}

/** Reads a price. A semicolon file may use a decimal comma ("1234,5"). */
function parseNumber(text: string, decimalComma: boolean): number {
  let t = text.trim().replace(/^"|"$/g, '');
  if (!t) return NaN;
  if (decimalComma && /^-?\d+,\d+$/.test(t)) t = t.replace(',', '.');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return NaN;
  return Number(t);
}

function decimals(text: string): number {
  const t = text.trim().replace(',', '.');
  const dot = t.indexOf('.');
  if (dot < 0 || /e/i.test(t)) return 0;
  // Exchange exports pad prices with zeros ("105552.15000000").
  return t.slice(dot + 1).replace(/0+$/, '').length;
}

/** Median gap between consecutive bars, in ms. */
export function medianSpacing(times: readonly number[]): number {
  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
  if (gaps.length === 0) return 0;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/**
 * The timeframe for bars `spacing` ms apart: an exact match, or the shortest Kandle
 * timeframe the bars can be combined into (30 minute bars become 1H bars). Stock data
 * without weekends still has a median spacing of one day.
 */
export function detectTimeframe(spacing: number): { timeframe: TimeframeId; resampled: boolean } | null {
  if (!(spacing > 0)) return null;
  const exact = TIMEFRAMES.find((tf) => Math.abs(tf.ms - spacing) <= tf.ms * 0.01);
  if (exact) return { timeframe: exact.id, resampled: false };
  const up = TIMEFRAMES.find((tf) => tf.ms > spacing && tf.ms % spacing === 0);
  return up ? { timeframe: up.id, resampled: true } : null;
}

function describeSpacing(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000} day${ms === 86_400_000 ? '' : 's'}`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} hour${ms === 3_600_000 ? '' : 's'}`;
  if (ms % 60_000 === 0) return `${ms / 60_000} minute${ms === 60_000 ? '' : 's'}`;
  return `${Math.round(ms / 1000)} seconds`;
}

/**
 * Parses CSV text with a header row naming time (or date, datetime, timestamp), open, high,
 * low, close and optionally volume, in any order and case. Comma, semicolon and tab
 * delimiters work. A file without a header is read as time, open, high, low, close, volume.
 * Rows are sorted by time; for repeated times the last row wins.
 */
export function parseCsv(text: string): CsvParseResult {
  const lines = text.replace(/^﻿/, '').split(/\r\n|\n|\r/).filter((l) => l.trim() !== '');
  if (lines.length === 0) throw new CsvError('The file is empty.');
  const delim = detectDelimiter(lines[0]);
  const first = splitCsvLine(lines[0], delim);
  const headerless = first.length >= 5 && Number.isFinite(parseTime(first[0])) && first.slice(1, 5).every((f) => Number.isFinite(parseNumber(f, delim === ';')));

  let col: Record<'time' | 'open' | 'high' | 'low' | 'close' | 'volume', number>;
  let dateCol = -1;
  let clockCol = -1;
  if (headerless) {
    col = { time: 0, open: 1, high: 2, low: 3, close: 4, volume: first.length > 5 ? 5 : -1 };
  } else {
    const names = first.map(normalizeHeader);
    const find = (aliases: string[]) => {
      for (const a of aliases) {
        const i = names.indexOf(a);
        if (i >= 0) return i;
      }
      return -1;
    };
    // Separate date and time columns ("Date", "Time") are joined.
    const date = names.indexOf('date');
    const clock = names.indexOf('time');
    if (date >= 0 && clock >= 0) {
      dateCol = date;
      clockCol = clock;
    }
    col = {
      time: dateCol >= 0 ? dateCol : find(TIME_NAMES),
      open: find(COLUMN_NAMES.open),
      high: find(COLUMN_NAMES.high),
      low: find(COLUMN_NAMES.low),
      close: find(COLUMN_NAMES.close),
      volume: find(COLUMN_NAMES.volume),
    };
    const missing = (['time', 'open', 'high', 'low', 'close'] as const).filter((k) => col[k] < 0);
    if (missing.length) {
      throw new CsvError(`The header has no ${missing.join(', ')} column. Columns found: ${first.join(', ') || 'none'}.`);
    }
  }

  const decimalComma = delim === ';';
  const rows = headerless ? lines : lines.slice(1);
  const byTime = new Map<number, Candle>();
  let malformed = 0;
  let duplicates = 0;
  let pricePrecision = 0;
  let volumePrecision = 0;
  for (const line of rows) {
    const f = splitCsvLine(line, delim);
    const timeText = clockCol >= 0 && /^\d{1,2}:\d{2}/.test(f[clockCol] ?? '') ? `${f[dateCol]} ${f[clockCol]}` : (f[col.time] ?? '');
    const time = parseTime(timeText);
    const open = parseNumber(f[col.open] ?? '', decimalComma);
    const high = parseNumber(f[col.high] ?? '', decimalComma);
    const low = parseNumber(f[col.low] ?? '', decimalComma);
    const close = parseNumber(f[col.close] ?? '', decimalComma);
    const volumeText = col.volume >= 0 ? (f[col.volume] ?? '') : '';
    const volume = volumeText ? parseNumber(volumeText, decimalComma) : 0;
    if (![time, open, high, low, close, volume].every(Number.isFinite) || high < low) {
      malformed++;
      continue;
    }
    if (byTime.has(time)) duplicates++;
    byTime.set(time, { time, open, high, low, close, volume });
    for (const k of ['open', 'high', 'low', 'close'] as const) pricePrecision = Math.max(pricePrecision, decimals(f[col[k]]));
    if (volumeText) volumePrecision = Math.max(volumePrecision, decimals(volumeText));
  }
  const raw = [...byTime.values()].sort((a, b) => a.time - b.time);
  if (raw.length < 2) throw new CsvError(raw.length === 0 ? 'No row has a readable time and prices.' : 'The file needs at least two bars.');
  const spacing = medianSpacing(raw.map((c) => c.time));
  const detected = detectTimeframe(spacing);
  if (!detected) {
    throw new CsvError(`Bars are ${describeSpacing(spacing)} apart, which does not fit the 1m, 5m, 15m, 1H, 4H, 1D or 1W timeframes.`);
  }
  return {
    candles: detected.resampled ? resampleCandles(raw, detected.timeframe) : raw,
    timeframe: detected.timeframe,
    spacing,
    resampled: detected.resampled,
    rows: rows.length,
    malformed,
    duplicates,
    pricePrecision: Math.min(10, pricePrecision),
    volumePrecision: Math.min(8, volumePrecision),
  };
}

// ---------------------------------------------------------------- storage

export interface CsvDataset {
  /** Symbol id used by the chart, derived from the name. */
  symbol: string;
  name: string;
  timeframe: TimeframeId;
  bars: number;
  first: number;
  last: number;
  pricePrecision: number;
  volumePrecision: number;
  importedAt: number;
}

/** Imported data must fit in local storage next to the layout. */
export const MAX_DATASET_CHARS = 2_500_000;
export const MAX_TOTAL_CHARS = 4_000_000;

const INDEX_KEY = `${APP.id}:csv:index`;
const dataKey = (symbol: string) => `${APP.id}:csv:data:${symbol}`;

/** Bars stored as columns, with each time as the gap from the previous one, to save space. */
function encode(candles: readonly Candle[]): string {
  const t: number[] = [];
  let prev = 0;
  for (const c of candles) {
    t.push(c.time - prev);
    prev = c.time;
  }
  return JSON.stringify({ v: 1, t, o: candles.map((c) => c.open), h: candles.map((c) => c.high), l: candles.map((c) => c.low), c: candles.map((c) => c.close), q: candles.map((c) => c.volume) });
}

function decode(text: string): Candle[] {
  const d = JSON.parse(text) as { t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; q: number[] };
  const out: Candle[] = [];
  let time = 0;
  for (let i = 0; i < d.t.length; i++) {
    time += d.t[i];
    out.push({ time, open: d.o[i], high: d.h[i], low: d.l[i], close: d.c[i], volume: d.q[i] ?? 0 });
  }
  return out;
}

function sanitizeIndex(raw: unknown): CsvDataset[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((d): d is CsvDataset => !!d && typeof d === 'object' && typeof d.symbol === 'string' && typeof d.name === 'string' && !!getTimeframe(d.timeframe));
}

/** Symbol id for a dataset name: upper case letters, digits and dashes. */
export function symbolForName(name: string, taken: readonly string[]): string {
  const base = name.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'DATA';
  let symbol = base;
  for (let i = 2; taken.includes(symbol); i++) symbol = `${base}-${i}`;
  return symbol;
}

/** Imported datasets in local storage. */
export class CsvStore {
  private readonly listeners = new Set<() => void>();
  private cache = new Map<string, Candle[]>();

  constructor(private readonly storage: KeyValueStorage) {}

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  list(): CsvDataset[] {
    try {
      return sanitizeIndex(JSON.parse(this.storage.getItem(INDEX_KEY) ?? '[]'));
    } catch {
      return [];
    }
  }

  get(symbol: string): CsvDataset | undefined {
    return this.list().find((d) => d.symbol === symbol);
  }

  candles(symbol: string): Candle[] {
    const hit = this.cache.get(symbol);
    if (hit) return hit;
    const raw = this.storage.getItem(dataKey(symbol));
    if (!raw) throw new CsvError(`The imported dataset ${symbol} is no longer in this browser.`);
    const candles = decode(raw);
    this.cache.set(symbol, candles);
    return candles;
  }

  /** Saves parsed data under `name`. Throws a CsvError when it is too big for the browser. */
  save(name: string, parsed: CsvParseResult): CsvDataset {
    const trimmed = name.trim().slice(0, 60);
    if (!trimmed) throw new CsvError('Give the dataset a name.');
    const index = this.list();
    const encoded = encode(parsed.candles);
    const mb = (chars: number) => (chars / 1_000_000).toFixed(1);
    if (encoded.length > MAX_DATASET_CHARS) {
      throw new CsvError(`This data needs ${mb(encoded.length)} MB, more than the ${mb(MAX_DATASET_CHARS)} MB a dataset can use in browser storage. Import fewer bars or a higher timeframe.`);
    }
    const used = index.reduce((sum, d) => sum + (this.storage.getItem(dataKey(d.symbol))?.length ?? 0), 0);
    if (used + encoded.length > MAX_TOTAL_CHARS) {
      throw new CsvError(`Imported datasets would use ${mb(used + encoded.length)} MB, more than the ${mb(MAX_TOTAL_CHARS)} MB kept in browser storage. Delete a dataset first.`);
    }
    const c = parsed.candles;
    const dataset: CsvDataset = {
      symbol: symbolForName(trimmed, index.map((d) => d.symbol)),
      name: trimmed,
      timeframe: parsed.timeframe,
      bars: c.length,
      first: c[0].time,
      last: c[c.length - 1].time,
      pricePrecision: parsed.pricePrecision,
      volumePrecision: parsed.volumePrecision,
      importedAt: Date.now(),
    };
    try {
      this.storage.setItem(dataKey(dataset.symbol), encoded);
      this.storage.setItem(INDEX_KEY, JSON.stringify([...index, dataset]));
    } catch {
      this.storage.removeItem(dataKey(dataset.symbol));
      throw new CsvError('Browser storage is full. Delete a dataset or import fewer bars.');
    }
    this.cache.set(dataset.symbol, [...c]);
    this.changed();
    return dataset;
  }

  remove(symbol: string): boolean {
    const index = this.list();
    if (!index.some((d) => d.symbol === symbol)) return false;
    this.storage.removeItem(dataKey(symbol));
    this.storage.setItem(INDEX_KEY, JSON.stringify(index.filter((d) => d.symbol !== symbol)));
    this.cache.delete(symbol);
    this.changed();
    return true;
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }
}

let shared: CsvStore | null = null;

/** The app-wide dataset store, backed by localStorage when the browser allows it. */
export function csvStore(): CsvStore {
  shared ??= new CsvStore(browserStorage());
  return shared;
}

/** Replaces the shared store, for tests. */
export function setCsvStore(store: CsvStore | null): void {
  shared = store;
}

export function datasetMeta(d: CsvDataset): SymbolMeta {
  return { symbol: d.symbol, base: d.name, quote: '', name: d.name, pricePrecision: d.pricePrecision, volumePrecision: d.volumePrecision };
}

/** Timeframes a dataset can be shown in: its own and the longer ones its bars combine into. */
export function datasetTimeframes(d: Pick<CsvDataset, 'timeframe'>): TimeframeId[] {
  return TIMEFRAMES.filter((tf) => canResample(d.timeframe, tf.id)).map((tf) => tf.id);
}

/** Serves imported datasets. History is all there is: no stream, alerts never fire. */
export class CsvSource implements DataSource {
  readonly id = CSV_SOURCE_ID;
  readonly name = 'CSV';
  /** Any market; symbol search shows a CSV badge instead. */
  readonly markets: readonly MarketType[] = [];
  readonly timeframes: readonly TimeframeId[] = TIMEFRAMES.map((tf) => tf.id);
  readonly freshness = 'end-of-day' as const;
  readonly local = true;
  readonly note = 'Your own data, imported from CSV files and kept in this browser. It does not update.';

  constructor(private readonly store: () => CsvStore = csvStore) {}

  async listSymbols(): Promise<SymbolMeta[]> {
    return this.store().list().map(datasetMeta);
  }

  async getSymbol(symbol: string): Promise<SymbolMeta | null> {
    const d = this.store().get(symbol);
    return d ? datasetMeta(d) : null;
  }

  timeframesFor(symbol: string): readonly TimeframeId[] {
    const d = this.store().get(symbol);
    return d ? datasetTimeframes(d) : this.timeframes;
  }

  async fetchCandles(symbol: string, timeframe: TimeframeId, options: FetchCandlesOptions = {}): Promise<Candle[]> {
    const d = this.store().get(symbol);
    if (!d) throw new Error(`No imported dataset ${symbol}. Import it again from a CSV file.`);
    if (!canResample(d.timeframe, timeframe)) {
      throw new Error(`${d.name} has ${getTimeframe(d.timeframe)!.label} bars, so it can be shown in ${datasetTimeframes(d).map((t) => getTimeframe(t)!.label).join(', ')}`);
    }
    const all = this.store().candles(symbol);
    const bars = timeframe === d.timeframe ? all : resampleCandles(all, timeframe);
    let end = bars.length;
    if (options.before !== undefined) {
      const before = options.before;
      end = bars.findIndex((c) => c.time >= before);
      if (end < 0) end = bars.length;
    }
    const limit = Math.max(1, options.limit ?? 500);
    return bars.slice(Math.max(0, end - limit), end).map((c) => ({ ...c }));
  }

  subscribe(_symbol: string, _timeframe: TimeframeId, _onCandle: (candle: Candle) => void, options: SubscribeOptions = {}): () => void {
    options.onStatus?.('static');
    return () => undefined;
  }
}
