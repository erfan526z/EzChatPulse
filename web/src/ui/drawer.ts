import { store } from '../store';
import { avatarEl } from './format';
import { openSettings } from './settings';
import { openCreateGroupModal } from './group';
import { confirmDialog } from './toast';
import { setToken } from '../api';

/**
 * The navigation drawer: identity at the top, actions below, a back button and
 * Escape to leave. It slides over the chat list only, so the conversation stays
 * visible beside it on wide screens.
 */

let scrim: HTMLDivElement | null = null;
let panel: HTMLDivElement | null = null;
let onKey: ((e: KeyboardEvent) => void) | null = null;

export function isDrawerOpen(): boolean {
  return Boolean(panel && panel.classList.contains('show'));
}

export function closeDrawer(): void {
  if (!panel || !scrim) return;
  panel.classList.remove('show');
  scrim.classList.remove('show');
  if (onKey) {
    document.removeEventListener('keydown', onKey);
    onKey = null;
  }
  const p = panel;
  const s = scrim;
  panel = null;
  scrim = null;
  window.setTimeout(() => {
    p.remove();
    s.remove();
  }, 200);
}

function navButton(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'drawer-item';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

export function openDrawer(host: HTMLElement): void {
  if (isDrawerOpen()) {
    closeDrawer();
    return;
  }
  const session = store.state.session;
  if (!session) return;
  const me = session.user;

  scrim = document.createElement('div');
  scrim.className = 'drawer-scrim';
  scrim.addEventListener('click', () => closeDrawer());

  panel = document.createElement('div');
  panel.className = 'drawer';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Menu');

  const top = document.createElement('div');
  top.className = 'drawer-top';
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'icon-btn';
  back.title = 'Close menu';
  back.setAttribute('aria-label', 'Close menu');
  back.textContent = '‹';
  back.addEventListener('click', () => closeDrawer());
  top.appendChild(back);

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'drawer-head';
  head.title = 'Your profile and settings';
  head.appendChild(avatarEl(me.id, me.displayName, 56, me.avatarUrl));
  const headText = document.createElement('div');
  headText.className = 'drawer-head-text';
  const name = document.createElement('div');
  name.className = 'drawer-name';
  name.textContent = me.displayName;
  const handle = document.createElement('div');
  handle.className = 'drawer-handle';
  handle.textContent = `@${me.username}`;
  headText.append(name, handle);
  head.appendChild(headText);
  head.addEventListener('click', () => {
    closeDrawer();
    openSettings();
  });

  const nav = document.createElement('nav');
  nav.className = 'drawer-nav';
  nav.append(
    navButton('New group', () => {
      closeDrawer();
      openCreateGroupModal();
    }),
    navButton('Settings', () => {
      closeDrawer();
      openSettings();
    }),
  );

  const foot = document.createElement('div');
  foot.className = 'drawer-foot';
  const logout = document.createElement('button');
  logout.type = 'button';
  logout.className = 'drawer-item danger';
  logout.textContent = 'Log out';
  logout.addEventListener('click', async () => {
    const ok = await confirmDialog('Log out?', 'You will need your password to sign back in.', 'Log out');
    if (!ok) return;
    closeDrawer();
    setToken(null);
    location.reload();
  });
  foot.appendChild(logout);

  panel.append(top, head, nav, foot);
  host.append(scrim, panel);

  // next frame so the transition runs
  requestAnimationFrame(() => {
    scrim?.classList.add('show');
    panel?.classList.add('show');
  });

  onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeDrawer();
    }
  };
  document.addEventListener('keydown', onKey);
}
