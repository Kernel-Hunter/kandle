import { ScriptError, type Span } from './errors';

export type TokenType = 'num' | 'str' | 'color' | 'ident' | 'kw' | 'op' | 'newline' | 'indent' | 'dedent' | 'eof';

export interface Token {
  type: TokenType;
  value: string;
  span: Span;
  /** For numbers: true when written without a decimal point or exponent. */
  isInt?: boolean;
  /** For numbers: the parsed value. */
  num?: number;
}

/** Words that always act as keywords. `to`, `by`, `in`, `method`, `type` and friends are contextual. */
export const KEYWORDS = new Set(['if', 'else', 'for', 'while', 'switch', 'var', 'varip', 'and', 'or', 'not', 'true', 'false', 'na', 'break', 'continue']);

const OPERATORS = ['==', '!=', '<=', '>=', ':=', '+=', '-=', '*=', '/=', '%=', '=>', '=', '<', '>', '+', '-', '*', '/', '%', '?', ':', ',', '.', '(', ')', '[', ']'];

/** Tokens that cannot end a statement, so a line ending with one continues on the next line. */
const CONTINUES = new Set(['+', '-', '*', '/', '%', '==', '!=', '<', '>', '<=', '>=', '?', ':', ',', '=', ':=', '+=', '-=', '*=', '/=', '%=', 'and', 'or', 'not', '(', '[']);

/** Keywords that open an indented block somewhere on their line. */
const BLOCK_OPENERS = new Set(['if', 'else', 'for', 'while', 'switch']);

interface RawToken extends Token {
  /** First token on its physical line. */
  bol: boolean;
  /** Indentation of that physical line, in columns (tab = 4). */
  indent: number;
}

const isDigit = (c: string) => c >= '0' && c <= '9';
const isIdentStart = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isIdentPart = (c: string) => isIdentStart(c) || isDigit(c);
const isHex = (c: string) => /[0-9a-fA-F]/.test(c);

function scan(source: string): RawToken[] {
  const tokens: RawToken[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  let atBol = true;
  let indent = 0;

  const span = (from: number, to: number): Span => ({ line, col: from - lineStart + 1, from, to });
  const push = (type: TokenType, value: string, from: number, extra: Partial<Token> = {}) => {
    tokens.push({ type, value, span: span(from, i), bol: atBol, indent, ...extra });
    atBol = false;
  };

  while (i < source.length) {
    const c = source[i];
    if (atBol && (c === ' ' || c === '\t') && i === lineStart) {
      // Measure indentation of this physical line.
      let cols = 0;
      while (i < source.length && (source[i] === ' ' || source[i] === '\t')) {
        cols += source[i] === '\t' ? 4 : 1;
        i++;
      }
      indent = cols;
      continue;
    }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && source[i + 1] === '\n') i++;
      i++;
      line++;
      lineStart = i;
      atBol = true;
      indent = 0;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\f' || c === '\v') {
      i++;
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i++;
      continue;
    }
    const from = i;
    if (isDigit(c) || (c === '.' && isDigit(source[i + 1] ?? ''))) {
      let isInt = true;
      while (isDigit(source[i] ?? '')) i++;
      if (source[i] === '.' && isDigit(source[i + 1] ?? '')) {
        isInt = false;
        i++;
        while (isDigit(source[i] ?? '')) i++;
      } else if (source[i] === '.' && !isIdentStart(source[i + 1] ?? '')) {
        // "1." is a float literal.
        isInt = false;
        i++;
      }
      if ((source[i] === 'e' || source[i] === 'E') && (isDigit(source[i + 1] ?? '') || ((source[i + 1] === '-' || source[i + 1] === '+') && isDigit(source[i + 2] ?? '')))) {
        isInt = false;
        i += 2;
        while (isDigit(source[i] ?? '')) i++;
      }
      const text = source.slice(from, i);
      push('num', text, from, { isInt, num: Number(text) });
      continue;
    }
    if (isIdentStart(c)) {
      while (i < source.length && isIdentPart(source[i])) i++;
      const word = source.slice(from, i);
      push(KEYWORDS.has(word) ? 'kw' : 'ident', word, from);
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      let out = '';
      let closed = false;
      while (i < source.length) {
        const ch = source[i];
        if (ch === '\n' || ch === '\r') break;
        if (ch === '\\') {
          const next = source[i + 1] ?? '';
          out += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          i += 2;
          continue;
        }
        i++;
        if (ch === c) {
          closed = true;
          break;
        }
        out += ch;
      }
      if (!closed) throw new ScriptError('Unterminated string', span(from, i));
      push('str', out, from);
      continue;
    }
    if (c === '#') {
      i++;
      while (isHex(source[i] ?? '')) i++;
      const hex = source.slice(from + 1, i);
      if (hex.length !== 6 && hex.length !== 8) throw new ScriptError('Colors are written as #RRGGBB or #RRGGBBAA', span(from, i));
      push('color', hex, from);
      continue;
    }
    const op = OPERATORS.find((o) => source.startsWith(o, i));
    if (op) {
      i += op.length;
      push('op', op, from);
      continue;
    }
    throw new ScriptError(`Unexpected character '${c}'`, span(from, from + 1));
  }
  tokens.push({ type: 'eof', value: '', span: span(i, i), bol: true, indent: 0 });
  return tokens;
}

function expectsBlock(lineTokens: Token[]): boolean {
  let depth = 0;
  for (const t of lineTokens) {
    if (t.type === 'op' && (t.value === '(' || t.value === '[')) depth++;
    else if (t.type === 'op' && (t.value === ')' || t.value === ']')) depth--;
    else if (depth === 0 && t.type === 'kw' && BLOCK_OPENERS.has(t.value)) return true;
  }
  const last = lineTokens[lineTokens.length - 1];
  return !!last && last.type === 'op' && last.value === '=>';
}

/**
 * Turns source text into tokens with NEWLINE, INDENT and DEDENT markers. Lines inside
 * brackets, lines after an operator or comma, and lines indented by something other than
 * a multiple of four continue the previous line.
 */
export function tokenize(source: string): Token[] {
  const raw = scan(source);
  const out: Token[] = [];
  const stack: number[] = [0];
  let depth = 0;
  let lineTokens: Token[] = [];
  let lineIndent = 0;

  const endLine = (at: Span) => {
    if (lineTokens.length > 0) out.push({ type: 'newline', value: '', span: { line: at.line, col: at.col + (at.to - at.from), from: at.to, to: at.to } });
  };

  for (const tok of raw) {
    if (tok.type === 'eof') {
      const last = lineTokens[lineTokens.length - 1];
      if (last) endLine(last.span);
      while (stack.length > 1) {
        stack.pop();
        out.push({ type: 'dedent', value: '', span: tok.span });
      }
      out.push({ type: 'eof', value: '', span: tok.span });
      break;
    }
    if (tok.bol && depth === 0) {
      const prev = lineTokens[lineTokens.length - 1];
      const prevContinues = !!prev && (prev.type === 'op' || prev.type === 'kw') && CONTINUES.has(prev.value);
      const oddIndent = prev !== undefined && tok.indent > lineIndent && (tok.indent - lineIndent) % 4 !== 0 && !expectsBlock(lineTokens);
      if (!(prevContinues || oddIndent)) {
        if (prev) endLine(prev.span);
        const opener = prev ? expectsBlock(lineTokens) : false;
        const top = stack[stack.length - 1];
        if (tok.indent > top) {
          if (!opener) throw new ScriptError('Unexpected indentation', tok.span);
          stack.push(tok.indent);
          out.push({ type: 'indent', value: '', span: tok.span });
        } else if (tok.indent < top) {
          while (stack.length > 1 && tok.indent < stack[stack.length - 1]) {
            stack.pop();
            out.push({ type: 'dedent', value: '', span: tok.span });
          }
          if (tok.indent !== stack[stack.length - 1]) throw new ScriptError('Indentation does not match any outer block', tok.span);
        } else if (opener) {
          throw new ScriptError('Expected an indented block on the next line', prev!.span);
        }
        lineTokens = [];
        lineIndent = tok.indent;
      }
    }
    if (tok.type === 'op' && (tok.value === '(' || tok.value === '[')) depth++;
    else if (tok.type === 'op' && (tok.value === ')' || tok.value === ']')) depth = Math.max(0, depth - 1);
    const clean: Token = { type: tok.type, value: tok.value, span: tok.span };
    if (tok.type === 'num') {
      clean.isInt = tok.isInt;
      clean.num = tok.num;
    }
    lineTokens.push(clean);
    out.push(clean);
  }
  return out;
}
