import type { Chart } from 'klinecharts';
import { CSV_SOURCE_ID } from '../data/csv';
import type { ActiveIndicator } from '../ui/indicatorPanel';
import { h } from '../ui/dom';
import { createModal } from '../ui/modal';
import { describeAlert, drawingLabel, LINE_OVERLAYS, type AlertEngine } from './engine';
import { notificationPermission } from './notify';

export const BELL_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>';

export interface AlertsPanelOptions {
  engine: AlertEngine;
  chart: () => Chart;
  symbol: () => { source: string; symbol: string };
  indicators: () => ActiveIndicator[];
  /** Creates an alert with the same rules as the agent's set_alert tool. */
  create: (params: Record<string, unknown>) => Promise<unknown>;
  toast: (message: string, kind?: 'info' | 'error') => void;
}

const DRAWINGS_GROUP = 'drawings';

/** The "Alerts" topbar button and the alert manager dialog. */
export function createAlertsPanel(options: AlertsPanelOptions) {
  const modal = createModal('Alerts', { className: 'modal-small alerts-modal' });
  const select = (label: string, items: Array<[string, string]>) =>
    h('select', { class: 'text-input al-input', 'aria-label': label }, ...items.map(([v, t]) => h('option', { value: v }, t))) as HTMLSelectElement;

  const type = select('Alert type', [
    ['price', 'Price level'],
    ['drawing', 'Drawn line'],
    ['indicator', 'Indicator'],
  ]);
  const condition = select('Condition', [
    ['crosses', 'Crosses'],
    ['crosses_up', 'Crosses up'],
    ['crosses_down', 'Crosses down'],
    ['touches', 'Touches'],
  ]);
  const level = h('input', { class: 'text-input al-input', type: 'number', step: 'any', 'aria-label': 'Level', placeholder: 'Level' }) as HTMLInputElement;
  const drawing = select('Drawing', []);
  const indicator = select('Indicator', []);
  const line = select('Indicator line', []);
  const frequency = select('Frequency', [
    ['once', 'Once'],
    ['every_time', 'Every time (once per bar)'],
  ]);
  const message = h('input', { class: 'text-input al-input', type: 'text', maxlength: 200, placeholder: 'Message (optional)', 'aria-label': 'Message' }) as HTMLInputElement;
  const list = h('div', { class: 'al-list' });
  const permissionNote = h('p', { class: 'muted small al-note' });
  const renderPermission = () => {
    const state = notificationPermission();
    if (options.symbol().source === CSV_SOURCE_ID) {
      permissionNote.textContent = 'This chart shows imported CSV data, which does not update, so alerts on it never fire.';
      return;
    }
    permissionNote.textContent =
      state === 'denied'
        ? 'Browser notifications are blocked for this site, so alerts show here in the app and play a sound.'
        : state === 'unsupported'
          ? 'This browser has no notifications, so alerts show here in the app and play a sound.'
          : state === 'default'
            ? 'Kandle asks to show notifications when you create your first alert. Alerts only run while this tab is open.'
            : 'Alerts run while this tab is open and show a notification, a message here and a sound.';
  };

  const row = (label: string, control: HTMLElement, cls = '') => h('label', { class: `al-row ${cls}` }, h('span', { class: 'al-label' }, label), control);
  const levelRow = row('Level', level);
  const drawingRow = row('Line', drawing);
  const indicatorRow = row('Indicator', indicator);
  const lineRow = row('Line', line);

  const fillDrawings = () => {
    const chart = options.chart();
    const lines = chart.getOverlays({ groupId: DRAWINGS_GROUP }).filter((o) => o.currentStep === -1 && LINE_OVERLAYS.has(o.name));
    const precision = chart.getSymbol()?.pricePrecision ?? 2;
    drawing.replaceChildren(
      ...(lines.length === 0
        ? [h('option', { value: '' }, 'No lines on this chart. Draw a horizontal or trend line first.')]
        : lines.map((o) => {
            const values = o.points.map((p) => (typeof p.value === 'number' ? p.value.toFixed(precision) : '?'));
            return h('option', { value: o.id }, `${drawingLabel(o.name)} ${values.join(' to ')}`);
          })),
    );
  };

  const fillLines = () => {
    const chart = options.chart();
    const ind = chart.getIndicators({ id: indicator.value })[0];
    const keys = ind ? ind.figures.map((f) => f.key) : [];
    line.replaceChildren(...keys.map((k) => h('option', { value: k }, k)));
  };

  const fillIndicators = () => {
    const active = options.indicators();
    indicator.replaceChildren(
      ...(active.length === 0
        ? [h('option', { value: '' }, 'No indicators on the chart')]
        : active.map((i) => h('option', { value: i.id }, i.params.length ? `${i.name} ${i.params.join(', ')}` : i.name))),
    );
    fillLines();
  };

  const syncForm = () => {
    const t = type.value;
    levelRow.hidden = t === 'drawing';
    drawingRow.hidden = t !== 'drawing';
    indicatorRow.hidden = t !== 'indicator';
    lineRow.hidden = t !== 'indicator';
    if (t === 'drawing') fillDrawings();
    if (t === 'indicator') fillIndicators();
    if (t === 'price' && !level.value) {
      const bars = options.chart().getDataList();
      const last = bars[bars.length - 1];
      if (last) level.value = String(last.close);
    }
  };
  type.addEventListener('change', () => {
    level.value = '';
    syncForm();
  });
  indicator.addEventListener('change', fillLines);

  const submit = async () => {
    const params: Record<string, unknown> = {
      type: type.value,
      condition: condition.value,
      frequency: frequency.value,
    };
    if (message.value.trim()) params.message = message.value.trim();
    if (type.value !== 'drawing') {
      const v = Number(level.value);
      if (level.value.trim() === '' || !Number.isFinite(v)) {
        options.toast('Enter a level', 'error');
        level.focus();
        return;
      }
      params.level = v;
    }
    if (type.value === 'drawing') {
      if (!drawing.value) return options.toast('Draw a horizontal or trend line first', 'error');
      params.drawing_id = drawing.value;
    }
    if (type.value === 'indicator') {
      if (!indicator.value) return options.toast('Add an indicator first', 'error');
      params.indicator_id = indicator.value;
      params.indicator_line = line.value;
    }
    try {
      await options.create(params);
      message.value = '';
      setTimeout(renderPermission, 1500);
      options.toast('Alert created');
    } catch (error) {
      options.toast(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  modal.body.append(
    h(
      'form',
      {
        class: 'al-form',
        onsubmit: (e: Event) => {
          e.preventDefault();
          void submit();
        },
      },
      row('Alert on', type),
      levelRow,
      drawingRow,
      indicatorRow,
      lineRow,
      row('Condition', condition),
      row('Trigger', frequency),
      row('Message', message),
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Create alert')),
      permissionNote,
    ),
    h('div', { class: 'col-title' }, 'Your alerts'),
    list,
  );

  const badge = h('span', { class: 'al-badge', hidden: true });
  const button = h(
    'button',
    { class: 'tb-btn', title: 'Alerts', onclick: () => open() },
    h('span', { html: BELL_ICON }),
    h('span', { class: 'tb-label' }, 'Alerts'),
    badge,
  );

  const renderList = () => {
    const alerts = options.engine.list().sort((a, b) => b.createdAt - a.createdAt);
    const activeCount = alerts.filter((a) => a.active).length;
    badge.hidden = activeCount === 0;
    badge.textContent = String(activeCount);
    list.replaceChildren(
      ...(alerts.length === 0
        ? [h('div', { class: 'empty' }, 'No alerts yet.')]
        : alerts.map((a) => {
            const status = a.active ? 'active' : a.triggeredAt ? 'triggered' : 'paused';
            return h(
              'div',
              { class: `al-item al-${status}` },
              h(
                'div',
                { class: 'al-main' },
                h('div', { class: 'al-desc' }, a.message ? `${a.message}` : describeAlert(a)),
                h(
                  'div',
                  { class: 'muted small' },
                  `${a.source} · ${a.frequency === 'every' ? 'every time' : 'once'} · ${status}`,
                  a.triggerCount ? ` · fired ${a.triggerCount}x, last ${new Date(a.triggeredAt!).toLocaleString()}` : '',
                ),
              ),
              h(
                'button',
                {
                  class: 'btn small',
                  title: a.active ? 'Pause' : 'Turn on again',
                  onclick: () => options.engine.setActive(a.id, !a.active),
                },
                a.active ? 'Pause' : 'Re-arm',
              ),
              h('button', { class: 'btn small btn-ghost', title: 'Delete alert', 'aria-label': 'Delete alert', onclick: () => options.engine.remove(a.id) }, 'Delete'),
            );
          })),
    );
  };

  options.engine.onChange(renderList);
  renderList();

  function open(): void {
    renderPermission();
    syncForm();
    renderList();
    modal.open();
  }

  return { button, open, refresh: renderList };
}
