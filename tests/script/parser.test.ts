import { describe, expect, it } from 'vitest';
import { parse, parseExpression } from '../../src/script/parser';
import { tokenize } from '../../src/script/lexer';
import { compileScript } from '../../src/script/engine';
import type { Expr, Stmt } from '../../src/script/ast';

/** Compact text form of an expression, for readable assertions. */
function show(e: Expr): string {
  switch (e.kind) {
    case 'num':
      return String(e.value);
    case 'str':
      return JSON.stringify(e.value);
    case 'bool':
      return String(e.value);
    case 'na':
      return 'na';
    case 'color':
      return `#${e.hex}`;
    case 'ident':
      return e.name;
    case 'member':
      return `${show(e.object)}.${e.name}`;
    case 'call':
      return `${show(e.callee)}${e.generic ? `<${e.generic}>` : ''}(${e.args.map((a) => (a.name ? `${a.name}=` : '') + show(a.value)).join(', ')})`;
    case 'index':
      return `${show(e.object)}[${show(e.index)}]`;
    case 'unary':
      return `(${e.op} ${show(e.operand)})`;
    case 'binary':
      return `(${show(e.left)} ${e.op} ${show(e.right)})`;
    case 'ternary':
      return `(${show(e.cond)} ? ${show(e.then)} : ${show(e.else)})`;
    case 'tuple':
      return `[${e.items.map(show).join(', ')}]`;
    default:
      return e.kind;
  }
}

const body = (src: string): Stmt[] => parse(src).body;

function errorOf(src: string): string {
  const r = compileScript(src);
  if (r.ok) throw new Error('expected an error');
  return r.error.format();
}

describe('lexer', () => {
  it('reads numbers, strings, colors and operators', () => {
    const toks = tokenize(`x := 1.5e2 + .5 - 3 // comment\ny = 'a\\'b' + "c"\nz = #ff000080 != #00FF00`);
    const vals = toks.filter((t) => t.type !== 'newline' && t.type !== 'eof').map((t) => `${t.type}:${t.value}`);
    expect(vals).toEqual([
      'ident:x', 'op::=', 'num:1.5e2', 'op:+', 'num:.5', 'op:-', 'num:3',
      'ident:y', 'op:=', "str:a'b", 'op:+', 'str:c',
      'ident:z', 'op:=', 'color:ff000080', 'op:!=', 'color:00FF00',
    ]);
    expect(toks.find((t) => t.value === '3')?.isInt).toBe(true);
    expect(toks.find((t) => t.value === '.5')?.isInt).toBe(false);
  });

  it('emits indent and dedent for blocks', () => {
    const types = tokenize('if a\n    b\n    if c\n        d\ne').map((t) => t.type);
    expect(types.filter((t) => t === 'indent').length).toBe(2);
    expect(types.filter((t) => t === 'dedent').length).toBe(2);
  });
});

describe('parser', () => {
  it('accepts the version header and comments', () => {
    const p = parse('//@version=5\n// a comment\nindicator("x")\n');
    expect(p.version).toBe(5);
    expect(parse('//@version=6\nx = 1').version).toBe(6);
    expect(p.body).toHaveLength(1);
  });

  it('respects operator precedence and associativity', () => {
    expect(show(parseExpression('1 + 2 * 3 - 4 / 2'))).toBe('((1 + (2 * 3)) - (4 / 2))');
    expect(show(parseExpression('a or b and not c'))).toBe('(a or (b and (not c)))');
    expect(show(parseExpression('a > b == c < d'))).toBe('((a > b) == (c < d))');
    expect(show(parseExpression('a ? b : c ? d : e'))).toBe('(a ? b : (c ? d : e))');
    expect(show(parseExpression('-close[1] % 3'))).toBe('((- close[1]) % 3)');
  });

  it('parses calls, named arguments, namespaces, history and generics', () => {
    expect(show(parseExpression('ta.sma(source = close, length = 14)[2]'))).toBe('ta.sma(source=close, length=14)[2]');
    expect(show(parseExpression('array.new<float>(3, 0.0)'))).toBe('array.new<float>(3, 0)');
    expect(show(parseExpression('arr.push(close)'))).toBe('arr.push(close)');
    expect(show(parseExpression('color.new(#2196F3, 50)'))).toBe('color.new(#2196F3, 50)');
  });

  it('parses declarations, var, types, reassignment and tuples', () => {
    const s = body(`a = 1
var float b = na
varip int c = 0
series float d = close
b := 2
c += 1
[m, s, h] = ta.macd(close, 12, 26, 9)
float[] xs = array.new_float()`);
    expect(s.map((x) => x.kind)).toEqual(['decl', 'decl', 'decl', 'decl', 'assign', 'assign', 'tupledecl', 'decl']);
    expect(s[1]).toMatchObject({ kind: 'decl', name: 'b', mode: 'var', type: { name: 'float' } });
    expect(s[2]).toMatchObject({ mode: 'varip', type: { name: 'int' } });
    expect(s[5]).toMatchObject({ kind: 'assign', op: '+=' });
    expect(s[6]).toMatchObject({ kind: 'tupledecl', names: [{ name: 'm' }, { name: 's' }, { name: 'h' }] });
    expect(s[7]).toMatchObject({ type: { name: 'float', isArray: true } });
  });

  it('parses if / else if / else, including as an expression', () => {
    const [stmt, decl] = body(`if close > open
    a := 1
else if close < open
    a := 2
else
    a := 3
x = if a == 1
    10
else
    20`);
    expect(stmt.kind).toBe('expr');
    const ifExpr = (stmt as Extract<Stmt, { kind: 'expr' }>).expr as Extract<Expr, { kind: 'if' }>;
    expect(ifExpr.kind).toBe('if');
    expect(ifExpr.else?.[0]).toMatchObject({ kind: 'expr', expr: { kind: 'if' } });
    expect(decl).toMatchObject({ kind: 'decl', name: 'x', value: { kind: 'if' } });
  });

  it('parses loops', () => {
    const s = body(`for i = 0 to 10 by 2
    x += i
for i = 10 to 0
    break
for v in arr
    continue
for [i, v] in arr
    x += v
while x < 10
    x += 1`);
    expect(s.map((x) => (x as Extract<Stmt, { kind: 'expr' }>).expr.kind)).toEqual(['for', 'for', 'forin', 'forin', 'while']);
    expect((s[0] as Extract<Stmt, { kind: 'expr' }>).expr).toMatchObject({ kind: 'for', varName: 'i', step: { kind: 'num', value: 2 } });
    expect((s[3] as Extract<Stmt, { kind: 'expr' }>).expr).toMatchObject({ kind: 'forin', indexName: 'i', varName: 'v' });
  });

  it('parses both switch forms', () => {
    const s = body(`m = switch mode
    "a" => 1
    "b" =>
        y = 2
        y * 2
    => 0
switch
    close > open => up := true
    => up := false`);
    const sw = (s[0] as Extract<Stmt, { kind: 'decl' }>).value as Extract<Expr, { kind: 'switch' }>;
    expect(sw.kind).toBe('switch');
    expect(sw.subject).toMatchObject({ kind: 'ident', name: 'mode' });
    expect(sw.cases.map((c) => c.match === null)).toEqual([false, false, true]);
    expect(sw.cases[1].body).toHaveLength(2);
    const sw2 = (s[1] as Extract<Stmt, { kind: 'expr' }>).expr as Extract<Expr, { kind: 'switch' }>;
    expect(sw2.subject).toBeNull();
    expect(sw2.cases[0].body[0]).toMatchObject({ kind: 'assign', name: 'up' });
  });

  it('parses single-line and multi-line functions and methods', () => {
    const s = body(`double(x) => x * 2
avg(a, b = 2) =>
    s = a + b
    s / 2
method scale(float x, float k) => x * k`);
    expect(s[0]).toMatchObject({ kind: 'func', name: 'double', params: [{ name: 'x' }] });
    expect(s[1]).toMatchObject({ kind: 'func', name: 'avg', params: [{ name: 'a' }, { name: 'b', defaultValue: { kind: 'num' } }] });
    expect((s[1] as Extract<Stmt, { kind: 'func' }>).body).toHaveLength(2);
    expect(s[2]).toMatchObject({ kind: 'func', isMethod: true, params: [{ name: 'x', type: { name: 'float' } }, { name: 'k' }] });
  });

  it('joins wrapped lines inside brackets and after operators', () => {
    const s = body(`plot(close,
     title = "c",
         color = color.red)
x = 1 +
  2
y = close
   + open`);
    expect(s).toHaveLength(3);
    expect(show((s[1] as Extract<Stmt, { kind: 'decl' }>).value)).toBe('(1 + 2)');
    expect(show((s[2] as Extract<Stmt, { kind: 'decl' }>).value)).toBe('(close + open)');
  });

  it('tracks positions for every node', () => {
    const s = body('a = 1\n  // note\nb = ta.sma(close, 3)');
    const decl = s[1] as Extract<Stmt, { kind: 'decl' }>;
    expect(decl.nameSpan).toMatchObject({ line: 3, col: 1 });
    expect(decl.value.span).toMatchObject({ line: 3, col: 5 });
  });
});

describe('error messages carry line:column', () => {
  it('reports syntax errors', () => {
    expect(errorOf('x = "abc')).toBe('1:5 Unterminated string');
    expect(errorOf('a = 1\n    b = 2')).toBe('2:5 Unexpected indentation');
    expect(errorOf('x = (1 + 2')).toMatch(/^1:11 Expected '\)'/);
    expect(errorOf('if close > open\nx = 1')).toMatch(/^1:\d+ Expected an indented block/);
    expect(errorOf('x = 1 +* 2')).toBe("1:8 Unexpected '*'");
    expect(errorOf('a = #12345')).toMatch(/^1:5 Colors are written/);
    expect(errorOf('x = 1\nx := 2\ny := 3')).toBe("3:1 'y' is not declared yet; use = to declare it");
    expect(errorOf('a = 1\na = 2')).toBe("2:1 'a' is already declared in this scope; use := to change it");
  });

  it('reports unknown and unsupported names clearly', () => {
    expect(errorOf('x = foo(1)')).toBe("1:5 Unknown function 'foo' (it may not be supported yet)");
    expect(errorOf('x = request.security_lower_tf(syminfo.tickerid, "1", close)')).toBe("1:5 'request.security_lower_tf' is not supported yet");
    expect(errorOf('x = ta.alma(close, 9, 0.85, 6)')).toBe("1:5 'ta.alma' is not supported yet");
    expect(errorOf('strategy("s")\nstrategy.convert_to_account(1)')).toBe("2:1 'strategy.convert_to_account' is not supported yet");
    expect(errorOf('label.new(bar_index, high, "x")')).toBe("1:1 'label.new' is not supported yet");
    expect(errorOf('x = y + 1')).toBe("1:5 Unknown variable 'y'");
    expect(errorOf('import foo/bar/1')).toMatch(/'import' is not supported yet/);
  });

  it('reports argument problems', () => {
    expect(errorOf('x = ta.sma(close)')).toBe("1:5 'ta.sma' needs the 'length' argument");
    expect(errorOf('x = ta.sma(close, 10, 3)')).toBe("1:23 'ta.sma' takes at most 2 arguments");
    expect(errorOf('x = ta.sma(close, len = 3)')).toBe("1:19 'ta.sma' has no parameter named 'len'");
    expect(errorOf('x = ta.sma(close, length = 3, 4)')).toMatch(/Positional arguments must come before named ones/);
  });

  it('reports scope rules', () => {
    expect(errorOf('if close > open\n    plot(close)')).toMatch(/^2:5 plot\(\) can only be used at the top level/);
    expect(errorOf('g = 1\nf() =>\n    g := 2\n    g')).toBe("3:5 Cannot change the global variable 'g' inside a function");
    expect(errorOf('x = 1\nbreak')).toBe("2:1 'break' can only be used inside a loop");
    expect(errorOf('f(x) => f(x - 1)')).toMatch(/recursion is not supported/);
    expect(errorOf('n = 5\nx = input.int(n, "len")')).toBe('2:15 An input default must be a constant value');
  });
});
