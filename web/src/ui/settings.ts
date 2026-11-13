import { api, setToken } from '../api';
import { store } from '../store';
import { toast } from './toast';
import { avatarEl } from './format';
import { ACCENT_PRESETS, applyAccent, applyTheme, currentTheme, accentPreset, type Theme } from './theme';

/**
 * Settings, as a screen rather than a dialog.
 *
 * One scrolling column on phones; a section nav beside the content once there is
 * room (the shell is laid out entirely in CSS). Sections: Profile, Appearance,
 * Account, and log out.
 */

let closeCurrent: (() => void) | null = null;

const SECTIONS = [
  { id: 'set-profile', label: 'Profile' },
  { id: 'set-appearance', label: 'Appearance' },
  { id: 'set-account', label: 'Account' },
] as const;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function field(labelText: string, type: string, id: string): HTMLDivElement {
  const wrap = el('div', 'set-field');
  const label = el('label', undefined, labelText);
  label.htmlFor = id;
  const input = el('input');
  input.type = type;
  input.id = id;
  input.autocomplete = 'off';
  wrap.append(label, input);
  return wrap;
}

function groupTitle(text: string): HTMLDivElement {
  return el('div', 'set-group-title', text);
}

function card(...children: HTMLElement[]): HTMLDivElement {
  const c = el('div', 'set-card');
  c.append(...children);
  return c;
}

/** A row: label (+ optional sub-label) on the left, control on the right. */
function row(labelText: string, sub: string | undefined, ...controls: HTMLElement[]): HTMLDivElement {
  const r = el('div', 'set-row');
  const text = el('div', 'set-row-text');
  text.append(el('div', 'label', labelText));
  if (sub) text.append(el('div', 'sub', sub));
  const side = el('div', 'set-row-side');
  side.append(...controls);
  r.append(text, side);
  return r;
}

function toggle(initial: boolean, onChange: (next: boolean) => void): HTMLButtonElement {
  const b = el('button', 'set-switch');
  b.type = 'button';
  b.setAttribute('role', 'switch');
  const paint = (on: boolean): void => {
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  };
  paint(initial);
  b.addEventListener('click', () => {
    const next = !b.classList.contains('on');
    paint(next);
    onChange(next);
  });
  return b;
}

function chevron(): HTMLSpanElement {
  return el('span', 'set-chev', '›');
}

/**
 * A settings row that opens something: label (+ sub) on the left, an optional
 * muted value and a chevron on the right. Rows live inside one card per section
 * and are separated by hairlines, as in the lab.
 */
function navRow(
  labelText: string,
  sub: string | undefined,
  onClick: () => void,
): { row: HTMLDivElement; value: HTMLSpanElement } {
  const r = el('div', 'set-row clickable');
  const text = el('div', 'set-row-text');
  text.append(el('div', 'label', labelText));
  if (sub) text.append(el('div', 'sub', sub));
  const side = el('div', 'set-row-side');
  const value = el('span', 'set-row-value', '');
  side.append(value, chevron());
  r.append(text, side);
  r.addEventListener('click', onClick);
  return { row: r, value };
}

/** Collapsible body under a row; the chevron turns to point down. */
function expando(): HTMLDivElement {
  const body = el('div', 'set-expand');
  body.append(el('div', 'set-expand-inner'));
  return body;
}

function toggleExpando(row: HTMLElement, body: HTMLElement): void {
  const open = body.classList.toggle('open');
  row.classList.toggle('open', open);
}

export function openSettings(): void {
  closeCurrent?.();
  const session = store.state.session;
  if (!session) return;

  const screen = el('div', 'settings-screen');
  screen.setAttribute('role', 'dialog');
  screen.setAttribute('aria-label', 'Settings');

  // ── top bar ───────────────────────────────────────────────────────────
  const top = el('header', 'screen-top');
  const back = el('button', 'icon-btn');
  back.type = 'button';
  back.title = 'Back';
  back.setAttribute('aria-label', 'Back');
  back.textContent = '‹';
  back.addEventListener('click', () => closeCurrent?.());
  top.append(back, el('h1', 'screen-title', 'Settings'));

  // ── shell: nav + scrolling content ────────────────────────────────────
  const shell = el('div', 'set-shell');
  const nav = el('nav', 'set-nav');
  const scroller = el('div', 'set-scroll');

  const navItems = SECTIONS.map((s) => {
    const a = el('button', 'set-nav-item');
    a.type = 'button';
    a.dataset.target = s.id;
    a.textContent = s.label;
    a.addEventListener('click', () => {
      const target = document.getElementById(s.id);
      if (!target) return;
      for (const other of navItems) other.classList.toggle('on', other === a);
      const delta = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTo({ top: scroller.scrollTop + delta - 8, behavior: 'smooth' });
    });
    nav.appendChild(a);
    return a;
  });

  // mark the section under the reading band
  const markActive = (): void => {
    // a tight line under the top bar, with one exception: at the very bottom the
    // last section is what you are reading, even if it cannot reach the top
    const edge = scroller.getBoundingClientRect().top + 24;
    const scrollable = scroller.scrollHeight > scroller.clientHeight + 8;
    const atBottom = scrollable && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
    let current: string = SECTIONS[0].id;
    for (const s of SECTIONS) {
      const node = document.getElementById(s.id);
      if (node && node.getBoundingClientRect().top <= edge) current = s.id;
    }
    if (atBottom) current = SECTIONS[SECTIONS.length - 1]?.id ?? current;
    for (const a of navItems) a.classList.toggle('on', a.dataset.target === current);
  };
  scroller.addEventListener('scroll', markActive, { passive: true });

  // ── Profile ───────────────────────────────────────────────────────────
  const profileSection = el('section');
  profileSection.id = 'set-profile';
  const profileRow = el('div', 'set-profile');
  const avatarBox = el('div', 'set-avatar');
  const profileText = el('div', 'set-profile-text');
  const profileName = el('div', 'set-profile-name');
  const profileHandle = el('div', 'set-profile-handle');
  profileText.append(profileName, profileHandle);
  const editSide = el('div', 'set-row-side');
  const editLabel = el('span', 'set-link', 'Edit');
  editSide.append(editLabel, chevron());
  profileRow.append(avatarBox, profileText, editSide);

  const details = el('div', 'set-details');
  const detailsHidden = el('div', 'set-details-body');

  const nameField = field('Display name', 'text', 'set-name');
  const nameInput = nameField.querySelector<HTMLInputElement>('#set-name')!;
  nameInput.maxLength = 32;
  const nameSave = el('button', 'set-save', 'Save name');
  nameSave.addEventListener('click', async () => {
    const displayName = nameInput.value.trim();
    if (!displayName) {
      toast('Display name cannot be empty', 'error');
      return;
    }
    nameSave.disabled = true;
    try {
      const { user } = await api.updateMe({ displayName });
      store.setUser(user);
      paintProfile();
      toast('Display name updated', 'info');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Update failed', 'error');
    } finally {
      nameSave.disabled = false;
    }
  });

  const avatarRow = el('div', 'set-avatar-row');
  const pickBtn = el('button', 'set-save secondary', 'Change picture');
  const removeBtn = el('button', 'set-save secondary', 'Remove picture');
  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.hidden = true;
  const avatarBtns = el('div', 'set-avatar-btns');
  avatarBtns.append(pickBtn, removeBtn);

  pickBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    pickBtn.disabled = true;
    try {
      const uploaded = await api.upload(file);
      const { user } = await api.updateMe({ avatarFileId: uploaded.file.id });
      store.setUser(user);
      paintProfile();
      toast('Profile picture updated', 'info');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Upload failed', 'error');
    } finally {
      pickBtn.disabled = false;
      fileInput.value = '';
    }
  });
  removeBtn.addEventListener('click', async () => {
    removeBtn.disabled = true;
    try {
      const { user } = await api.updateMe({ avatarFileId: null });
      store.setUser(user);
      paintProfile();
      toast('Profile picture removed', 'info');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not remove the picture', 'error');
    } finally {
      removeBtn.disabled = false;
    }
  });

  const bioField = el('div', 'set-field');
  const bioLabel = el('label', undefined, 'Bio');
  bioLabel.htmlFor = 'set-bio';
  const bioInput = el('textarea');
  bioInput.id = 'set-bio';
  bioInput.rows = 3;
  bioInput.maxLength = 200;
  bioField.append(bioLabel, bioInput);
  const bioSave = el('button', 'set-save', 'Save bio');
  bioSave.addEventListener('click', async () => {
    bioSave.disabled = true;
    try {
      const { user } = await api.updateMe({ bio: bioInput.value });
      store.setUser(user);
      toast('Bio updated', 'info');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Update failed', 'error');
    } finally {
      bioSave.disabled = false;
    }
  });

  avatarRow.append(fileInput);
  detailsHidden.append(nameField, nameSave, avatarRow, avatarBtns, bioField, bioSave);
  details.append(detailsHidden);
  profileRow.addEventListener('click', () => {
    const open = details.classList.toggle('open');
    profileRow.classList.toggle('open', open);
    editLabel.textContent = open ? 'Done' : 'Edit';
  });
  profileSection.append(profileRow, details);

  function paintProfile(): void {
    const me = store.state.session?.user;
    if (!me) return;
    avatarBox.innerHTML = '';
    avatarBox.appendChild(avatarEl(me.id, me.displayName, 56, me.avatarUrl));
    const dot = el('span', `presence-dot ${me.online ? 'online' : ''}`);
    avatarBox.appendChild(dot);
    profileName.textContent = me.displayName;
    profileHandle.textContent = `@${me.username}`;
    if (!nameInput.value) nameInput.value = me.displayName;
    if (!bioInput.value) bioInput.value = me.bio ?? '';
    pickBtn.textContent = me.avatarUrl ? 'Change picture' : 'Upload picture';
    removeBtn.style.display = me.avatarUrl ? '' : 'none';
  }

  // ── Appearance ────────────────────────────────────────────────────────
  const appearanceSection = el('section');
  appearanceSection.id = 'set-appearance';

  const themeRow = el('div', 'set-row');
  const themeText = el('div', 'set-row-text');
  themeText.append(el('div', 'label', 'Theme'));
  const themeSide = el('div', 'set-row-side');
  const themeChips = el('div', 'set-chips');
  const chipDark = el('button', 'set-chip', 'Dark');
  const chipLight = el('button', 'set-chip', 'Light');
  chipDark.type = 'button';
  chipLight.type = 'button';
  const paintTheme = (theme: Theme): void => {
    chipDark.classList.toggle('on', theme === 'dark');
    chipLight.classList.toggle('on', theme === 'light');
  };
  chipDark.addEventListener('click', () => {
    applyTheme('dark');
    paintTheme('dark');
  });
  chipLight.addEventListener('click', () => {
    applyTheme('light');
    paintTheme('light');
  });
  paintTheme(currentTheme());
  themeChips.append(chipDark, chipLight);
  themeSide.append(themeChips);
  themeRow.append(themeText, themeSide);

  const accentRow = el('div', 'set-row stack');
  const accentText = el('div', 'set-row-text');
  accentText.append(el('div', 'label', 'Accent'), el('div', 'sub', 'A colour, or a gradient'));
  const swatches = el('div', 'set-swatches');
  const accentNote = el('div', 'set-hint', '');

  const currentAccent = (): string | null => store.state.session?.user.accent ?? null;

  const paintSwatches = (activeId?: string | null): void => {
    // explicit id wins: the click has already applied the new accent, and the
    // account round-trip has not landed yet
    const active = activeId === undefined ? accentPreset(currentAccent()).id : activeId ?? '';
    for (const btn of swatches.querySelectorAll<HTMLButtonElement>('.set-swatch')) {
      btn.classList.toggle('on', btn.dataset.accent === active);
      btn.setAttribute('aria-pressed', String(btn.dataset.accent === active));
    }
  };

  for (const preset of ACCENT_PRESETS) {
    const b = el('button', 'set-swatch');
    b.type = 'button';
    b.dataset.accent = preset.id;
    b.title = preset.label;
    b.setAttribute('aria-label', preset.label);
    b.style.background = preset.gradient ?? preset.css;
    b.addEventListener('click', () => {
      // apply immediately so the whole screen responds, then persist
      applyAccent(preset.id);
      paintSwatches(preset.id);
      void (async () => {
        try {
          const { user } = await api.updateMe({ accent: preset.id });
          store.setUser(user);
          paintSwatches(user.accent ?? null);
          accentNote.textContent = '';
        } catch (err) {
          accentNote.textContent = err instanceof Error ? err.message : 'Could not save the accent';
        }
      })();
    });
    swatches.appendChild(b);
  }
  accentRow.append(accentText, swatches);

  appearanceSection.append(groupTitle('Appearance'), card(themeRow, accentRow), accentNote);

  // ── Account ───────────────────────────────────────────────────────────
  const accountSection = el('section');
  accountSection.id = 'set-account';

  const emailInput = el('input');
  emailInput.type = 'email';
  emailInput.id = 'set-email';
  emailInput.autocomplete = 'off';
  emailInput.placeholder = 'you@example.com';

  const emailField = el('div', 'set-field');
  emailField.append(emailInput);

  const emailSave = el('button', 'set-save', 'Save email');
  const emailStatus = el('div', 'set-hint', '');
  const emailResend = el('button', 'set-link', 'Resend verification');
  emailResend.style.display = 'none';

  const emailBody = expando();
  (emailBody.firstElementChild as HTMLElement).append(emailField, emailSave, emailStatus, emailResend);

  const emailRow = navRow('Email', 'Not set', () => toggleExpando(emailRow.row, emailBody));
  const emailSub = emailRow.row.querySelector<HTMLElement>('.set-row-text .sub')!;

  const paintEmail = (): void => {
    const me = store.state.session?.user;
    if (!me) return;
    if (me.email) {
      emailInput.value = me.email;
      emailInput.disabled = true;
      emailSave.style.display = 'none';
      emailSub.textContent = `${me.email} — ${me.emailVerified ? 'verified' : 'not confirmed'}`;
      emailRow.value.textContent = '';
      emailStatus.textContent = me.emailVerified
        ? '✓ verified'
        : 'Not verified yet — check your inbox.';
      emailResend.style.display = me.emailVerified ? 'none' : '';
    } else {
      emailSub.textContent = 'No email on file';
      emailRow.value.textContent = '';
      emailStatus.textContent = 'No email on file — adding one is needed for password reset.';
      emailResend.style.display = 'none';
    }
  };

  emailSave.addEventListener('click', async () => {
    const email = emailInput.value.trim();
    if (!email) {
      toast('Enter an email address', 'error');
      return;
    }
    emailSave.disabled = true;
    try {
      const { user } = await api.updateMe({ email });
      store.setUser(user);
      paintEmail();
      toast('Email saved — check your inbox to confirm it', 'info');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Update failed', 'error');
    } finally {
      emailSave.disabled = false;
    }
  });
  emailResend.addEventListener('click', async () => {
    emailResend.setAttribute('disabled', '');
    try {
      const r = await api.resendVerification();
      toast(r.sent ? `Verification email sent to ${r.to}` : r.error ?? 'Could not send', r.sent ? 'info' : 'error');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not send', 'error');
    } finally {
      emailResend.removeAttribute('disabled');
    }
  });

  const pwCurrent = field('Current password', 'password', 'set-pw-current');
  const pwNew = field('New password', 'password', 'set-pw-new');
  const pwConfirm = field('Confirm new password', 'password', 'set-pw-confirm');
  const pwSave = el('button', 'set-save', 'Change password');
  pwSave.addEventListener('click', async () => {
    const current = pwCurrent.querySelector<HTMLInputElement>('#set-pw-current')!.value;
    const next = pwNew.querySelector<HTMLInputElement>('#set-pw-new')!.value;
    const confirm = pwConfirm.querySelector<HTMLInputElement>('#set-pw-confirm')!.value;
    if (!current) {
      toast('Enter your current password', 'error');
      return;
    }
    if (next.length < 8) {
      toast('New password must be at least 8 characters', 'error');
      return;
    }
    if (next !== confirm) {
      toast('Passwords do not match', 'error');
      return;
    }
    pwSave.disabled = true;
    try {
      await api.updateMe({ currentPassword: current, newPassword: next });
      toast('Password changed', 'info');
      pwNew.querySelector<HTMLInputElement>('#set-pw-new')!.value = '';
      pwConfirm.querySelector<HTMLInputElement>('#set-pw-confirm')!.value = '';
      pwCurrent.querySelector<HTMLInputElement>('#set-pw-current')!.value = '';
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Update failed', 'error');
    } finally {
      pwSave.disabled = false;
    }
  });

  const pwBody = expando();
  (pwBody.firstElementChild as HTMLElement).append(pwCurrent, pwNew, pwConfirm, pwSave);
  const pwRow = navRow('Change password', 'At least 8 characters', () => toggleExpando(pwRow.row, pwBody));

  // ── log out: last row of the account card ─────────────────────────────
  const logoutRow = el('button', 'set-row clickable danger');
  logoutRow.type = 'button';
  const logoutText = el('div', 'set-row-text');
  logoutText.append(el('div', 'label', 'Log out'));
  logoutRow.append(logoutText);
  logoutRow.addEventListener('click', () => {
    closeCurrent?.();
    setToken(null);
    location.reload();
  });

  accountSection.append(
    groupTitle('Account'),
    card(emailRow.row, emailBody, pwRow.row, pwBody, logoutRow),
  );

  scroller.append(profileSection, appearanceSection, accountSection);
  shell.append(nav, scroller);
  screen.append(top, shell);

  // ── mount ─────────────────────────────────────────────────────────────
  document.body.appendChild(screen);
  requestAnimationFrame(() => screen.classList.add('show'));
  paintProfile();
  paintSwatches();
  paintEmail();
  requestAnimationFrame(markActive);

  // toggles for the shell's "message text" style rows are not part of this
  // screen yet — only real, persisted preferences live here.

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  function close(): void {
    document.removeEventListener('keydown', onKey);
    screen.classList.remove('show');
    window.setTimeout(() => screen.remove(), 200);
    closeCurrent = null;
  }
  document.addEventListener('keydown', onKey);
  closeCurrent = close;
}

// theme.ts exports a preset lookup the settings screen needs for the swatch ring
export { accentPreset };
