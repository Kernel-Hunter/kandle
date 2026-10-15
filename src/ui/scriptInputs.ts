import { h, ICONS } from './dom';
import './scripts.css';
import type { InputDef, InputValue } from '../script/engine';
import type { ScriptInfo, ScriptManager } from '../script/manager';
import { SOURCE_SERIES } from '../script/compiler';

export interface ScriptRowsOptions {
  onEdit: (id: string) => void;
  rerender: () => void;
}

/** One editable field for a script input, matching the input's type. */
export function inputField(def: InputDef, value: InputValue, onChange: (v: InputValue) => void): HTMLElement {
  const label = `${def.title}`;
  let control: HTMLElement;
  const select = (options: InputValue[]) => {
    const el = h('select', { class: 'param-input', 'aria-label': label }) as HTMLSelectElement;
    for (const o of options) el.append(h('option', { value: String(o), selected: o === value }, String(o)));
    el.addEventListener('change', () => {
      const raw = el.value;
      onChange(typeof def.defval === 'number' ? Number(raw) : raw);
    });
    return el;
  };
  if (def.options && def.options.length > 0) {
    control = select(def.options);
  } else if (def.type === 'source') {
    control = select(Object.keys(SOURCE_SERIES));
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
        inputField(def, s.values[def.key] ?? def.defval, (v) => {
          const res = manager.setInputs(s.id, { [def.key]: v });
          if (res.ok) opts.rerender();
        }),
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
