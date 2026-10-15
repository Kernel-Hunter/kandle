import { APP } from '../config';
import type { KeyValueStorage } from '../store/layout';

export type AlertKind = 'price' | 'drawing' | 'indicator';
export type AlertCondition = 'crosses' | 'crosses_up' | 'crosses_down' | 'touches';
export type AlertFrequency = 'once' | 'every';

export const ALERT_CONDITIONS: readonly AlertCondition[] = ['crosses', 'crosses_up', 'crosses_down', 'touches'];

export interface GeometryPoint {
  timestamp: number;
  value: number;
}

/** A drawn line, copied into the alert so it keeps working after a reload. */
export interface LineGeometry {
  /** Chart engine overlay name, e.g. horizontalStraightLine or segment. */
  name: string;
  points: GeometryPoint[];
  /** Overlay id at the time the alert was made; used to follow the line if it is moved. */
  id?: string;
}

export interface IndicatorRef {
  name: string;
  /** Figure key of the line to watch, e.g. rsi1 or macd. */
  line: string;
  params?: number[];
  /** Indicator id at creation time, used when it is still on the chart. */
  id?: string;
}

export interface Alert {
  id: string;
  source: string;
  symbol: string;
  kind: AlertKind;
  condition: AlertCondition;
  frequency: AlertFrequency;
  /** Price level for price alerts, value level for indicator alerts. */
  level?: number;
  drawing?: LineGeometry;
  indicator?: IndicatorRef;
  message?: string;
  active: boolean;
  createdAt: number;
  triggeredAt?: number;
  triggerCount: number;
  /** Bar time of the last trigger; "every" alerts fire at most once per bar. */
  lastBar?: number;
}

export type NewAlert = Pick<Alert, 'source' | 'symbol' | 'kind' | 'condition' | 'frequency'> &
  Partial<Pick<Alert, 'level' | 'drawing' | 'indicator' | 'message'>>;

/** One live update for a symbol: the forming bar's open time, close and range so far. */
export interface Tick {
  time: number;
  price: number;
  high: number;
  low: number;
}

export interface FiredAlert {
  alert: Alert;
  /** The value that crossed (price or indicator value). */
  value: number;
  /** The level it crossed at that moment. */
  level: number;
  text: string;
}

/** Lines that alerts can follow. Everything else (rectangles, fibs, notes) has no single level. */
export const LINE_OVERLAYS: ReadonlySet<string> = new Set([
  'horizontalStraightLine',
  'horizontalRayLine',
  'horizontalSegment',
  'priceLine',
  'segment',
  'rayLine',
  'straightLine',
]);

const HORIZONTAL: ReadonlySet<string> = new Set(['horizontalStraightLine', 'horizontalRayLine', 'horizontalSegment', 'priceLine']);

/**
 * Price of a drawn line at `time`, or null when the line does not extend to that time.
 * Horizontal lines are flat; trend lines interpolate between their two points, rays
 * extend past the second point, extended lines both ways.
 */
export function lineValueAt(geometry: LineGeometry, time: number): number | null {
  const [a, b] = geometry.points;
  if (!a) return null;
  if (HORIZONTAL.has(geometry.name)) {
    if (geometry.name === 'horizontalRayLine' && b && b.timestamp < a.timestamp) {
      // The engine draws the ray toward the second point when it has one.
      return time <= a.timestamp ? a.value : null;
    }
    if (geometry.name === 'horizontalRayLine' || geometry.name === 'priceLine') return time >= a.timestamp ? a.value : null;
    return a.value;
  }
  if (!b) return null;
  if (a.timestamp === b.timestamp) return null; // vertical; no single price
  const slope = (b.value - a.value) / (b.timestamp - a.timestamp);
  const value = a.value + slope * (time - a.timestamp);
  const lo = Math.min(a.timestamp, b.timestamp);
  const hi = Math.max(a.timestamp, b.timestamp);
  switch (geometry.name) {
    case 'segment':
      return time >= lo && time <= hi ? value : null;
    case 'rayLine':
      // A ray starts at its first point and runs through the second.
      return b.timestamp >= a.timestamp ? (time >= a.timestamp ? value : null) : time <= a.timestamp ? value : null;
    case 'straightLine':
      return value;
    default:
      return null;
  }
}

/**
 * Did the watched value move across `level` between two observations?
 * The level can move too (trend lines), so the comparison uses the gap on each side.
 * Landing exactly on the level counts as crossing from the side it came from.
 */
export function crossed(condition: AlertCondition, prevGap: number, gap: number): boolean {
  const up = prevGap < 0 && gap >= 0;
  const down = prevGap > 0 && gap <= 0;
  switch (condition) {
    case 'crosses_up':
      return up;
    case 'crosses_down':
      return down;
    case 'crosses':
    case 'touches':
      return up || down;
  }
}

export function touches(level: number, high: number, low: number): boolean {
  return low <= level && level <= high;
}

export const CONDITION_LABELS: Record<AlertCondition, string> = {
  crosses: 'crosses',
  crosses_up: 'crosses up',
  crosses_down: 'crosses down',
  touches: 'touches',
};

const DRAWING_LABELS: Record<string, string> = {
  horizontalStraightLine: 'horizontal line',
  horizontalRayLine: 'horizontal ray',
  horizontalSegment: 'horizontal segment',
  priceLine: 'price label',
  segment: 'trend line',
  rayLine: 'ray',
  straightLine: 'extended line',
};

export function drawingLabel(name: string): string {
  return DRAWING_LABELS[name] ?? name;
}

/** Short human description, used in the alert list and notifications. */
export function describeAlert(alert: Alert, precision = 2): string {
  const fmt = (v: number | undefined) => (v === undefined ? '?' : Number(v.toFixed(Math.min(Math.max(precision, 0), 10))).toString());
  const cond = CONDITION_LABELS[alert.condition];
  switch (alert.kind) {
    case 'price':
      return `${alert.symbol} price ${cond} ${fmt(alert.level)}`;
    case 'drawing': {
      const g = alert.drawing;
      const label = g ? drawingLabel(g.name) : 'line';
      const at = g && HORIZONTAL.has(g.name) ? ` at ${fmt(g.points[0]?.value)}` : '';
      return `${alert.symbol} price ${cond} ${label}${at}`;
    }
    case 'indicator': {
      const ind = alert.indicator;
      const params = ind?.params?.length ? `(${ind.params.join(', ')})` : '';
      return `${alert.symbol} ${ind?.name ?? 'indicator'}${params} ${ind?.line ?? ''} ${cond} ${fmt(alert.level)}`.replace(/\s+/g, ' ');
    }
  }
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function sanitizePoints(raw: unknown): GeometryPoint[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p) => p && isFiniteNumber((p as GeometryPoint).timestamp) && isFiniteNumber((p as GeometryPoint).value))
    .map((p) => ({ timestamp: (p as GeometryPoint).timestamp, value: (p as GeometryPoint).value }));
}

/** Validates stored or incoming alerts; returns null for anything unusable. */
export function sanitizeAlert(raw: unknown): Alert | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.source !== 'string' || typeof r.symbol !== 'string') return null;
  if (r.kind !== 'price' && r.kind !== 'drawing' && r.kind !== 'indicator') return null;
  if (!ALERT_CONDITIONS.includes(r.condition as AlertCondition)) return null;
  const alert: Alert = {
    id: r.id,
    source: r.source,
    symbol: r.symbol,
    kind: r.kind,
    condition: r.condition as AlertCondition,
    frequency: r.frequency === 'every' ? 'every' : 'once',
    active: r.active !== false,
    createdAt: isFiniteNumber(r.createdAt) ? r.createdAt : 0,
    triggerCount: isFiniteNumber(r.triggerCount) ? r.triggerCount : 0,
  };
  if (isFiniteNumber(r.level)) alert.level = r.level;
  if (isFiniteNumber(r.triggeredAt)) alert.triggeredAt = r.triggeredAt;
  if (isFiniteNumber(r.lastBar)) alert.lastBar = r.lastBar;
  if (typeof r.message === 'string' && r.message) alert.message = r.message.slice(0, 200);
  if (r.drawing && typeof r.drawing === 'object') {
    const d = r.drawing as Record<string, unknown>;
    const points = sanitizePoints(d.points);
    if (typeof d.name === 'string' && points.length > 0) {
      alert.drawing = { name: d.name, points, ...(typeof d.id === 'string' ? { id: d.id } : {}) };
    }
  }
  if (r.indicator && typeof r.indicator === 'object') {
    const i = r.indicator as Record<string, unknown>;
    if (typeof i.name === 'string' && typeof i.line === 'string') {
      alert.indicator = {
        name: i.name,
        line: i.line,
        ...(Array.isArray(i.params) ? { params: i.params.filter(isFiniteNumber) } : {}),
        ...(typeof i.id === 'string' ? { id: i.id } : {}),
      };
    }
  }
  if (alert.kind === 'price' && alert.level === undefined) return null;
  if (alert.kind === 'drawing' && !alert.drawing) return null;
  if (alert.kind === 'indicator' && (!alert.indicator || alert.level === undefined)) return null;
  return alert;
}

/** Live lookups the engine cannot do on its own. */
export interface TickContext {
  /** Current geometry of the alert's drawing if it is still on the chart. */
  drawing?(alert: Alert): LineGeometry | null;
  /** Latest value of the alert's indicator line, or null if it is not on the chart. */
  indicatorValue?(alert: Alert): number | null;
}

interface Observation {
  value: number;
  level: number;
}

let counter = 0;
function newId(now: number): string {
  counter = (counter + 1) % 1_000_000;
  return `a${now.toString(36)}${counter.toString(36)}`;
}

/**
 * Holds alerts, persists them, and decides which fire on each live update.
 * Cross detection compares the gap between value and level with the previous update,
 * so it needs two observations; the first update after creation only records a baseline.
 */
export class AlertEngine {
  private alerts: Alert[];
  private readonly last = new Map<string, Observation>();
  private readonly firstBar = new Map<string, number>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly storage: KeyValueStorage,
    private readonly now: () => number = Date.now,
    private readonly key = `${APP.id}:alerts`,
  ) {
    this.alerts = this.load();
  }

  private load(): Alert[] {
    try {
      const raw = this.storage.getItem(this.key);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.map(sanitizeAlert).filter((a): a is Alert => a !== null) : [];
    } catch {
      return [];
    }
  }

  private save(): void {
    try {
      this.storage.setItem(this.key, JSON.stringify(this.alerts));
    } catch {
      // Storage full or blocked; alerts still work for this session.
    }
    for (const l of this.listeners) l();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): Alert[] {
    return this.alerts.map((a) => ({ ...a }));
  }

  get(id: string): Alert | undefined {
    return this.alerts.find((a) => a.id === id);
  }

  /** Adds an alert. `seed` is the current value and level so the first update can already cross. */
  add(input: NewAlert, seed?: { value: number; level: number }): Alert {
    const alert = sanitizeAlert({ ...input, id: newId(this.now()), active: true, createdAt: this.now(), triggerCount: 0 });
    if (!alert) throw new Error('Invalid alert');
    this.alerts.push(alert);
    if (seed && Number.isFinite(seed.value) && Number.isFinite(seed.level)) this.last.set(alert.id, seed);
    this.save();
    return { ...alert };
  }

  remove(id: string): boolean {
    const before = this.alerts.length;
    this.alerts = this.alerts.filter((a) => a.id !== id);
    this.last.delete(id);
    this.firstBar.delete(id);
    if (this.alerts.length === before) return false;
    this.save();
    return true;
  }

  clear(): number {
    const count = this.alerts.length;
    this.alerts = [];
    this.last.clear();
    this.firstBar.clear();
    this.save();
    return count;
  }

  /** Re-arms a fired one-shot alert, or pauses an active one. */
  setActive(id: string, active: boolean): void {
    const alert = this.alerts.find((a) => a.id === id);
    if (!alert || alert.active === active) return;
    alert.active = active;
    this.last.delete(id);
    this.firstBar.delete(id);
    this.save();
  }

  /**
   * Feeds one live update for `source:symbol` and returns the alerts that fired.
   * `kinds` limits which alerts are checked, so indicator alerts can run after the chart recomputes.
   */
  onTick(source: string, symbol: string, tick: Tick, ctx: TickContext = {}, kinds?: readonly AlertKind[]): FiredAlert[] {
    const fired: FiredAlert[] = [];
    let changed = false;
    for (const alert of this.alerts) {
      if (!alert.active || alert.source !== source || alert.symbol !== symbol) continue;
      if (kinds && !kinds.includes(alert.kind)) continue;
      const obs = this.observe(alert, tick, ctx);
      if (!obs) continue;
      const prev = this.last.get(alert.id);
      this.last.set(alert.id, obs);
      if (!this.firstBar.has(alert.id)) this.firstBar.set(alert.id, tick.time);
      let hit = prev ? crossed(alert.condition, prev.value - prev.level, obs.value - obs.level) : false;
      if (alert.condition === 'touches') {
        if (obs.value === obs.level) hit = true;
        // A bar's range only counts from the first full bar after the alert started watching;
        // otherwise a level the current bar already spanned would fire immediately.
        if (alert.kind !== 'indicator' && tick.time !== this.firstBar.get(alert.id) && touches(obs.level, tick.high, tick.low)) hit = true;
      }
      if (!hit) continue;
      if (alert.frequency === 'every' && alert.lastBar === tick.time) continue;
      alert.triggerCount += 1;
      alert.triggeredAt = this.now();
      alert.lastBar = tick.time;
      if (alert.frequency === 'once') alert.active = false;
      changed = true;
      fired.push({ alert: { ...alert }, value: obs.value, level: obs.level, text: alert.message || describeAlert(alert) });
    }
    if (changed) this.save();
    return fired;
  }

  private observe(alert: Alert, tick: Tick, ctx: TickContext): Observation | null {
    switch (alert.kind) {
      case 'price':
        return alert.level === undefined ? null : { value: tick.price, level: alert.level };
      case 'drawing': {
        const live = ctx.drawing?.(alert);
        if (live && alert.drawing && JSON.stringify(live.points) !== JSON.stringify(alert.drawing.points)) {
          // The user moved the line; follow it and keep the copy current.
          alert.drawing = { ...alert.drawing, points: live.points.map((p) => ({ ...p })) };
          this.save();
        }
        const geometry = live ?? alert.drawing;
        if (!geometry) return null;
        const level = lineValueAt(geometry, tick.time);
        return level === null ? null : { value: tick.price, level };
      }
      case 'indicator': {
        const value = ctx.indicatorValue?.(alert);
        if (value === null || value === undefined || !Number.isFinite(value) || alert.level === undefined) return null;
        return { value, level: alert.level };
      }
    }
  }
}
