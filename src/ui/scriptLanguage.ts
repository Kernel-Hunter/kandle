/** CodeMirror support for Kandle Script: highlighting, completion and theme. */
import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { HighlightStyle, StreamLanguage, syntaxHighlighting, indentUnit } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { CONSTANTS, FUNCTIONS, VARIABLES } from '../script/builtins/registry';
import { KEYWORDS } from '../script/lexer';
import '../script/compiler';

const NAMESPACES = new Set(['ta', 'math', 'str', 'color', 'array', 'input', 'timeframe', 'syminfo', 'barstate', 'plot', 'shape', 'location', 'size', 'hline', 'display', 'format', 'order', 'request', 'barmerge']);
const OUTPUT_FUNCTIONS = ['indicator', 'plot', 'plotshape', 'plotchar', 'hline', 'fill', 'bgcolor', 'barcolor', 'input', 'input.int', 'input.float', 'input.bool', 'input.string', 'input.source', 'input.color', 'input.price', 'input.timeframe', 'input.text_area', 'request.security'];
const CONTEXTUAL = ['to', 'by', 'in', 'method'];

const builtinVariables = new Set([...VARIABLES.keys()].filter((k) => !k.includes('.')));

export const scriptLanguage = StreamLanguage.define<{ afterDot: boolean }>({
  name: 'kandle-script',
  startState: () => ({ afterDot: false }),
  token(stream, state) {
    if (stream.eatSpace()) return null;
    if (stream.match('//')) {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.match(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?\b/)) return 'color';
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/) || stream.match(/^'(?:[^'\\]|\\.)*'?/)) return 'string';
    if (stream.match(/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/)) return 'number';
    if (stream.match(/^[A-Za-z_]\w*/)) {
      const word = stream.current();
      const afterDot = state.afterDot;
      state.afterDot = false;
      if (!afterDot) {
        if (word === 'true' || word === 'false' || word === 'na') return 'atom';
        if (KEYWORDS.has(word) || CONTEXTUAL.includes(word)) return 'keyword';
        if (NAMESPACES.has(word) && stream.peek() === '.') return 'ns';
        if (builtinVariables.has(word)) return 'builtin';
      }
      if (stream.match(/^\s*\(/, false)) return 'fn';
      return afterDot ? 'property' : 'variableName';
    }
    if (stream.eat('.')) {
      state.afterDot = true;
      return 'punctuation';
    }
    state.afterDot = false;
    if (stream.match(/^(?::=|=>|==|!=|<=|>=|\+=|-=|\*=|\/=|%=|[-+*/%<>=?:])/)) return 'operator';
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: '//' } },
  tokenTable: {
    color: tags.color,
    ns: tags.namespace,
    builtin: tags.standard(tags.variableName),
    fn: tags.function(tags.variableName),
    property: tags.propertyName,
  },
});

const highlight = HighlightStyle.define([
  { tag: tags.comment, color: 'var(--cm-comment)', fontStyle: 'italic' },
  { tag: tags.keyword, color: 'var(--cm-keyword)' },
  { tag: [tags.atom, tags.bool], color: 'var(--cm-atom)' },
  { tag: tags.number, color: 'var(--cm-number)' },
  { tag: tags.string, color: 'var(--cm-string)' },
  { tag: tags.color, color: 'var(--cm-number)' },
  { tag: tags.namespace, color: 'var(--cm-namespace)' },
  { tag: tags.standard(tags.variableName), color: 'var(--cm-builtin)' },
  { tag: tags.function(tags.variableName), color: 'var(--cm-function)' },
  { tag: tags.propertyName, color: 'var(--cm-function)' },
  { tag: tags.operator, color: 'var(--cm-operator)' },
]);

const completionWords: string[] = [
  ...new Set([...FUNCTIONS.keys(), ...VARIABLES.keys(), ...CONSTANTS.keys(), ...OUTPUT_FUNCTIONS, ...KEYWORDS, ...CONTEXTUAL]),
].sort();

function complete(context: CompletionContext): CompletionResult | null {
  const word = context.matchBefore(/[\w.]+/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  const prefix = word.text;
  const options = completionWords
    .filter((w) => w.startsWith(prefix) && w !== prefix)
    .slice(0, 200)
    .map((w) => ({
      label: w,
      type: FUNCTIONS.has(w) || OUTPUT_FUNCTIONS.includes(w) ? 'function' : KEYWORDS.has(w) ? 'keyword' : CONSTANTS.has(w) ? 'constant' : 'variable',
    }));
  return { from: word.from, options, validFor: /^[\w.]*$/ };
}

export const editorTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: 'var(--bg)', color: 'var(--text)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.55' },
  '.cm-content': { caretColor: 'var(--text)' },
  '.cm-gutters': { backgroundColor: 'var(--panel)', color: 'var(--muted)', borderRight: '1px solid var(--border)' },
  '.cm-activeLine': { backgroundColor: 'var(--accent-soft)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--accent-soft)' },
  '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--text)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'rgba(47, 128, 237, 0.3) !important' },
  '.cm-tooltip': { backgroundColor: 'var(--panel-2)', border: '1px solid var(--border)', color: 'var(--text)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent)', color: '#fff' },
  '.cm-diagnostic-error': { borderLeft: '3px solid var(--down)' },
});

export function scriptLanguageSupport() {
  return [scriptLanguage, syntaxHighlighting(highlight), autocompletion({ override: [complete] }), indentUnit.of('    ')];
}
