/**
 * Import CSV dialog and drag and drop. A file is read and parsed in the browser, the user
 * names the dataset, and it is saved locally and opened on the chart.
 */
import './dataSources.css';
import { CSV_SOURCE_ID, CsvError, csvStore, datasetMeta, parseCsv, type CsvParseResult } from '../data/csv';
import { getTimeframe } from '../data/timeframes';
import type { SymbolMeta } from '../data/types';
import { h } from './dom';
import { createModal, type Modal } from './modal';

/** Files larger than this are refused before reading; they could not be stored anyway. */
const MAX_FILE_BYTES = 40_000_000;

export const CSV_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 18v-6M9 15l3 3 3-3"/></svg>';

let onImported: ((sourceId: string, meta: SymbolMeta) => void) | null = null;

/** Where a finished import goes: normally the main chart's setSymbol. */
export function setCsvImportHandler(fn: (sourceId: string, meta: SymbolMeta) => void): void {
  onImported = fn;
}

/** Shows an imported dataset on the main chart. */
export function openImportedDataset(meta: SymbolMeta): void {
  onImported?.(CSV_SOURCE_ID, meta);
}

export function csvBadge(): HTMLElement {
  return h('span', { class: 'mk-badge mk-csv' }, 'CSV');
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

/** One line about what a parse found, for the dialog and tests. */
export function describeParse(r: CsvParseResult): string {
  const tf = getTimeframe(r.timeframe)!.label;
  const c = r.candles;
  const parts = [`${plural(c.length, 'bar')} of ${tf}, ${day(c[0].time)} to ${day(c[c.length - 1].time)}.`];
  if (r.resampled) parts.push(`The file's bars were combined into ${tf} bars.`);
  if (r.malformed) parts.push(`${plural(r.malformed, 'malformed row')} skipped.`);
  if (r.duplicates) parts.push(`${plural(r.duplicates, 'repeated time')} dropped (the last row was kept).`);
  return parts.join(' ');
}

let modal: Modal | null = null;
let showFile: ((file: File) => void) | null = null;
let reset: (() => void) | null = null;

function ensureModal(): Modal {
  if (modal) return modal;
  const m = createModal('Import CSV', { className: 'modal-small modal-csv' });
  let parsed: CsvParseResult | null = null;
  let seq = 0;

  const fileInput = h('input', { type: 'file', accept: '.csv,.txt,.tsv,text/csv,text/plain', class: 'csv-file', 'aria-label': 'CSV file' }) as HTMLInputElement;
  const fileName = h('span', { class: 'csv-file-name muted small' }, 'No file chosen');
  const summary = h('p', { class: 'ds-status small', role: 'status' });
  const nameInput = h('input', { class: 'text-input csv-name', type: 'text', maxlength: 60, placeholder: 'Name, e.g. BTC daily', 'aria-label': 'Dataset name', spellcheck: 'false' }) as HTMLInputElement;
  const importBtn = h('button', { class: 'btn btn-primary', type: 'button', disabled: true }, 'Import') as HTMLButtonElement;

  const setSummary = (text: string, kind: 'ok' | 'error' | 'info') => {
    summary.textContent = text;
    summary.className = `ds-status small ds-${kind}`;
  };

  const load = async (file: File) => {
    const mySeq = ++seq;
    parsed = null;
    importBtn.disabled = true;
    fileName.textContent = file.name;
    if (!nameInput.value.trim() || nameInput.dataset.auto === '1') {
      nameInput.value = file.name.replace(/\.(csv|txt|tsv)$/i, '').slice(0, 60);
      nameInput.dataset.auto = '1';
    }
    if (file.size > MAX_FILE_BYTES) {
      setSummary(`This file is ${(file.size / 1_000_000).toFixed(0)} MB. Files up to ${MAX_FILE_BYTES / 1_000_000} MB can be read.`, 'error');
      return;
    }
    setSummary('Reading...', 'info');
    try {
      const text = await file.text();
      if (mySeq !== seq) return;
      parsed = parseCsv(text);
      setSummary(describeParse(parsed), 'ok');
      importBtn.disabled = false;
    } catch (error) {
      if (mySeq !== seq) return;
      setSummary(error instanceof CsvError ? error.message : `Could not read the file: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  };

  const save = () => {
    if (!parsed) return;
    try {
      const dataset = csvStore().save(nameInput.value, parsed);
      m.close();
      onImported?.(CSV_SOURCE_ID, datasetMeta(dataset));
    } catch (error) {
      setSummary(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) void load(file);
  });
  nameInput.addEventListener('input', () => {
    nameInput.dataset.auto = '';
  });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !importBtn.disabled) {
      e.preventDefault();
      save();
    }
  });
  importBtn.addEventListener('click', save);

  m.body.append(
    h(
      'p',
      { class: 'muted small csv-help' },
      'A header row with time (or date), open, high, low, close and optional volume columns, in any order. Comma or semicolon separated. Times as ISO 8601, YYYY-MM-DD, YYYY-MM-DD HH:mm (UTC) or Unix seconds or milliseconds. You can also drop a file on the chart.',
    ),
    h('div', { class: 'csv-row' }, h('label', { class: 'btn csv-pick' }, 'Choose file', fileInput), fileName),
    summary,
    h('label', { class: 'ds-field' }, h('span', { class: 'small muted' }, 'Name'), nameInput),
    h('p', { class: 'muted small csv-help' }, 'The data stays in this browser and does not update, so alerts on it never fire.'),
    h('div', { class: 'modal-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancel'), importBtn),
  );

  showFile = (file) => void load(file);
  reset = () => {
    seq++;
    parsed = null;
    fileInput.value = '';
    fileName.textContent = 'No file chosen';
    nameInput.value = '';
    nameInput.dataset.auto = '1';
    importBtn.disabled = true;
    setSummary('', 'info');
  };
  modal = m;
  return m;
}

/** Opens the Import CSV dialog, reading `file` right away when one was dropped. */
export function openCsvImport(file?: File): void {
  const m = ensureModal();
  if (!m.isOpen()) reset?.();
  m.open();
  if (file) showFile?.(file);
}

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

/** Lets the user drop a CSV file on `target` (the chart area) to import it. */
export function bindCsvDrop(target: HTMLElement): void {
  const overlay = h('div', { class: 'csv-drop', hidden: true }, h('span', { html: CSV_ICON }), h('span', {}, 'Drop a CSV file to import it'));
  target.append(overlay);
  let depth = 0;
  target.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    overlay.hidden = false;
  });
  target.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  target.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay.hidden = true;
  });
  target.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    const file = e.dataTransfer?.files?.[0];
    if (file) openCsvImport(file);
  });
}
