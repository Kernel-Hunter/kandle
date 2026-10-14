import { h, ICONS } from './dom';
import { createModal } from './modal';
import { INDICATORS, getIndicatorDef, paramLabel } from '../chart/indicators';
import type { PaneKind } from '../store/layout';

export interface ActiveIndicator {
  id: string;
  name: string;
  pane: PaneKind;
  params: number[];
}

export interface IndicatorPanelOptions {
  list: () => ActiveIndicator[];
  add: (name: string) => void;
  remove: (id: string) => void;
  update: (id: string, params: number[]) => void;
}

export function createIndicatorPanel(options: IndicatorPanelOptions) {
  const modal = createModal('Indicators', { className: 'modal-indicators' });
  const filter = h('input', {
    class: 'search-input',
    type: 'text',
    placeholder: 'Filter indicators',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': 'Filter indicators',
  }) as HTMLInputElement;
  const catalog = h('div', { class: 'catalog' });
  const activeList = h('div', { class: 'active-list' });

  modal.body.append(
    h(
      'div',
      { class: 'ind-grid' },
      h(
        'section',
        { class: 'ind-col' },
        h('div', { class: 'search-row' }, h('span', { class: 'search-icon', html: ICONS.search }), filter),
        catalog,
      ),
      h('section', { class: 'ind-col' }, h('h3', { class: 'col-title' }, 'On chart'), activeList),
    ),
  );

  const renderCatalog = () => {
    const q = filter.value.trim().toLowerCase();
    const defs = INDICATORS.filter((d) => !q || d.name.toLowerCase().includes(q) || d.label.toLowerCase().includes(q));
    const group = (pane: PaneKind, title: string) => {
      const items = defs.filter((d) => d.pane === pane);
      if (items.length === 0) return null;
      return h(
        'div',
        { class: 'catalog-group' },
        h('div', { class: 'catalog-title muted' }, title),
        ...items.map((d) =>
          h(
            'button',
            {
              class: 'catalog-item',
              title: `Add ${d.label}`,
              onclick: () => {
                options.add(d.name);
                renderActive();
              },
            },
            h('span', { class: 'catalog-name' }, d.name),
            h('span', { class: 'catalog-label muted' }, d.label),
            h('span', { class: 'catalog-add' }, '+'),
          ),
        ),
      );
    };
    catalog.replaceChildren(
      ...[group('main', 'Price overlays'), group('sub', 'Oscillators and volume')].filter((x): x is HTMLDivElement => !!x),
    );
  };

  const renderActive = () => {
    const items = options.list();
    if (items.length === 0) {
      activeList.replaceChildren(h('p', { class: 'muted empty' }, 'No indicators yet. Pick one from the list.'));
      return;
    }
    activeList.replaceChildren(
      ...items.map((ind) => {
        const def = getIndicatorDef(ind.name);
        let params = [...ind.params];
        const fields = h('div', { class: 'param-fields' });
        const commit = () => options.update(ind.id, params);
        const renderFields = () => {
          const nodes: Node[] = params.map((value, i) => {
              const input = h('input', {
                type: 'number',
                class: 'param-input',
                step: 'any',
                value: String(value),
                'aria-label': `${ind.name} ${paramLabel(def, i)}`,
              }) as HTMLInputElement;
              input.addEventListener('change', () => {
                const v = Number(input.value);
                if (!Number.isFinite(v) || v <= 0) {
                  input.value = String(params[i]);
                  return;
                }
                params[i] = v;
                commit();
              });
              const removeBtn =
                def?.variadic && params.length > 1
                  ? h('button', {
                      class: 'icon-btn tiny',
                      title: 'Remove line',
                      'aria-label': 'Remove line',
                      html: ICONS.close,
                      onclick: () => {
                        params = params.filter((_, j) => j !== i);
                        commit();
                        renderFields();
                      },
                    })
                  : null;
              return h('label', { class: 'param' }, h('span', { class: 'param-label muted' }, paramLabel(def, i)), h('span', { class: 'param-row' }, input, removeBtn));
            });
          if (def?.variadic) {
            nodes.push(
              h(
                  'button',
                  {
                    class: 'btn btn-ghost small',
                    onclick: () => {
                      const last = params[params.length - 1] ?? 10;
                      params = [...params, Math.round(last * 2)];
                      commit();
                      renderFields();
                    },
                  },
                  '+ Line',
                ),
            );
          }
          fields.replaceChildren(...nodes);
        };
        renderFields();
        return h(
          'div',
          { class: 'active-item' },
          h(
            'div',
            { class: 'active-head' },
            h('span', { class: 'catalog-name' }, ind.name),
            h('span', { class: 'muted' }, def?.label ?? ''),
            h('span', { class: 'pill' }, ind.pane === 'main' ? 'price' : 'pane'),
            h('button', {
              class: 'icon-btn',
              title: `Remove ${ind.name}`,
              'aria-label': `Remove ${ind.name}`,
              html: ICONS.trash,
              onclick: () => {
                options.remove(ind.id);
                renderActive();
              },
            }),
          ),
          params.length > 0 || def?.variadic ? fields : h('p', { class: 'muted small' }, 'No parameters'),
        );
      }),
    );
  };

  filter.addEventListener('input', renderCatalog);
  filter.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = catalog.querySelector<HTMLButtonElement>('.catalog-item');
      first?.click();
    }
  });

  return {
    open() {
      filter.value = '';
      renderCatalog();
      renderActive();
      modal.open();
      requestAnimationFrame(() => filter.focus());
    },
    refresh() {
      if (modal.isOpen()) renderActive();
    },
    isOpen: () => modal.isOpen(),
    close: () => modal.close(),
  };
}
