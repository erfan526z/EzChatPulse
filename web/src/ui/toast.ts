export interface ToastAction {
  label: string;
  onClick: () => void;
}

/**
 * Transient toast. Pass `action` to render a button inside it (e.g. "Open
 * settings") — actionable toasts stay up longer and do not auto-dismiss while
 * the pointer is over them.
 */
export function toast(message: string, kind: 'error' | 'info' = 'info', action?: ToastAction): void {
  const root = document.querySelector('#toast-root');
  if (!root) return;
  const el = document.createElement('div');
  el.className = `toast toast-${kind}${action ? ' toast-actionable' : ''}`;
  const text = document.createElement('span');
  text.className = 'toast-text';
  text.textContent = message;
  el.appendChild(text);

  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  const dismiss = (): void => {
    if (hideTimer) clearTimeout(hideTimer);
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  };

  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-btn';
    btn.textContent = action.label;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      dismiss();
      action.onClick();
    });
    el.appendChild(btn);
    el.addEventListener('mouseenter', () => hideTimer && clearTimeout(hideTimer));
  }

  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  hideTimer = setTimeout(dismiss, action ? 12000 : 3200);
}

export function openModal(content: HTMLElement): () => void {
  const root = document.querySelector('#modal-root');
  if (!root) return () => {};
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const box = document.createElement('div');
  box.className = 'modal-box';
  box.appendChild(content);
  overlay.appendChild(box);
  root.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));

  const close = () => {
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), 200);
  };
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  return close;
}

/** Promise-based confirm dialog. Resolves true when the user confirms. */
export function confirmDialog(title: string, body: string, confirmLabel = 'Delete'): Promise<boolean> {
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.className = 'confirm-modal';
    const h = document.createElement('h2');
    h.textContent = title;
    const p = document.createElement('p');
    p.textContent = body;
    const actions = document.createElement('div');
    actions.className = 'confirm-actions';
    const cancel = document.createElement('button');
    cancel.className = 'confirm-cancel';
    cancel.textContent = 'Cancel';
    const confirm = document.createElement('button');
    confirm.className = 'confirm-delete';
    confirm.textContent = confirmLabel;
    const close = openModal(root);
    let done = false;
    const finish = (v: boolean): void => {
      if (done) return;
      done = true;
      close();
      resolve(v);
    };
    cancel.addEventListener('click', () => finish(false));
    confirm.addEventListener('click', () => finish(true));
    actions.append(cancel, confirm);
    root.append(h, p, actions);
  });
}
