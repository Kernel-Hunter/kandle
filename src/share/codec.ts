/**
 * Shareable chart links. The chart travels in the URL fragment (#s=...), which browsers never
 * send to a server. It is compact JSON with a version field, compressed with deflate-raw when
 * the browser can, then base64url. Decoding checks every field, caps every size, ignores
 * fields it does not know and never evaluates anything; a bad link throws ShareError with a
 * message for the user.
 *
 * Format version 1, after decompressing:
 *
 *   v  1
 *   s  source id, y symbol, t timeframe                      always
 *   k  chart type, a price scale                             chart
 *   r  [right edge bar time or null for the latest bar, bar spacing in px]   chart
 *   i  [[indicator name, [params]], ...]                     indicators
 *   d  [[overlay name, [time, price, time, price, ...], text?], ...]   drawings
 *   x  [{ c: source code, i?: { input title: value }, g?: strategy settings }, ...]   scripts
 *   l  { n: 1 | 2 | 4, y: [crosshair, timeframe, symbol] as 0 or 1,
 *        p: [[source, symbol, timeframe, [[name, [params]], ...], chart type?, scale?], ...] }   layout
 */
import { isChartType, isPriceScale, type ChartType, type PriceScale } from '../chart/chartStyle';
import { getIndicatorDef } from '../chart/indicators';
import { DRAWING_TOOLS } from '../chart/overlays';
import { CSV_SOURCE_ID } from '../data/csv';
import { SOURCES } from '../data/sources';
import { isTimeframeId, type TimeframeId } from '../data/timeframes';
import { isChartCount, type ChartCount, type MultiChartConfig, type PaneConfig, type SyncOptions } from '../layout/config';
import type { InputValue } from '../script/compiler';
import { MAX_SCRIPT_LENGTH, type ScriptRecord } from '../script/persist';
import { STRATEGY_KEYS, checkStrategySetting, type StrategyOverrides } from '../script/strategySettings';
import type { DrawingRecord } from '../store/layout';

export const SHARE_VERSION = 1;
export const SHARE_HASH = '#s=';
/** Chat apps and some address bars cut links longer than this. */
export const SOFT_LINK_LIMIT = 8000;
/** Fragments longer than this are refused before anything is decoded. */
export const MAX_FRAGMENT = 512 * 1024;
/** A small compressed link can inflate to a lot; stop reading past this. */
export const MAX_JSON_BYTES = 2 * 1024 * 1024;

export const LIMITS = {
  indicators: 30,
  params: 10,
  /** Indicator parameters are lengths and multipliers; a huge one could stall the chart. */
  paramValue: 10_000,
  drawings: 300,
  points: 4,
  text: 280,
  scripts: 10,
  inputs: 100,
  inputKey: 100,
  inputText: 1000,
  paneIndicators: 20,
} as const;

const SYMBOL = /^[A-Za-z0-9._:/-]{1,40}$/;
/** Timestamps from 1970 to 2100. */
const MAX_TIME = 4_102_444_800_000;
const MAX_PRICE = 1e15;
const BAR_SPACE = { min: 1, max: 50 } as const;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const DRAWING_NAMES = new Set(DRAWING_TOOLS.map((t) => t.overlay));

export class ShareError extends Error {}

/** What a link carries besides the source, symbol and timeframe, which it always has. */
export interface ShareInclude {
  /** Chart type, price scale and the visible range. */
  chart: boolean;
  indicators: boolean;
  drawings: boolean;
  /** Script sources with their input values and strategy settings. */
  scripts: boolean;
  /** The other charts of a multi-chart layout and its sync settings. */
  layout: boolean;
}

export const DEFAULT_INCLUDE: Readonly<ShareInclude> = Object.freeze({ chart: true, indicators: true, drawings: true, scripts: false, layout: false });
export const INCLUDE_KEYS = Object.keys(DEFAULT_INCLUDE) as Array<keyof ShareInclude>;

/** Reads an include option from automation: booleans only, unknown keys are an error. */
export function parseInclude(raw: unknown): ShareInclude {
  const include = { ...DEFAULT_INCLUDE };
  if (raw === undefined || raw === null) return include;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`include must be an object such as {"scripts": true}`);
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(INCLUDE_KEYS as string[]).includes(key)) throw new Error(`Unknown include option ${key}. Use ${INCLUDE_KEYS.join(', ')}.`);
    if (value === undefined || value === null) continue;
    if (typeof value !== 'boolean') throw new Error(`include.${key} must be true or false`);
    include[key as keyof ShareInclude] = value;
  }
  return include;
}

export interface SharedRange {
  /** Time of the bar at the right edge, or null when the latest bar is on screen. */
  time: number | null;
  /** Pixels per bar. */
  barSpace: number;
}

export interface SharedScript {
  source: string;
  inputs: Record<string, InputValue>;
  strategy?: StrategyOverrides;
}

export interface SharedLayout {
  count: ChartCount;
  sync: SyncOptions;
  /** Charts 2 to `count`. */
  panes: PaneConfig[];
}

/** A chart as a link carries it. Sections the sender left out are missing. */
export interface SharedChart {
  source: string;
  symbol: string;
  timeframe: TimeframeId;
  style?: { type: ChartType; scale: PriceScale };
  range?: SharedRange;
  indicators?: Array<{ name: string; params: number[] }>;
  drawings?: DrawingRecord[];
  scripts?: SharedScript[];
  layout?: SharedLayout;
}

/** The live state a link is made from. */
export interface ChartSnapshot {
  source: string;
  symbol: string;
  timeframe: TimeframeId;
  style: { type: ChartType; scale: PriceScale };
  range: SharedRange | null;
  indicators: Array<{ name: string; params: number[] }>;
  drawings: DrawingRecord[];
  scripts: ScriptRecord[];
  layout: MultiChartConfig;
}

export const CSV_NOTE = 'Charts of imported CSV files cannot be shared: the data is only in your browser.';

/** Picks what goes into a link. Throws ShareError for a CSV chart; `notes` say what was left out. */
export function pickShared(snapshot: ChartSnapshot, include: ShareInclude): { chart: SharedChart; notes: string[] } {
  if (snapshot.source === CSV_SOURCE_ID) throw new ShareError(CSV_NOTE);
  const notes: string[] = [];
  const chart: SharedChart = { source: snapshot.source, symbol: snapshot.symbol, timeframe: snapshot.timeframe };
  if (include.chart) {
    chart.style = { ...snapshot.style };
    if (snapshot.range) chart.range = { ...snapshot.range };
  }
  if (include.indicators) chart.indicators = snapshot.indicators.map((i) => ({ name: i.name, params: [...i.params] }));
  if (include.drawings) chart.drawings = snapshot.drawings.map((d) => ({ ...d, points: d.points.map((p) => ({ ...p })) }));
  if (include.scripts) {
    chart.scripts = snapshot.scripts.map((s) => ({ source: s.source, inputs: { ...s.inputs }, ...(s.strategy ? { strategy: { ...s.strategy } } : {}) }));
  }
  if (include.layout && snapshot.layout.count > 1) {
    const panes = snapshot.layout.panes.slice(0, snapshot.layout.count - 1);
    if (panes.some((p) => p.source === CSV_SOURCE_ID)) {
      notes.push('Another chart in the layout shows an imported CSV file, so the layout was left out.');
    } else {
      chart.layout = { count: snapshot.layout.count, sync: { ...snapshot.layout.sync }, panes: panes.map((p) => ({ ...p, indicators: p.indicators.map((i) => ({ name: i.name, params: [...i.params] })) })) };
    }
  }
  return { chart, notes };
}

// ---------------------------------------------------------------- wire form

type WireIndicator = [string, number[]];
type WirePane = [string, string, string, WireIndicator[], string?, string?];

function wireIndicators(list: Array<{ name: string; params: number[] }>): WireIndicator[] {
  return list.map((i) => [i.name, [...i.params]]);
}

/** The compact JSON object for a chart. */
export function toWire(chart: SharedChart): Record<string, unknown> {
  const wire: Record<string, unknown> = { v: SHARE_VERSION, s: chart.source, y: chart.symbol, t: chart.timeframe };
  if (chart.style) {
    wire.k = chart.style.type;
    wire.a = chart.style.scale;
  }
  if (chart.range) wire.r = [chart.range.time, Math.round(chart.range.barSpace * 1000) / 1000];
  if (chart.indicators) wire.i = wireIndicators(chart.indicators);
  if (chart.drawings) {
    wire.d = chart.drawings.map((d) => {
      const row: unknown[] = [d.name, d.points.flatMap((p) => [p.timestamp, p.value])];
      if (d.text) row.push(d.text);
      return row;
    });
  }
  if (chart.scripts) {
    wire.x = chart.scripts.map((s) => {
      const row: Record<string, unknown> = { c: s.source };
      if (Object.keys(s.inputs).length > 0) row.i = s.inputs;
      if (s.strategy && Object.keys(s.strategy).length > 0) row.g = s.strategy;
      return row;
    });
  }
  if (chart.layout) {
    const { count, sync, panes } = chart.layout;
    wire.l = {
      n: count,
      y: [sync.crosshair ? 1 : 0, sync.timeframe ? 1 : 0, sync.symbol ? 1 : 0],
      p: panes.map((p): WirePane => {
        const row: WirePane = [p.source, p.symbol, p.timeframe, wireIndicators(p.indicators)];
        if (p.chartType || p.scale) row.push(p.chartType ?? 'candles', p.scale ?? 'normal');
        return row;
      }),
    };
  }
  return wire;
}

// ---------------------------------------------------------------- validation

function fail(detail: string): never {
  throw new ShareError(`The link is damaged or was edited: ${detail}.`);
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function list(v: unknown, what: string, max: number): unknown[] {
  if (!Array.isArray(v)) fail(`${what} must be a list`);
  if (v.length > max) fail(`it has more than ${max} ${what}`);
  return v;
}

function finite(v: unknown, what: string, min = -MAX_PRICE, max = MAX_PRICE): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) fail(`${what} must be a number from ${min} to ${max}`);
  return v;
}

function text(v: unknown, what: string, max: number): string {
  if (typeof v !== 'string' || v.length > max) fail(`${what} must be text of at most ${max} characters`);
  return v;
}

function market(sourceRaw: unknown, symbolRaw: unknown, tfRaw: unknown, where: string): { source: string; symbol: string; timeframe: TimeframeId } {
  if (sourceRaw === CSV_SOURCE_ID) throw new ShareError(CSV_NOTE);
  if (typeof sourceRaw !== 'string' || !SOURCES.some((s) => s.id === sourceRaw)) fail(`${where} has an unknown data source`);
  if (typeof symbolRaw !== 'string' || !SYMBOL.test(symbolRaw)) fail(`${where} has an invalid symbol`);
  if (!isTimeframeId(tfRaw)) fail(`${where} has an unknown timeframe`);
  return { source: sourceRaw, symbol: symbolRaw, timeframe: tfRaw };
}

function indicators(raw: unknown, max: number, notes: Set<string>): Array<{ name: string; params: number[] }> {
  const out: Array<{ name: string; params: number[] }> = [];
  for (const item of list(raw, 'indicators', max)) {
    const row = list(item, 'indicator fields', 2);
    const name = text(row[0], 'an indicator name', 40);
    const params = list(row[1] ?? [], 'indicator parameters', LIMITS.params).map((p) => finite(p, 'an indicator parameter', -LIMITS.paramValue, LIMITS.paramValue));
    // Indicators from a newer version are left out rather than failing the whole link.
    if (!getIndicatorDef(name)) {
      notes.add('Some indicators this version does not have were left out.');
      continue;
    }
    out.push({ name, params });
  }
  return out;
}

function drawings(raw: unknown, notes: Set<string>): DrawingRecord[] {
  const out: DrawingRecord[] = [];
  for (const item of list(raw, 'drawings', LIMITS.drawings)) {
    const row = list(item, 'drawing fields', 3);
    const name = text(row[0], 'a drawing type', 40);
    const flat = list(row[1], 'drawing points', LIMITS.points * 2);
    if (flat.length === 0 || flat.length % 2 !== 0) fail('a drawing has an odd number of coordinates');
    const points = [];
    for (let i = 0; i < flat.length; i += 2) {
      points.push({ timestamp: finite(flat[i], 'a drawing time', 0, MAX_TIME), value: finite(flat[i + 1], 'a drawing price') });
    }
    const record: DrawingRecord = { name, points };
    if (row[2] !== undefined) record.text = text(row[2], 'a note', LIMITS.text);
    if (!DRAWING_NAMES.has(name)) {
      notes.add('Some drawings this version does not have were left out.');
      continue;
    }
    out.push(record);
  }
  return out;
}

function inputs(raw: unknown): Record<string, InputValue> {
  if (raw === undefined) return {};
  if (!isObject(raw)) fail('script inputs must be an object');
  const entries = Object.entries(raw);
  if (entries.length > LIMITS.inputs) fail(`a script has more than ${LIMITS.inputs} inputs`);
  const out: Array<[string, InputValue]> = [];
  for (const [key, value] of entries) {
    if (!key || key.length > LIMITS.inputKey || UNSAFE_KEYS.has(key)) fail('a script input has an invalid name');
    if (typeof value === 'boolean') out.push([key, value]);
    else if (typeof value === 'number') out.push([key, finite(value, 'a script input')]);
    else out.push([key, text(value, 'a script input', LIMITS.inputText)]);
  }
  // fromEntries defines own properties, so no key can reach a prototype.
  return Object.fromEntries(out);
}

function strategy(raw: unknown): StrategyOverrides | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) fail('strategy settings must be an object');
  const out: Record<string, unknown> = {};
  for (const key of STRATEGY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    const res = checkStrategySetting(key, key, raw[key]);
    if ('error' in res) fail(res.error);
    out[key] = res.value;
  }
  return Object.keys(out).length > 0 ? (out as StrategyOverrides) : undefined;
}

function scripts(raw: unknown): SharedScript[] {
  return list(raw, 'scripts', LIMITS.scripts).map((item) => {
    if (!isObject(item)) fail('a script must be an object');
    const source = text(item.c, 'a script', MAX_SCRIPT_LENGTH);
    if (!source.trim()) fail('a script is empty');
    const script: SharedScript = { source, inputs: inputs(item.i) };
    const settings = strategy(item.g);
    if (settings) script.strategy = settings;
    return script;
  });
}

function layout(raw: unknown, notes: Set<string>): SharedLayout {
  if (!isObject(raw)) fail('the layout must be an object');
  if (!isChartCount(raw.n)) fail('the layout must have 1, 2 or 4 charts');
  const flags = list(raw.y, 'sync settings', 3);
  const flag = (i: number) => flags[i] === 1 || flags[i] === true;
  for (const f of flags) if (f !== 0 && f !== 1 && typeof f !== 'boolean') fail('sync settings must be 0 or 1');
  const panes = list(raw.p ?? [], 'charts', 3).map((item, i): PaneConfig => {
    const row = list(item, 'chart fields', 6);
    const where = `chart ${i + 2}`;
    const pane: PaneConfig = { ...market(row[0], row[1], row[2], where), indicators: indicators(row[3] ?? [], LIMITS.paneIndicators, notes) };
    if (row[4] !== undefined) {
      if (!isChartType(row[4])) fail(`${where} has an unknown chart type`);
      pane.chartType = row[4];
    }
    if (row[5] !== undefined) {
      if (!isPriceScale(row[5])) fail(`${where} has an unknown price scale`);
      pane.scale = row[5];
    }
    return pane;
  });
  return { count: raw.n, sync: { crosshair: flag(0), timeframe: flag(1), symbol: flag(2) }, panes };
}

/** Checks a decoded JSON value and returns the chart, plus notes about anything left out. */
export function parseShared(raw: unknown): { chart: SharedChart; notes: string[] } {
  if (!isObject(raw)) fail('it is not a chart');
  if (typeof raw.v !== 'number' || !Number.isInteger(raw.v) || raw.v < 1) fail('it has no valid version');
  if (raw.v > SHARE_VERSION) throw new ShareError('The link was made by a newer version of Kandle. Reload the page to update, then open the link again.');
  const notes = new Set<string>();
  const chart: SharedChart = market(raw.s, raw.y, raw.t, 'the chart');
  if (raw.k !== undefined || raw.a !== undefined) {
    if (!isChartType(raw.k)) fail('the chart type is unknown');
    if (!isPriceScale(raw.a)) fail('the price scale is unknown');
    chart.style = { type: raw.k, scale: raw.a };
  }
  if (raw.r !== undefined) {
    const r = list(raw.r, 'range fields', 2);
    const time = r[0] === null ? null : finite(r[0], 'the visible range', 0, MAX_TIME);
    chart.range = { time, barSpace: finite(r[1], 'the bar spacing', BAR_SPACE.min, BAR_SPACE.max) };
  }
  if (raw.i !== undefined) chart.indicators = indicators(raw.i, LIMITS.indicators, notes);
  if (raw.d !== undefined) chart.drawings = drawings(raw.d, notes);
  if (raw.x !== undefined) chart.scripts = scripts(raw.x);
  if (raw.l !== undefined) chart.layout = layout(raw.l, notes);
  return { chart, notes: [...notes] };
}

// ---------------------------------------------------------------- bytes

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) fail('it has characters a link cannot have');
  let binary: string;
  try {
    binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
  } catch {
    fail('it was cut short');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** True when this browser can compress links (every current browser can). */
export function canCompress(): boolean {
  try {
    return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function' && !!new CompressionStream('deflate-raw');
  } catch {
    return false;
  }
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Inflates, refusing output larger than `max` bytes. */
async function inflate(bytes: Uint8Array, max: number): Promise<Uint8Array> {
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) {
        void reader.cancel().catch(() => undefined);
        throw new ShareError('The link holds too much data to open.');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ShareError) throw error;
    fail('its compressed data is broken');
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * The part after `#s=`: "z" and base64url of deflate-raw JSON, or "j" and base64url of the
 * JSON itself when the browser cannot compress or that comes out shorter.
 */
export async function encodeShared(chart: SharedChart, compress = canCompress()): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(toWire(chart)));
  const plain = `j${toBase64Url(json)}`;
  if (!compress) return plain;
  const packed = `z${toBase64Url(await deflate(json))}`;
  return packed.length < plain.length ? packed : plain;
}

/** True for a location hash that holds a shared chart. */
export function isShareHash(hash: string): boolean {
  return hash.startsWith(SHARE_HASH);
}

/** Reads a `#s=...` hash. Throws ShareError with a message for the user. */
export async function decodeShareHash(hash: string): Promise<{ chart: SharedChart; notes: string[] }> {
  if (!isShareHash(hash)) throw new ShareError('This is not a Kandle chart link.');
  const payload = hash.slice(SHARE_HASH.length);
  if (payload.length > MAX_FRAGMENT) throw new ShareError('The link is too long to open.');
  const mode = payload[0];
  if (mode !== 'z' && mode !== 'j') fail('it does not start like a chart link');
  let bytes = fromBase64Url(payload.slice(1));
  if (mode === 'z') {
    if (!canCompress()) throw new ShareError('This browser cannot open compressed links. Try a current version of Chrome, Edge, Firefox or Safari.');
    bytes = await inflate(bytes, MAX_JSON_BYTES);
  } else if (bytes.length > MAX_JSON_BYTES) {
    throw new ShareError('The link holds too much data to open.');
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail('its data is not valid JSON');
  }
  return parseShared(json);
}

/** The page address without its fragment, followed by the chart. */
export function shareUrl(page: string, payload: string): string {
  const hash = page.indexOf('#');
  return `${hash < 0 ? page : page.slice(0, hash)}${SHARE_HASH}${payload}`;
}
