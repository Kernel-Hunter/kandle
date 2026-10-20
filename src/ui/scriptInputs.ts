import { h, ICONS } from './dom';
import './scripts.css';
import { inputChoices, selectedChoice, validateInput, type InputDef, type InputValue } from '../script/engine';
import type { ScriptInfo, ScriptManager } from '../script/manager';

export interface ScriptRowsOptions {
  onEdit: (id: string) => void;
  rerender: () => void;
  /** Symbols of the chart's data source, suggested in symbol inputs. */
  symbols?: () => Promise<readonly string[]>;
}

export interface InputFieldOptions {
  symbols?: () => Promise<readonly string[]>;
}

/** Symbols suggested in one symbol field; the browser filters them as the user types. */
const MAX_SUGGESTIONS = 5000;
let listCounter = 0;

/** One editable field for a script input, matching the input's type. */
export function inputField(def: InputDef, value: InputValue, onChange: (v: InputValue) => void, opts: InputFieldOptions = {}): HTMLElement {
  const label = `${def.title}`;
  let control: HTMLElement;
  const choices = inputChoices(def);
  if (choices) {
    const el = h('select', { class: 'param-input', 'aria-label': label }) as HTMLSelectElement;
    const current = selectedChoice(def, choices, value);
    choices.forEach((c, i) => el.append(h('option', { value: String(i), selected: c === current }, c.label)));
    el.addEventListener('change', () => {
      const c = choices[Number(el.value)];
      if (c) onChange(c.value);
    });
    control = el;
  } else if (def.type === 'symbol') {
    const listId = `script-symbols-${listCounter++}`;
    const list = h('datalist', { id: listId }) as HTMLDataListElement;
    const el = h('input', {
      type: 'text',
      class: 'param-input',
      value: String(value),
      placeholder: 'Chart symbol',
      list: listId,
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-label': label,
    }) as HTMLInputElement;
    let known: readonly string[] = [];
    void opts
      .symbols?.()
      .then((symbols) => {
        known = symbols;
        list.append(...symbols.slice(0, MAX_SUGGESTIONS).map((s) => h('option', { value: s })));
      })
      .catch(() => undefined);
    el.addEventListener('change', () => {
      const typed = el.value.trim();
      // "ethusdt" becomes the source's own spelling, "ETHUSDT".
      const text = known.includes(typed) ? typed : (known.find((s) => s.toUpperCase() === typed.toUpperCase()) ?? typed);
      // Values a symbol cannot have fall back to the default; show what was kept instead.
      if (validateInput(def, text) !== text) {
        el.value = String(value);
        el.setCustomValidity('Symbols use letters, digits and . _ : / - ^ = ! &');
        el.reportValidity();
        el.setCustomValidity('');
        return;
      }
      el.value = text;
      onChange(text);
    });
    control = h('span', {}, el, list);
  } else if (def.type === 'bool') {
    const el = h('input', { type: 'checkbox', class: 'param-check', checked: value === true, 'aria-label': label }) as HTMLInputElement;
    el.addEventListener('change', () => onChange(el.checked));
    control = el;
  } else if (def.type === 'color') {
    const hex = String(value).slice(0, 7);
    const el = h('input', { type: 'color', class: 'param-color', value: hex, 'aria-label': label }) as HTMLInputElement;
    el.addEventListener('change', () => onChange(el.value));
    control = el;
  } else if (def.type === 'string') {
    const el = h('input', { type: 'text', class: 'param-input', value: String(value), 'aria-label': label }) as HTMLInputElement;
    el.addEventListener('change', () => onChange(el.value));
    control = el;
  } else {
    const el = h('input', {
      type: 'number',
      class: 'param-input',
      step: def.step !== undefined ? String(def.step) : def.type === 'int' ? '1' : 'any',
      min: def.minval !== undefined ? String(def.minval) : undefined,
      max: def.maxval !== undefined ? String(def.maxval) : undefined,
      value: String(value),
      'aria-label': label,
    }) as HTMLInputElement;
    el.addEventListener('change', () => {
      const v = Number(el.value);
      if (!Number.isFinite(v)) {
        el.value = String(value);
        return;
      }
      onChange(v);
    });
    control = el;
  }
  return h('label', { class: 'param', title: def.tooltip ?? '' }, h('span', { class: 'param-label muted' }, label), h('span', { class: 'param-row' }, control));
}

/** Rows for the scripts on the chart, shown in the indicator dialog's "On chart" list. */
export function scriptRows(manager: ScriptManager, opts: ScriptRowsOptions): Node[] {
  return manager.list().map((s: ScriptInfo) => {
    const fields = h(
      'div',
      { class: 'param-fields' },
      ...s.inputs.map((def) =>
        inputField(
          def,
          s.values[def.key] ?? def.defval,
          (v) => {
            const res = manager.setInputs(s.id, { [def.key]: v });
            if (res.ok) opts.rerender();
          },
          { symbols: opts.symbols },
        ),
      ),
    );
    return h(
      'div',
      { class: 'active-item', dataset: { script: s.id } },
      h(
        'div',
        { class: 'active-head' },
        h('span', { class: 'catalog-name' }, s.shortTitle),
        h('span', { class: 'muted' }, s.title === s.shortTitle ? 'Script' : s.title),
        h('span', { class: 'pill' }, s.overlay ? 'price' : 'pane'),
        h('button', { class: 'btn btn-ghost small', title: 'Open in the script editor', onclick: () => opts.onEdit(s.id) }, 'Edit'),
        h('button', {
          class: 'icon-btn',
          title: `Remove ${s.shortTitle}`,
          'aria-label': `Remove ${s.shortTitle}`,
          html: ICONS.trash,
          onclick: () => {
            manager.remove(s.id);
            opts.rerender();
          },
        }),
      ),
      s.error ? h('p', { class: 'script-error small' }, s.error) : null,
      s.inputs.length > 0 ? fields : h('p', { class: 'muted small' }, 'No inputs'),
    );
  });
}
