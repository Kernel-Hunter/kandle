/** Source position. Lines and columns are 1-based; offsets are 0-based character indexes. */
export interface Span {
  line: number;
  col: number;
  from: number;
  to: number;
}

/** A compile or runtime error that points at a place in the script. */
export class ScriptError extends Error {
  readonly line: number;
  readonly col: number;
  readonly from: number;
  readonly to: number;
  /** Set for errors raised while running, so the message can say which bar failed. */
  bar?: number;

  constructor(message: string, span: Span | null, bar?: number) {
    super(message);
    this.name = 'ScriptError';
    this.line = span?.line ?? 1;
    this.col = span?.col ?? 1;
    this.from = span?.from ?? 0;
    this.to = Math.max(span?.to ?? 0, this.from);
    if (bar !== undefined) this.bar = bar;
  }

  /** "12:5 message" style text for toasts and the automation API. */
  format(): string {
    const where = `${this.line}:${this.col}`;
    return this.bar === undefined ? `${where} ${this.message}` : `${where} ${this.message} (on bar ${this.bar})`;
  }
}

export function spanBetween(a: Span, b: Span): Span {
  return { line: a.line, col: a.col, from: a.from, to: b.to };
}
