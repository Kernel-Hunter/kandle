import type { Span } from './errors';

export type Expr =
  | { kind: 'num'; value: number; isInt: boolean; span: Span }
  | { kind: 'str'; value: string; span: Span }
  | { kind: 'bool'; value: boolean; span: Span }
  | { kind: 'color'; hex: string; span: Span }
  | { kind: 'na'; span: Span }
  | { kind: 'ident'; name: string; span: Span }
  | { kind: 'member'; object: Expr; name: string; span: Span }
  | { kind: 'call'; callee: Expr; args: Arg[]; generic?: string; span: Span }
  | { kind: 'index'; object: Expr; index: Expr; span: Span }
  | { kind: 'unary'; op: string; operand: Expr; span: Span }
  | { kind: 'binary'; op: string; left: Expr; right: Expr; span: Span }
  | { kind: 'ternary'; cond: Expr; then: Expr; else: Expr; span: Span }
  | { kind: 'tuple'; items: Expr[]; span: Span }
  | { kind: 'if'; cond: Expr; then: Stmt[]; else: Stmt[] | null; span: Span }
  | { kind: 'switch'; subject: Expr | null; cases: SwitchCase[]; span: Span }
  | { kind: 'for'; varName: string; varSpan: Span; from: Expr; to: Expr; step: Expr | null; body: Stmt[]; span: Span }
  | { kind: 'forin'; indexName: string | null; varName: string; varSpan: Span; iterable: Expr; body: Stmt[]; span: Span }
  | { kind: 'while'; cond: Expr; body: Stmt[]; span: Span };

export interface Arg {
  name: string | null;
  value: Expr;
  span: Span;
}

export interface SwitchCase {
  /** null for the default case. */
  match: Expr | null;
  body: Stmt[];
  span: Span;
}

export interface TypeRef {
  name: string;
  /** `float[]` or `array<float>`. */
  isArray: boolean;
}

export interface Param {
  name: string;
  type: TypeRef | null;
  defaultValue: Expr | null;
  span: Span;
}

export type Stmt =
  | { kind: 'decl'; name: string; mode: 'plain' | 'var' | 'varip'; type: TypeRef | null; value: Expr; span: Span; nameSpan: Span }
  | { kind: 'tupledecl'; names: Array<{ name: string; span: Span }>; value: Expr; span: Span }
  | { kind: 'assign'; name: string; op: string; value: Expr; span: Span; nameSpan: Span }
  | { kind: 'expr'; expr: Expr; span: Span }
  | { kind: 'func'; name: string; params: Param[]; body: Stmt[]; isMethod: boolean; span: Span }
  | { kind: 'break'; span: Span }
  | { kind: 'continue'; span: Span };

export interface Program {
  version: number | null;
  body: Stmt[];
}
