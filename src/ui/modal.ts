import { h, ICONS } from './dom';

export interface Modal {
  root: HTMLElement;
  body: HTMLElement;
  open(): void;
  close(): void;
  isOpen(): boolean;
}

let openModals: Modal[] = [];

export function topModal(): Modal | undefined {
  return openModals[openModals.length - 1];
}

export function createModal(title: string, options: { className?: string; onClose?: () => void } = {}): Modal {
  const body = h('div', { class: 'modal-body' });
  const dialog = h(
    'div',
    { class: `modal ${options.className ?? ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-head' }, h('h2', {}, title), h('button', { class: 'icon-btn', title: 'Close (Esc)', 'aria-label': 'Close', html: ICONS.close, onclick: () => modal.close() })),
    body,
  );
  const root = h('div', { class: 'modal-backdrop', hidden: true }, dialog);
  root.addEventListener('mousedown', (e) => {
    if (e.target === root) modal.close();
  });
  document.body.append(root);

  let returnFocus: HTMLElement | null = null;
  const modal: Modal = {
    root,
    body,
    open() {
      if (!root.hidden) return;
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      root.hidden = false;
      openModals.push(modal);
    },
    close() {
      if (root.hidden) return;
      // Hidden inputs keep focus otherwise, which would swallow global shortcuts.
      if (document.activeElement instanceof HTMLElement && root.contains(document.activeElement)) {
        document.activeElement.blur();
      }
      if (returnFocus && document.contains(returnFocus) && !root.contains(returnFocus)) returnFocus.focus({ preventScroll: true });
      returnFocus = null;
      root.hidden = true;
      openModals = openModals.filter((m) => m !== modal);
      options.onClose?.();
    },
    isOpen: () => !root.hidden,
  };
  return modal;
}

/** Small text prompt used by the text-note tool. Resolves null when cancelled. */
export function promptText(title: string, initial = ''): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      modal.close();
      modal.root.remove();
      resolve(value);
    };
    const modal = createModal(title, { className: 'modal-small', onClose: () => finish(null) });
    const input = h('textarea', { class: 'text-input', rows: 3, maxlength: 280, placeholder: 'Type a note' }) as HTMLTextAreaElement;
    input.value = initial;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        finish(input.value.trim());
      }
    });
    modal.body.append(
      input,
      h(
        'div',
        { class: 'modal-actions' },
        h('button', { class: 'btn', onclick: () => finish(null) }, 'Cancel'),
        h('button', { class: 'btn btn-primary', onclick: () => finish(input.value.trim()) }, 'Save'),
      ),
    );
    modal.open();
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  });
}
