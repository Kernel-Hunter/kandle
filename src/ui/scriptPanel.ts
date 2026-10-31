/**
 * The script editor, docked under the chart. Loaded on first use so CodeMirror stays out
 * of the initial bundle.
 */
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { linter, lintGutter, setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { EditorState } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
import { compileScript } from '../script/engine';
import { EXAMPLES, NEW_SCRIPT } from '../script/examples';
import type { RunScriptResult, ScriptErrorInfo, ScriptManager } from '../script/manager';
import type { KeyValueStorage } from '../store/layout';
import { APP } from '../config';
import { h, ICONS } from './dom';
import { editorTheme, scriptLanguageSupport } from './scriptLanguage';
import { createStrategyView, formatMoney } from './strategyView';
import './scriptPanel.css';

export interface ScriptPanelOptions {
  manager: ScriptManager;
  storage: KeyValueStorage;
  toast: (message: string, kind?: 'info' | 'error') => void;
  onVisibilityChange?: (open: boolean) => void;
  /** Scrolls the chart to a time (clicking a trade in the Strategy tab). */
  onShowTime?: (time: number) => void;
}

export interface ScriptPanel {
  root: HTMLElement;
  open(scriptId?: string): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  /** The editor view, for tests and automation. */
  view: EditorView;
  run(): RunScriptResult;
  /** Opens the panel on the Strategy tab, showing the strategy with `id` if given. */
  showStrategy(id?: string): void;
  /** Writes the draft now instead of a moment after the last edit (before a reload). */
  saveDraft(): void;
}

type PanelTab = 'editor' | 'strategy';

const NEW_TARGET = '';

interface Draft {
  source: string;
  target: string;
  height?: number;
  tab?: PanelTab;
}

function toDiagnostic(doc: EditorState['doc'], e: ScriptErrorInfo): Diagnostic {
  const len = doc.length;
  let from = Math.min(Math.max(0, e.from), len);
  let to = Math.min(Math.max(from, e.to), len);
  if (to === from) {
    // Underline at least one character, or the end of the line for "expected ..." errors.
    const line = doc.lineAt(from);
    if (from < line.to) to = from + 1;
    else if (from > line.from) from -= 1;
  }
  const where = e.bar === undefined ? '' : ` (bar ${e.bar})`;
  return { from, to, severity: 'error', message: `${e.message}${where}`, source: 'Kandle Script' };
}

export function createScriptPanel(opts: ScriptPanelOptions): ScriptPanel {
  const { manager, storage } = opts;
  const draftKey = `${APP.id}:script-draft`;

  const loadDraft = (): Draft => {
    try {
      const raw = storage.getItem(draftKey);
      const d = raw ? (JSON.parse(raw) as Partial<Draft>) : null;
      if (d && typeof d.source === 'string') {
        return {
          source: d.source,
          target: typeof d.target === 'string' ? d.target : NEW_TARGET,
          height: typeof d.height === 'number' ? d.height : undefined,
          tab: d.tab === 'strategy' ? 'strategy' : 'editor',
        };
      }
    } catch {
      // ignore broken drafts
    }
    return { source: NEW_SCRIPT, target: NEW_TARGET };
  };

  const draft = loadDraft();
  let target = manager.get(draft.target) ? draft.target : NEW_TARGET;
  let height = Math.min(Math.max(draft.height ?? 300, 140), 900);
  let tab: PanelTab = draft.tab ?? 'editor';
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  const writeDraft = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    try {
      storage.setItem(draftKey, JSON.stringify({ source: view.state.doc.toString(), target, height, tab }));
    } catch {
      // storage full or blocked; the draft is a convenience only
    }
  };
  const saveDraft = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(writeDraft, 300);
  };

  // ------------------------------------------------------------------ DOM

  const targetSelect = h('select', { class: 'sp-select', 'aria-label': 'Script to edit', title: 'Script to edit' }) as HTMLSelectElement;
  const examples = h('select', { class: 'sp-select', 'aria-label': 'Examples', title: 'Load an example script' }) as HTMLSelectElement;
  const exampleGroup = (label: string, strategies: boolean) =>
    h(
      'optgroup',
      { label },
      ...EXAMPLES.flatMap((ex, i) => (/^strategy\(/m.test(ex.source) === strategies ? [h('option', { value: String(i) }, ex.name)] : [])),
    );
  examples.append(h('option', { value: '' }, 'Examples'), exampleGroup('Indicators', false), exampleGroup('Strategies', true));
  const status = h('span', { class: 'sp-status muted', 'aria-live': 'polite' });
  const runBtn = h('button', { class: 'btn btn-primary sp-run', title: 'Add to chart (Ctrl+Enter or Cmd+Enter)' }) as HTMLButtonElement;
  const newBtn = h('button', { class: 'btn sp-new', title: 'Start a new script' }, 'New');
  const closeBtn = h('button', { class: 'icon-btn', title: 'Close editor (Alt+S)', 'aria-label': 'Close editor', html: ICONS.close });
  const message = h('div', { class: 'sp-message', role: 'status' });
  const editorHost = h('div', { class: 'sp-editor' });
  const resize = h('div', { class: 'sp-resize', title: 'Drag to resize', role: 'separator', 'aria-orientation': 'horizontal' });
  const editorTab = h('button', { class: 'sp-tab', type: 'button', role: 'tab' }, 'Editor');
  const strategyTab = h('button', { class: 'sp-tab', type: 'button', role: 'tab' }, 'Strategy');
  const strategy = createStrategyView({ manager, onShowTime: opts.onShowTime });
  const editorTools = h('div', { class: 'sp-tools' }, targetSelect, examples, newBtn, h('span', { class: 'spacer' }), status, runBtn);
  const strategyTools = h('div', { class: 'sp-tools' }, strategy.tools);
  const editorPane = h('div', { class: 'sp-pane' }, editorHost, message);
  const strategyPane = h('div', { class: 'sp-pane' }, strategy.root);

  const root = h(
    'section',
    { class: 'script-panel', hidden: true, 'aria-label': 'Script editor and strategy results' },
    resize,
    h('header', { class: 'sp-head' }, h('div', { class: 'sp-tabs', role: 'tablist' }, editorTab, strategyTab), editorTools, strategyTools, closeBtn),
    editorPane,
    strategyPane,
  );
  root.style.height = `${height}px`;

  const setTab = (next: PanelTab) => {
    tab = next;
    const onEditor = tab === 'editor';
    editorTab.classList.toggle('active', onEditor);
    strategyTab.classList.toggle('active', !onEditor);
    editorTab.setAttribute('aria-selected', String(onEditor));
    strategyTab.setAttribute('aria-selected', String(!onEditor));
    editorTools.hidden = !onEditor;
    editorPane.hidden = !onEditor;
    strategyTools.hidden = onEditor;
    strategyPane.hidden = onEditor;
    strategy.setVisible(!root.hidden && !onEditor);
    saveDraft();
  };

  const setMessage = (text: string, kind: 'error' | 'ok' | '' = '', action?: { label: string; run: () => void }) => {
    message.replaceChildren(text);
    if (action) message.append(' ', h('button', { class: 'sp-link', type: 'button', onclick: action.run }, action.label));
    message.className = `sp-message ${kind ? `sp-${kind}` : ''}`;
  };

  const refreshTargets = () => {
    const scripts = manager.list();
    if (target !== NEW_TARGET && !scripts.some((s) => s.id === target)) target = NEW_TARGET;
    targetSelect.replaceChildren(
      h('option', { value: NEW_TARGET, selected: target === NEW_TARGET }, 'New script'),
      ...scripts.map((s) => h('option', { value: s.id, selected: s.id === target }, `${s.shortTitle}${s.overlay ? '' : ' (pane)'}`)),
    );
    runBtn.textContent = target === NEW_TARGET ? 'Add to chart' : 'Update on chart';
  };

  // ------------------------------------------------------------------ editor

  const lint = linter(
    (v) => {
      const res = compileScript(v.state.doc.toString());
      if (res.ok) return [];
      return [toDiagnostic(v.state.doc, { message: res.error.message, line: res.error.line, col: res.error.col, from: res.error.from, to: res.error.to })];
    },
    { delay: 400 },
  );

  const view = new EditorView({
    parent: editorHost,
    state: EditorState.create({
      doc: draft.source,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        lintGutter(),
        lint,
        scriptLanguageSupport(),
        editorTheme,
        keymap.of([
          { key: 'Mod-Enter', run: () => (run(), true), preventDefault: true },
          { key: 'Mod-s', run: () => (run(), true), preventDefault: true },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) saveDraft();
        }),
        EditorState.tabSize.of(4),
      ],
    }),
  });

  const setSource = (source: string) => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: source }, selection: { anchor: 0 } });
    view.dispatch(setDiagnostics(view.state, []));
    setMessage('');
  };

  function run(): RunScriptResult {
    const source = view.state.doc.toString();
    const started = performance.now();
    const res = target === NEW_TARGET ? manager.add(source) : manager.update(target, source);
    if (!res.ok) {
      const detail = res.detail;
      view.dispatch(setDiagnostics(view.state, detail ? [toDiagnostic(view.state.doc, detail)] : []));
      setMessage(res.error ?? 'The script could not run', 'error');
      if (detail) {
        const pos = Math.min(detail.from, view.state.doc.length);
        view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      }
      status.textContent = '';
      return res;
    }
    target = res.id!;
    refreshTargets();
    saveDraft();
    view.dispatch(setDiagnostics(view.state, []));
    const info = manager.get(target);
    const ms = info?.lastRunMs ?? performance.now() - started;
    const report = manager.report(target);
    if (report) {
      const s = report.summary;
      const trades = `${s.totalClosedTrades} closed trade${s.totalClosedTrades === 1 ? '' : 's'}`;
      const id = target;
      setMessage(`${info?.title ?? 'Strategy'} is on the chart: ${trades}, net profit ${formatMoney(s.netProfit)} (${formatMoney(s.netProfitPercent)}%).`, 'ok', {
        label: 'Show results',
        run: () => panel.showStrategy(id),
      });
    } else {
      setMessage(`${info?.title ?? 'Script'} is on the chart.`, 'ok');
    }
    status.textContent = `${ms.toFixed(1)} ms`;
    return res;
  }

  // ------------------------------------------------------------------ events

  runBtn.addEventListener('click', () => run());
  editorTab.addEventListener('click', () => {
    setTab('editor');
    view.focus();
  });
  strategyTab.addEventListener('click', () => setTab('strategy'));
  closeBtn.addEventListener('click', () => panel.close());
  newBtn.addEventListener('click', () => {
    target = NEW_TARGET;
    refreshTargets();
    setSource(NEW_SCRIPT);
    saveDraft();
    view.focus();
  });
  targetSelect.addEventListener('change', () => {
    target = targetSelect.value;
    const info = manager.get(target);
    refreshTargets();
    if (info) setSource(info.source);
    saveDraft();
  });
  examples.addEventListener('change', () => {
    const ex = EXAMPLES[Number(examples.value)];
    examples.value = '';
    if (!ex) return;
    target = NEW_TARGET;
    refreshTargets();
    setSource(ex.source);
    setMessage(`Loaded "${ex.name}". Press Ctrl+Enter (Cmd+Enter on Mac) to add it to the chart.`);
    saveDraft();
    view.focus();
  });
  manager.onChange(() => {
    if (!root.hidden) refreshTargets();
  });

  resize.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = root.getBoundingClientRect().height;
    const move = (ev: PointerEvent) => {
      const max = Math.max(160, window.innerHeight - 160);
      height = Math.min(max, Math.max(120, startH + (startY - ev.clientY)));
      root.style.height = `${height}px`;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      saveDraft();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  const panel: ScriptPanel = {
    root,
    view,
    run,
    open(scriptId?: string) {
      if (scriptId) {
        const info = manager.get(scriptId);
        if (info) {
          target = scriptId;
          setSource(info.source);
          saveDraft();
        }
      }
      refreshTargets();
      root.hidden = false;
      setTab(tab);
      opts.onVisibilityChange?.(true);
      if (tab === 'editor') requestAnimationFrame(() => view.focus());
    },
    showStrategy(id?: string) {
      // The overview needs room for the figures, the equity curve and the stats table.
      if (height < 360) {
        height = Math.min(360, Math.max(160, window.innerHeight - 260));
        root.style.height = `${height}px`;
      }
      root.hidden = false;
      refreshTargets();
      setTab('strategy');
      strategy.select(id);
      opts.onVisibilityChange?.(true);
    },
    close() {
      if (root.contains(document.activeElement) && document.activeElement instanceof HTMLElement) document.activeElement.blur();
      root.hidden = true;
      strategy.setVisible(false);
      opts.onVisibilityChange?.(false);
    },
    toggle() {
      if (root.hidden) panel.open();
      else panel.close();
    },
    isOpen: () => !root.hidden,
    saveDraft: () => {
      if (saveTimer) writeDraft();
    },
  };
  refreshTargets();
  setTab(tab);
  return panel;
}
