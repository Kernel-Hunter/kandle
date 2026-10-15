import './dataSources.css';
import { APP } from '../config';
import { h } from './dom';
import { createModal, type Modal } from './modal';
import { SOURCES, hasKey, sourceMarkets } from '../data/sources';
import { keyStore } from '../data/keys';
import { errorMessage } from '../data/http';
import type { DataSource, MarketType } from '../data/types';

export const MARKET_LABELS: Record<MarketType, string> = {
  crypto: 'Crypto',
  stock: 'Stock',
  etf: 'ETF',
  forex: 'Forex',
  index: 'Index',
};

export function marketBadge(market: MarketType): HTMLElement {
  return h('span', { class: `mk-badge mk-${market}` }, MARKET_LABELS[market]);
}

const FRESHNESS_LABELS = { live: 'Live', delayed: 'Delayed', 'end-of-day': 'End of day' } as const;

export const DATA_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/></svg>';

let modal: Modal | null = null;
let renderList: ((focus?: string) => void) | null = null;

function sourceCard(source: DataSource, rerender: () => void): HTMLElement {
  const freshness = source.freshness ?? 'live';
  const head = h(
    'div',
    { class: 'ds-head' },
    h('span', { class: 'ds-name' }, source.name),
    ...sourceMarkets(source).map(marketBadge),
    h('span', { class: `ds-fresh ds-fresh-${freshness}` }, FRESHNESS_LABELS[freshness]),
    h('span', { class: 'spacer' }),
    source.auth
      ? h('span', { class: `ds-keystate${hasKey(source) ? ' ok' : ''}` }, hasKey(source) ? 'Key saved' : 'Needs a free key')
      : h('span', { class: 'ds-keystate ok' }, 'No key needed'),
  );
  const card = h('section', { class: 'ds-card', dataset: { source: source.id } }, head);
  const auth = source.auth;
  // Keyed sources describe their limits in the plan line instead.
  if (source.note && !auth) card.append(h('p', { class: 'muted small ds-note' }, source.note));
  if (!auth) return card;

  const saved = keyStore().get(source.id) ?? {};
  const inputs = auth.fields.map((f) => {
    const input = h('input', {
      class: 'text-input ds-input',
      type: f.secret ? 'password' : 'text',
      placeholder: f.placeholder ?? f.label,
      autocomplete: 'off',
      spellcheck: 'false',
      'aria-label': `${source.name} ${f.label}`,
      dataset: { field: f.id },
    }) as HTMLInputElement;
    input.value = saved[f.id] ?? '';
    return { field: f, input };
  });
  const status = h('p', { class: 'ds-status small', role: 'status' });
  const setStatus = (text: string, kind: 'ok' | 'error' | 'info') => {
    status.textContent = text;
    status.className = `ds-status small ds-${kind}`;
  };

  const save = (): boolean => {
    const values = Object.fromEntries(inputs.map(({ field, input }) => [field.id, input.value]));
    const missing = inputs.filter(({ input }) => !input.value.trim()).map(({ field }) => field.label);
    keyStore().set(source.id, values);
    if (missing.length) {
      setStatus(`Missing: ${missing.join(', ')}.`, 'error');
      return false;
    }
    return true;
  };

  const testBtn = h('button', { class: 'btn small', type: 'button' }, 'Test connection') as HTMLButtonElement;
  testBtn.addEventListener('click', async () => {
    if (!save()) return;
    if (!source.testConnection) {
      setStatus('Saved.', 'ok');
      return;
    }
    testBtn.disabled = true;
    setStatus('Testing...', 'info');
    try {
      setStatus(await source.testConnection(), 'ok');
    } catch (error) {
      setStatus(errorMessage(error), 'error');
    } finally {
      testBtn.disabled = false;
    }
  });

  card.append(
    h('p', { class: 'muted small ds-plan' }, auth.plan),
    h(
      'div',
      { class: 'ds-fields' },
      ...inputs.map(({ field, input }) => h('label', { class: 'ds-field' }, h('span', { class: 'small muted' }, field.label), input)),
    ),
    h(
      'div',
      { class: 'ds-actions' },
      h('a', { class: 'ds-link small', href: auth.signupUrl, target: '_blank', rel: 'noopener noreferrer' }, `Get a free ${source.name} key`),
      h('span', { class: 'spacer' }),
      h(
        'button',
        {
          class: 'btn small btn-ghost',
          type: 'button',
          onclick: () => {
            keyStore().clear(source.id);
            for (const { input } of inputs) input.value = '';
            rerender();
          },
        },
        'Remove key',
      ),
      h(
        'button',
        {
          class: 'btn small',
          type: 'button',
          onclick: () => {
            if (save()) {
              rerender();
            }
          },
        },
        'Save',
      ),
      testBtn,
    ),
    status,
  );
  for (const { input } of inputs) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        testBtn.click();
      }
    });
  }
  return card;
}

function ensureModal(): Modal {
  if (modal) return modal;
  const m = createModal('Data sources', { className: 'modal-data' });
  const list = h('div', { class: 'ds-list' });
  m.body.append(
    h(
      'p',
      { class: 'ds-privacy small' },
      h('strong', {}, 'Keys stay in this browser. '),
      `They are saved in this browser's local storage and each one is sent only to its own provider. ${APP.name} has no server and never sees them. Market data is for your own viewing; each provider's terms apply.`,
    ),
    list,
  );
  renderList = (focus) => {
    const rerender = () => renderList?.();
    list.replaceChildren(...SOURCES.map((s) => sourceCard(s, rerender)));
    if (focus) {
      const card = list.querySelector<HTMLElement>(`[data-source="${focus}"]`);
      card?.classList.add('ds-focus');
      requestAnimationFrame(() => {
        card?.scrollIntoView({ block: 'nearest' });
        card?.querySelector<HTMLInputElement>('input')?.focus();
      });
    }
  };
  modal = m;
  return m;
}

/** Opens the Data sources dialog, optionally scrolled to one source's key form. */
export function openDataSources(sourceId?: string): void {
  const m = ensureModal();
  renderList?.(sourceId);
  m.open();
}

/** Top bar button that opens the dialog. */
export function createDataSourcesButton(): HTMLButtonElement {
  return h(
    'button',
    { class: 'tb-btn', title: 'Data sources and API keys', onclick: () => openDataSources() },
    h('span', { html: DATA_ICON }),
    h('span', { class: 'tb-label' }, 'Data'),
  ) as HTMLButtonElement;
}
