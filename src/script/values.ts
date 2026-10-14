/**
 * Runtime values. Numbers are plain JS numbers with NaN standing in for `na`. Bools are
 * JS booleans, strings are JS strings, colors are `Color` instances, and `na` for colors,
 * strings and handles is `null`.
 */

export class Color {
  private cssCache: string | null = null;

  /** r, g, b in 0..255, a in 0..1 (1 = opaque). */
  constructor(
    readonly r: number,
    readonly g: number,
    readonly b: number,
    readonly a: number,
  ) {}

  css(): string {
    if (this.cssCache === null) {
      this.cssCache = this.a >= 1 ? `rgb(${this.r},${this.g},${this.b})` : `rgba(${this.r},${this.g},${this.b},${+this.a.toFixed(3)})`;
    }
    return this.cssCache;
  }

  /** Transparency on the 0..100 scale scripts use (0 = opaque). */
  get transparency(): number {
    return Math.round((1 - this.a) * 100);
  }

  withTransparency(transp: number): Color {
    const t = Math.min(100, Math.max(0, transp));
    return new Color(this.r, this.g, this.b, 1 - t / 100);
  }

  hex(): string {
    const h = (n: number) => Math.round(n).toString(16).padStart(2, '0');
    const base = `#${h(this.r)}${h(this.g)}${h(this.b)}`;
    return this.a >= 1 ? base : `${base}${h(this.a * 255)}`;
  }

  equals(other: Color): boolean {
    return this.r === other.r && this.g === other.g && this.b === other.b && Math.abs(this.a - other.a) < 1e-9;
  }

  static fromHex(hex: string): Color | null {
    const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex.trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    const a = m[2] === undefined ? 1 : parseInt(m[2], 16) / 255;
    return new Color((n >> 16) & 255, (n >> 8) & 255, n & 255, a);
  }
}

/** Arrays created with array.new_* and friends. Reference semantics, like the original. */
export class ScriptArray {
  constructor(public items: unknown[]) {}
}

/** Several values returned at once, from `[a, b]` in a function or a built-in like ta.macd. */
export class Tuple {
  constructor(readonly items: unknown[]) {}
}

/** What plot() and hline() return, so fill() can refer to them. */
export class PlotHandle {
  constructor(
    readonly kind: 'plot' | 'hline',
    readonly index: number,
  ) {}
}

export function isNa(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v));
}

/** Truthiness for conditions: na and 0 are false. */
export function truthy(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  return v !== null && v !== undefined && v !== '';
}

export function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return NaN;
}

export function typeName(v: unknown): string {
  if (v === null || v === undefined) return 'na';
  if (typeof v === 'number') return Number.isNaN(v) ? 'na' : Number.isInteger(v) ? 'int' : 'float';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'string') return 'string';
  if (v instanceof Color) return 'color';
  if (v instanceof ScriptArray) return 'array';
  if (v instanceof Tuple) return 'tuple';
  if (v instanceof PlotHandle) return v.kind;
  return 'value';
}

/** Formats a number the way str.tostring does by default: up to 10 significant decimals, no trailing zeros. */
export function formatNumber(v: number, format?: string): string {
  if (Number.isNaN(v)) return 'NaN';
  if (!Number.isFinite(v)) return v > 0 ? 'Infinity' : '-Infinity';
  if (format) {
    if (format === 'percent') return `${formatNumber(v * 1)}%`;
    if (format === 'integer') return String(Math.round(v));
    const m = /^#*(?:,##0|0)?(?:\.(0+|#+))?$/.exec(format);
    if (m) {
      const decimals = m[1]?.length ?? 0;
      const fixed = v.toFixed(decimals);
      return m[1]?.startsWith('#') ? String(Number(fixed)) : fixed;
    }
  }
  if (Number.isInteger(v)) return String(v);
  return String(Number(v.toFixed(10)));
}

export function valueToString(v: unknown, format?: string): string {
  if (typeof v === 'number') return formatNumber(v, format);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return 'NaN';
  if (v instanceof Color) return v.hex();
  if (v instanceof ScriptArray) return `[${v.items.map((x) => valueToString(x)).join(', ')}]`;
  return typeName(v);
}

export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a instanceof Color && b instanceof Color) return a.equals(b);
  return a === b;
}
