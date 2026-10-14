import type { Arg, Expr, Param, Program, Stmt, SwitchCase, TypeRef } from './ast';
import { ScriptError, spanBetween, type Span } from './errors';
import { tokenize, type Token } from './lexer';

const TYPE_NAMES = new Set(['int', 'float', 'bool', 'color', 'string', 'label', 'line', 'box', 'table', 'linefill', 'polyline', 'array', 'matrix', 'map']);
const QUALIFIERS = new Set(['series', 'simple', 'const']);
const ASSIGN_OPS = new Set([':=', '+=', '-=', '*=', '/=', '%=']);

const BINARY_LEVELS: Array<{ ops: string[]; kw?: boolean }> = [
  { ops: ['or'], kw: true },
  { ops: ['and'], kw: true },
  { ops: ['==', '!='] },
  { ops: ['<', '<=', '>', '>='] },
  { ops: ['+', '-'] },
  { ops: ['*', '/', '%'] },
];

/** Reads the `//@version=N` header if present. */
export function readVersion(source: string): number | null {
  const m = /^\s*\/\/\s*@version\s*=\s*(\d+)/m.exec(source);
  return m ? Number(m[1]) : null;
}

class Parser {
  private pos = 0;
  private lastConsumed: Token | null = null;

  constructor(private readonly tokens: Token[]) {}

  // ------------------------------------------------------------ token helpers

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  private next(): Token {
    const t = this.tokens[this.pos];
    if (this.pos < this.tokens.length - 1) this.pos++;
    this.lastConsumed = t;
    return t;
  }

  private isOp(value: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.type === 'op' && t.value === value;
  }

  private isKw(value: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.type === 'kw' && t.value === value;
  }

  private isIdent(value?: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.type === 'ident' && (value === undefined || t.value === value);
  }

  private describe(t: Token): string {
    switch (t.type) {
      case 'eof':
        return 'end of script';
      case 'newline':
        return 'end of line';
      case 'indent':
        return 'indented block';
      case 'dedent':
        return 'end of block';
      case 'str':
        return 'string';
      default:
        return `'${t.value}'`;
    }
  }

  private fail(message: string, t: Token = this.peek()): never {
    throw new ScriptError(message, t.span);
  }

  private expectOp(value: string, context?: string): Token {
    if (!this.isOp(value)) this.fail(`Expected '${value}'${context ? ` ${context}` : ''} but found ${this.describe(this.peek())}`);
    return this.next();
  }

  private expectIdent(context: string): Token {
    if (this.peek().type !== 'ident') this.fail(`Expected ${context} but found ${this.describe(this.peek())}`);
    return this.next();
  }

  private skipNewlines(): void {
    while (this.peek().type === 'newline') this.next();
  }

  /** Index of the token after the bracket that closes the one at `start`, or -1. */
  private matchBracket(start: number): number {
    let depth = 0;
    for (let i = start; i < this.tokens.length; i++) {
      const t = this.tokens[i];
      if (t.type === 'op' && (t.value === '(' || t.value === '[')) depth++;
      else if (t.type === 'op' && (t.value === ')' || t.value === ']')) {
        depth--;
        if (depth === 0) return i + 1;
      } else if (t.type === 'newline' || t.type === 'eof') return -1;
    }
    return -1;
  }

  // ------------------------------------------------------------ program and statements

  parseProgram(): Stmt[] {
    const body: Stmt[] = [];
    this.skipNewlines();
    while (this.peek().type !== 'eof') {
      if (this.peek().type === 'indent') this.fail('Unexpected indentation');
      if (this.peek().type === 'dedent') {
        this.next();
        continue;
      }
      body.push(this.parseStatement(true));
      this.skipNewlines();
    }
    return body;
  }

  private endStatement(): void {
    const t = this.peek();
    if (t.type === 'newline') {
      this.next();
      return;
    }
    if (t.type === 'eof' || t.type === 'dedent') return;
    // A compound statement that ended with a block has already consumed its line end.
    if (this.lastConsumed?.type === 'dedent') return;
    this.fail(`Unexpected ${this.describe(t)}; expected the end of the line`);
  }

  private parseBlock(): Stmt[] {
    if (this.peek().type !== 'newline') this.fail(`Expected a new line and an indented block but found ${this.describe(this.peek())}`);
    this.next();
    if (this.peek().type !== 'indent') this.fail('Expected an indented block');
    this.next();
    const body: Stmt[] = [];
    while (this.peek().type !== 'dedent' && this.peek().type !== 'eof') {
      if (this.peek().type === 'newline') {
        this.next();
        continue;
      }
      body.push(this.parseStatement(false));
    }
    if (this.peek().type === 'dedent') this.next();
    if (body.length === 0) this.fail('Empty block');
    return body;
  }

  /** Lookahead: `[qualifier] type[[]] name =` or `array<type> name =`. Returns the token count of the type part, or 0. */
  private typePrefixLength(): number {
    let i = 0;
    while (this.peek(i).type === 'ident' && QUALIFIERS.has(this.peek(i).value)) i++;
    const t = this.peek(i);
    if (t.type !== 'ident' || !TYPE_NAMES.has(t.value)) return 0;
    let len = i + 1;
    if (this.isOp('[', len) && this.isOp(']', len + 1)) len += 2;
    else if (this.isOp('<', len) && this.peek(len + 1).type === 'ident' && this.isOp('>', len + 2)) len += 3;
    if (this.peek(len).type === 'ident' && (this.isOp('=', len + 1) || this.isOp(':=', len + 1))) return len;
    return 0;
  }

  private parseTypeRef(): TypeRef {
    while (this.isIdent() && QUALIFIERS.has(this.peek().value)) this.next();
    const name = this.expectIdent('a type').value;
    if (this.isOp('[') && this.isOp(']', 1)) {
      this.next();
      this.next();
      return { name, isArray: true };
    }
    if (this.isOp('<')) {
      this.next();
      const inner = this.expectIdent('a type').value;
      this.expectOp('>');
      return { name: inner, isArray: name === 'array' };
    }
    return { name, isArray: false };
  }

  private parseStatement(topLevel: boolean): Stmt {
    const t = this.peek();

    if (t.type === 'kw' && (t.value === 'break' || t.value === 'continue')) {
      this.next();
      this.endStatement();
      return { kind: t.value, span: t.span };
    }

    if (t.type === 'ident') {
      if ((t.value === 'import' || t.value === 'export') && this.peek(1).type === 'ident') {
        this.fail(`'${t.value}' is not supported yet`);
      }
      if ((t.value === 'type' || t.value === 'enum') && this.peek(1).type === 'ident' && this.peek(2).type === 'newline') {
        this.fail(`User-defined ${t.value}s are not supported yet`);
      }
      if (t.value === 'method' && this.peek(1).type === 'ident' && this.isOp('(', 2)) {
        if (!topLevel) this.fail('Methods can only be declared at the top level');
        this.next();
        return this.parseFunction(true);
      }
      if (this.isOp('(', 1)) {
        const after = this.matchBracket(this.pos + 1);
        if (after > 0 && this.tokens[after]?.type === 'op' && this.tokens[after].value === '=>') {
          if (!topLevel) this.fail('Functions can only be declared at the top level');
          return this.parseFunction(false);
        }
      }
      const typeLen = this.typePrefixLength();
      if (typeLen > 0) {
        const type = this.parseTypeRef();
        return this.parseDeclaration('plain', type, t.span);
      }
      if (this.isOp('=', 1)) return this.parseDeclaration('plain', null, t.span);
      if (this.peek(1).type === 'op' && ASSIGN_OPS.has(this.peek(1).value)) {
        const nameTok = this.next();
        const op = this.next().value;
        const value = this.parseValue();
        const stmt: Stmt = { kind: 'assign', name: nameTok.value, op, value, span: spanBetween(nameTok.span, value.span), nameSpan: nameTok.span };
        this.endStatement();
        return stmt;
      }
    }

    if (t.type === 'kw' && (t.value === 'var' || t.value === 'varip')) {
      this.next();
      const type = this.typePrefixLength() > 0 ? this.parseTypeRef() : null;
      return this.parseDeclaration(t.value, type, t.span);
    }

    if (this.isOp('[')) {
      const after = this.matchBracket(this.pos);
      if (after > 0 && this.tokens[after]?.type === 'op' && (this.tokens[after].value === '=' || this.tokens[after].value === ':=')) {
        return this.parseTupleDeclaration();
      }
    }

    const expr = this.parseValue();
    this.endStatement();
    return { kind: 'expr', expr, span: expr.span };
  }

  private parseDeclaration(mode: 'plain' | 'var' | 'varip', type: TypeRef | null, start: Span): Stmt {
    const nameTok = this.expectIdent('a variable name');
    if (this.isOp(':=')) this.fail(`Use '=' to declare '${nameTok.value}'; ':=' changes a variable that already exists`);
    this.expectOp('=', `after '${nameTok.value}'`);
    const value = this.parseValue();
    const stmt: Stmt = { kind: 'decl', name: nameTok.value, mode, type, value, span: spanBetween(start, value.span), nameSpan: nameTok.span };
    this.endStatement();
    return stmt;
  }

  private parseTupleDeclaration(): Stmt {
    const open = this.expectOp('[');
    const names: Array<{ name: string; span: Span }> = [];
    do {
      const tok = this.expectIdent('a variable name');
      names.push({ name: tok.value, span: tok.span });
    } while (this.isOp(',') && this.next());
    this.expectOp(']');
    if (this.isOp(':=')) this.fail('Tuples can only be declared with =, not reassigned');
    this.expectOp('=');
    const value = this.parseValue();
    this.endStatement();
    return { kind: 'tupledecl', names, value, span: spanBetween(open.span, value.span) };
  }

  private parseFunction(isMethod: boolean): Stmt {
    const nameTok = this.expectIdent('a function name');
    this.expectOp('(');
    const params: Param[] = [];
    while (!this.isOp(')')) {
      const start = this.peek().span;
      let type: TypeRef | null = null;
      // `float x`, `series int len`, `float[] values`
      if (this.isIdent() && (this.peek(1).type === 'ident' || this.isOp('[', 1) || this.isOp('<', 1)) && !this.isOp('=', 1)) {
        type = this.parseTypeRef();
      }
      const p = this.expectIdent('a parameter name');
      let defaultValue: Expr | null = null;
      if (this.isOp('=')) {
        this.next();
        defaultValue = this.parseExpression();
      }
      params.push({ name: p.value, type, defaultValue, span: spanBetween(start, p.span) });
      if (!this.isOp(',')) break;
      this.next();
    }
    this.expectOp(')', 'to close the parameter list');
    const arrow = this.expectOp('=>');
    let body: Stmt[];
    if (this.peek().type === 'newline') {
      body = this.parseBlock();
    } else {
      const expr = this.parseValue();
      body = [{ kind: 'expr', expr, span: expr.span }];
      this.endStatement();
    }
    if (isMethod && params.length === 0) this.fail('A method needs at least one parameter', nameTok);
    return { kind: 'func', name: nameTok.value, params, body, isMethod, span: spanBetween(nameTok.span, arrow.span) };
  }

  // ------------------------------------------------------------ structured expressions

  /** An expression, or an if/switch/for/while used as a value. */
  private parseValue(): Expr {
    const t = this.peek();
    if (t.type === 'kw') {
      if (t.value === 'if') return this.parseIf();
      if (t.value === 'switch') return this.parseSwitch();
      if (t.value === 'for') return this.parseFor();
      if (t.value === 'while') return this.parseWhile();
    }
    return this.parseExpression();
  }

  private parseIf(): Expr {
    const start = this.next();
    const cond = this.parseExpression();
    const then = this.parseBlock();
    let otherwise: Stmt[] | null = null;
    if (this.isKw('else')) {
      this.next();
      if (this.isKw('if')) {
        const nested = this.parseIf();
        otherwise = [{ kind: 'expr', expr: nested, span: nested.span }];
      } else {
        otherwise = this.parseBlock();
      }
    }
    return { kind: 'if', cond, then, else: otherwise, span: spanBetween(start.span, cond.span) };
  }

  private parseSwitch(): Expr {
    const start = this.next();
    const subject = this.peek().type === 'newline' ? null : this.parseExpression();
    if (this.peek().type !== 'newline') this.fail('Expected a new line after switch');
    this.next();
    if (this.peek().type !== 'indent') this.fail('Expected indented cases after switch');
    this.next();
    const cases: SwitchCase[] = [];
    while (this.peek().type !== 'dedent' && this.peek().type !== 'eof') {
      if (this.peek().type === 'newline') {
        this.next();
        continue;
      }
      const caseStart = this.peek().span;
      let match: Expr | null = null;
      if (!this.isOp('=>')) match = this.parseExpression();
      this.expectOp('=>', 'after the switch case');
      let body: Stmt[];
      if (this.peek().type === 'newline') {
        body = this.parseBlock();
      } else {
        body = [this.parseInlineStatement()];
      }
      cases.push({ match, body, span: caseStart });
    }
    if (this.peek().type === 'dedent') this.next();
    if (cases.length === 0) this.fail('A switch needs at least one case', start);
    return { kind: 'switch', subject, cases, span: subject ? spanBetween(start.span, subject.span) : start.span };
  }

  /** A single statement after `=>` in a switch case: an expression or a reassignment. */
  private parseInlineStatement(): Stmt {
    const t = this.peek();
    if (t.type === 'ident' && this.peek(1).type === 'op' && ASSIGN_OPS.has(this.peek(1).value)) {
      this.next();
      const op = this.next().value;
      const value = this.parseValue();
      this.endStatement();
      return { kind: 'assign', name: t.value, op, value, span: spanBetween(t.span, value.span), nameSpan: t.span };
    }
    if (t.type === 'kw' && (t.value === 'break' || t.value === 'continue')) {
      this.next();
      this.endStatement();
      return { kind: t.value, span: t.span };
    }
    const expr = this.parseValue();
    this.endStatement();
    return { kind: 'expr', expr, span: expr.span };
  }

  private parseFor(): Expr {
    const start = this.next();
    if (this.isOp('[')) {
      this.next();
      const a = this.expectIdent('an index variable');
      this.expectOp(',');
      const b = this.expectIdent('a value variable');
      this.expectOp(']');
      if (!this.isIdent('in')) this.fail("Expected 'in'");
      this.next();
      const iterable = this.parseExpression();
      const body = this.parseBlock();
      return { kind: 'forin', indexName: a.value, varName: b.value, varSpan: b.span, iterable, body, span: spanBetween(start.span, iterable.span) };
    }
    const v = this.expectIdent('a loop variable');
    if (this.isIdent('in')) {
      this.next();
      const iterable = this.parseExpression();
      const body = this.parseBlock();
      return { kind: 'forin', indexName: null, varName: v.value, varSpan: v.span, iterable, body, span: spanBetween(start.span, iterable.span) };
    }
    this.expectOp('=', 'in the for loop');
    const from = this.parseExpression();
    if (!this.isIdent('to')) this.fail(`Expected 'to' in the for loop but found ${this.describe(this.peek())}`);
    this.next();
    const to = this.parseExpression();
    let step: Expr | null = null;
    if (this.isIdent('by')) {
      this.next();
      step = this.parseExpression();
    }
    const body = this.parseBlock();
    return { kind: 'for', varName: v.value, varSpan: v.span, from, to, step, body, span: spanBetween(start.span, (step ?? to).span) };
  }

  private parseWhile(): Expr {
    const start = this.next();
    const cond = this.parseExpression();
    const body = this.parseBlock();
    return { kind: 'while', cond, body, span: spanBetween(start.span, cond.span) };
  }

  // ------------------------------------------------------------ plain expressions

  parseExpression(): Expr {
    return this.parseTernary();
  }

  private parseTernary(): Expr {
    const cond = this.parseBinary(0);
    if (!this.isOp('?')) return cond;
    this.next();
    const then = this.parseTernary();
    this.expectOp(':', 'in the ?: expression');
    const otherwise = this.parseTernary();
    return { kind: 'ternary', cond, then, else: otherwise, span: spanBetween(cond.span, otherwise.span) };
  }

  private parseBinary(level: number): Expr {
    if (level >= BINARY_LEVELS.length) return this.parseUnary();
    const { ops, kw } = BINARY_LEVELS[level];
    let left = this.parseBinary(level + 1);
    for (;;) {
      const t = this.peek();
      const matches = kw ? t.type === 'kw' && ops.includes(t.value) : t.type === 'op' && ops.includes(t.value);
      if (!matches) return left;
      this.next();
      const right = this.parseBinary(level + 1);
      left = { kind: 'binary', op: t.value, left, right, span: spanBetween(left.span, right.span) };
    }
  }

  private parseUnary(): Expr {
    const t = this.peek();
    if ((t.type === 'op' && (t.value === '-' || t.value === '+')) || (t.type === 'kw' && t.value === 'not')) {
      this.next();
      const operand = this.parseUnary();
      return { kind: 'unary', op: t.value, operand, span: spanBetween(t.span, operand.span) };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let expr = this.parsePrimary();
    for (;;) {
      if (this.isOp('.')) {
        this.next();
        const name = this.expectIdent('a name after "."');
        expr = { kind: 'member', object: expr, name: name.value, span: spanBetween(expr.span, name.span) };
        continue;
      }
      if (this.isOp('<') && expr.kind === 'member' && this.peek(1).type === 'ident' && this.isOp('>', 2) && this.isOp('(', 3)) {
        this.next();
        const generic = this.next().value;
        this.next();
        expr = this.parseCall(expr, generic);
        continue;
      }
      if (this.isOp('(')) {
        expr = this.parseCall(expr);
        continue;
      }
      if (this.isOp('[')) {
        this.next();
        const index = this.parseExpression();
        const close = this.expectOp(']', 'to close the history reference');
        expr = { kind: 'index', object: expr, index, span: spanBetween(expr.span, close.span) };
        continue;
      }
      return expr;
    }
  }

  private parseCall(callee: Expr, generic?: string): Expr {
    this.expectOp('(');
    const args: Arg[] = [];
    let named = false;
    while (!this.isOp(')')) {
      const start = this.peek();
      if (start.type === 'ident' && this.isOp('=', 1)) {
        this.next();
        this.next();
        const value = this.parseValue();
        args.push({ name: start.value, value, span: spanBetween(start.span, value.span) });
        named = true;
      } else {
        if (named) this.fail('Positional arguments must come before named ones');
        const value = this.parseValue();
        args.push({ name: null, value, span: value.span });
      }
      if (!this.isOp(',')) break;
      this.next();
    }
    const close = this.expectOp(')', 'to close the argument list');
    const call: Expr = { kind: 'call', callee, args, span: spanBetween(callee.span, close.span) };
    if (generic) call.generic = generic;
    return call;
  }

  private parsePrimary(): Expr {
    const t = this.peek();
    switch (t.type) {
      case 'num':
        this.next();
        return { kind: 'num', value: t.num as number, isInt: !!t.isInt, span: t.span };
      case 'str':
        this.next();
        return { kind: 'str', value: t.value, span: t.span };
      case 'color':
        this.next();
        return { kind: 'color', hex: t.value, span: t.span };
      case 'ident':
        this.next();
        return { kind: 'ident', name: t.value, span: t.span };
      case 'kw':
        if (t.value === 'true' || t.value === 'false') {
          this.next();
          return { kind: 'bool', value: t.value === 'true', span: t.span };
        }
        if (t.value === 'na') {
          this.next();
          return { kind: 'na', span: t.span };
        }
        if (t.value === 'if' || t.value === 'switch') return this.parseValue();
        break;
      case 'op':
        if (t.value === '(') {
          this.next();
          const inner = this.parseValue();
          this.expectOp(')', 'to close the parenthesis');
          return inner;
        }
        if (t.value === '[') {
          this.next();
          const items: Expr[] = [];
          while (!this.isOp(']')) {
            items.push(this.parseExpression());
            if (!this.isOp(',')) break;
            this.next();
          }
          const close = this.expectOp(']');
          return { kind: 'tuple', items, span: spanBetween(t.span, close.span) };
        }
        break;
    }
    this.fail(`Unexpected ${this.describe(t)}`);
  }
}

export function parse(source: string): Program {
  const tokens = tokenize(source);
  const parser = new Parser(tokens);
  return { version: readVersion(source), body: parser.parseProgram() };
}

/** Parses a lone expression, for tests and tooling. */
export function parseExpression(source: string): Expr {
  const tokens = tokenize(source);
  const parser = new Parser(tokens);
  return parser.parseExpression();
}
