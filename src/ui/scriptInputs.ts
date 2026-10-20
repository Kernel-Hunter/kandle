import { h, ICONS } from './dom';
import './scripts.css';
import { inputChoices, selectedChoice, validateInput, type InputDef, type InputValue } from '../script/engine';
import type { ScriptInfo, ScriptManager } from '../script/manager';
import type { CommissionType, QtyType, StrategyConfig } from '../script/strategy';
import { COMMISSION_TYPES, QTY_TYPES, checkStrategySetting } from '../script/strategySettings';

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

const QTY_LABELS: Record<QtyType, string> = { fixed: 'Contracts', cash: 'Cash', percent_of_equity: '% of equity' };
const COMMISSION_LABELS: Record<CommissionType, string> = { percent: '% of value', cash_per_contract: 'Per contract', cash_per_order: 'Per order' };

/**
 * Backtest settings of a strategy script: the strategy() call's values, which can be changed
 * here. Changed settings are highlighted and Reset brings back the script's values.
 */
function strategySettingsFields(s: ScriptInfo, manager: ScriptManager, rerender: () => void): HTMLElement | null {
  const settings = s.strategySettings;
  const defaults = s.strategyDefaults;
  if (!settings || !defaults) return null;
  const set = (patch: Record<string, unknown> | null) => {
    if (manager.setStrategySettings(s.id, patch).ok) rerender();
  };
  const changed = (...keys: Array<keyof StrategyConfig>) => keys.some((k) => settings[k] !== defaults[k]);
  const scriptValue = (key: keyof StrategyConfig, text: string) => (settings[key] === defaults[key] ? '' : `Script value: ${text}`);

  const number = (key: keyof StrategyConfig, label: string, integer: boolean) => {
    const value = settings[key] as number;
    const el = h('input', {
      type: 'number',
      class: 'param-input',
      step: integer ? '1' : 'any',
      min: '0',
      value: String(value),
      'aria-label': label,
    }) as HTMLInputElement;
    el.addEventListener('change', () => {
      const res = checkStrategySetting(key, label, el.value.trim() === '' ? NaN : Number(el.value));
      if ('error' in res) {
        el.value = String(value);
        el.setCustomValidity(res.error);
        el.reportValidity();
        el.setCustomValidity('');
        return;
      }
      set({ [key]: res.value });
    });
    return el;
  };
  const select = <T extends string>(key: keyof StrategyConfig, label: string, options: readonly T[], labels: Record<T, string>) => {
    const el = h('select', { class: 'param-input', 'aria-label': label }, ...options.map((o) => h('option', { value: o, selected: settings[key] === o }, labels[o]))) as HTMLSelectElement;
    el.addEventListener('change', () => set({ [key]: el.value }));
    return el;
  };
  const field = (label: string, isChanged: boolean, tip: string, ...controls: HTMLElement[]) =>
    h(
      'label',
      { class: isChanged ? 'param param-changed' : 'param', title: tip },
      h('span', { class: 'param-label muted' }, label),
      h('span', { class: 'param-row' }, ...controls),
    );

  const onClose = h('input', { type: 'checkbox', class: 'param-check', checked: settings.processOrdersOnClose, 'aria-label': 'Fill on bar close' }) as HTMLInputElement;
  onClose.addEventListener('change', () => set({ processOrdersOnClose: onClose.checked }));
  const any = changed('initialCapital', 'defaultQtyType', 'defaultQtyValue', 'commissionType', 'commissionValue', 'slippage', 'pyramiding', 'processOrdersOnClose');

  return h(
    'div',
    { class: 'strategy-settings' },
    h(
      'div',
      { class: 'strategy-settings-head' },
      h('span', { class: 'param-label muted' }, 'Backtest settings'),
      h(
        'button',
        {
          class: 'btn btn-ghost small',
          disabled: !any,
          title: "Use the values from the script's strategy() call",
          onclick: () => set(null),
        },
        'Reset',
      ),
    ),
    h(
      'div',
      { class: 'param-fields' },
      field('Initial capital', changed('initialCapital'), scriptValue('initialCapital', String(defaults.initialCapital)), number('initialCapital', 'Initial capital', false)),
      field(
        'Order size',
        changed('defaultQtyType', 'defaultQtyValue'),
        `Used by orders placed without a quantity. ${changed('defaultQtyType', 'defaultQtyValue') ? `Script value: ${defaults.defaultQtyValue} ${QTY_LABELS[defaults.defaultQtyType]}` : ''}`.trim(),
        number('defaultQtyValue', 'Order size', false),
        select('defaultQtyType', 'Order size type', QTY_TYPES, QTY_LABELS),
      ),
      field(
        'Commission',
        changed('commissionType', 'commissionValue'),
        `Charged on every entry and exit. ${changed('commissionType', 'commissionValue') ? `Script value: ${defaults.commissionValue} ${COMMISSION_LABELS[defaults.commissionType]}` : ''}`.trim(),
        number('commissionValue', 'Commission', false),
        select('commissionType', 'Commission type', COMMISSION_TYPES, COMMISSION_LABELS),
      ),
      field('Slippage, ticks', changed('slippage'), `Market and stop orders fill this many ticks worse. ${scriptValue('slippage', String(defaults.slippage))}`.trim(), number('slippage', 'Slippage', true)),
      field(
        'Pyramiding',
        changed('pyramiding'),
        `Entries allowed in the same direction; 0 and 1 both allow one. ${scriptValue('pyramiding', String(defaults.pyramiding))}`.trim(),
        number('pyramiding', 'Pyramiding', true),
      ),
      field(
        'Fill on bar close',
        changed('processOrdersOnClose'),
        `Market orders fill at the close of the bar that placed them instead of the next open. ${scriptValue('processOrdersOnClose', defaults.processOrdersOnClose ? 'on' : 'off')}`.trim(),
        onClose,
      ),
    ),
  );
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
      strategySettingsFields(s, manager, opts.rerender),
    );
  });
}
