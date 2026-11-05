import { api } from '../api';
import { store } from '../store';
import { openModal, toast } from './toast';
import { avatarEl } from './format';

let closeCurrent: (() => void) | null = null;

function field(label: string, type: string, id: string, placeholder = ''): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'set-field';
  const l = document.createElement('label');
  l.textContent = label;
  l.setAttribute('for', id);
  const input = document.createElement('input');
  input.type = type;
  input.id = id;
  input.placeholder = placeholder;
  input.autocomplete = 'off';
  wrap.append(l, input);
  return wrap;
}

/** Settings modal: display name, password change, log out. */
export function openSettingsModal(): void {
  closeCurrent?.();
  const root = document.createElement('div');
  root.className = 'settings-modal';

  const title = document.createElement('h2');
  title.textContent = 'Settings';
  root.appendChild(title);

  // ── display name ──
  const nameHint = document.createElement('p');
  nameHint.className = 'set-hint';
  nameHint.textContent = 'Display name — shown to people you chat with.';
  const nameField = field('Display name', 'text', 'set-name');
  const nameInput = nameField.querySelector<HTMLInputElement>('#set-name')!;
  nameInput.value = store.state.session?.user.displayName ?? '';
  nameInput.maxLength = 32;
  const nameSave = document.createElement('button');
  nameSave.className = 'set-save';
  nameSave.textContent = 'Save name';
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
      toast('Display name updated', 'info');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Update failed', 'error');
    } finally {
      nameSave.disabled = false;
    }
  });
  const nameSection = document.createElement('section');
  nameSection.className = 'set-section';
  nameSection.append(nameHint, nameField, nameSave);
  root.appendChild(nameSection);

  // ── picture + bio ──
  const meUser = store.state.session?.user;
  const profileSection = document.createElement('section');
  profileSection.className = 'set-section';
  const profileHint = document.createElement('p');
  profileHint.className = 'set-hint';
  profileHint.textContent = 'Profile picture and bio — shown on your profile card.';
  profileSection.appendChild(profileHint);

  const avatarRow = document.createElement('div');
  avatarRow.className = 'set-avatar-row';
  const avatarBox = document.createElement('div');
  avatarBox.className = 'set-avatar';
  const paintAvatar = (): void => {
    const current = store.state.session?.user;
    avatarBox.innerHTML = '';
    if (current) avatarBox.appendChild(avatarEl(current.id, current.displayName, 64, current.avatarUrl));
    pickBtn.textContent = current?.avatarUrl ? 'Change picture' : 'Upload picture';
    removeBtn.style.display = current?.avatarUrl ? '' : 'none';
  };
  const avatarBtns = document.createElement('div');
  avatarBtns.className = 'set-avatar-btns';
  const pickBtn = document.createElement('button');
  pickBtn.className = 'set-save';
  pickBtn.textContent = meUser?.avatarUrl ? 'Change picture' : 'Upload picture';
  const removeBtn = document.createElement('button');
  removeBtn.className = 'set-save secondary';
  removeBtn.textContent = 'Remove picture';
  removeBtn.style.display = meUser?.avatarUrl ? '' : 'none';
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.hidden = true;

  pickBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    pickBtn.disabled = true;
    try {
      const uploaded = await api.upload(file);
      const { user } = await api.updateMe({ avatarFileId: uploaded.file.id });
      store.setUser(user);
      paintAvatar();
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
      paintAvatar();
      toast('Profile picture removed', 'info');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not remove the picture', 'error');
    } finally {
      removeBtn.disabled = false;
    }
  });

  avatarBtns.append(pickBtn, removeBtn, fileInput);
  avatarRow.append(avatarBox, avatarBtns);
  paintAvatar();
  profileSection.appendChild(avatarRow);

  const bioHint = document.createElement('p');
  bioHint.className = 'set-hint';
  bioHint.textContent = 'Bio — a short line about you (up to 200 characters).';
  const bioField = document.createElement('div');
  bioField.className = 'set-field';
  const bioLabel = document.createElement('label');
  bioLabel.textContent = 'Bio';
  bioLabel.htmlFor = 'set-bio';
  const bioInput = document.createElement('textarea');
  bioInput.id = 'set-bio';
  bioInput.rows = 3;
  bioInput.maxLength = 200;
  bioInput.value = meUser?.bio ?? '';
  bioField.append(bioLabel, bioInput);
  const bioSave = document.createElement('button');
  bioSave.className = 'set-save';
  bioSave.textContent = 'Save bio';
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
  profileSection.append(bioHint, bioField, bioSave);
  root.appendChild(profileSection);

  // ── email (set once — foundation for password reset later) ──
  const emailHint = document.createElement('p');
  emailHint.className = 'set-hint';
  emailHint.textContent =
    'Email — set once and it cannot be changed. Needed later for password reset.';
  const emailField = field('Email', 'email', 'set-email');
  const emailInput = emailField.querySelector<HTMLInputElement>('#set-email')!;
  const emailSave = document.createElement('button');
  emailSave.className = 'set-save';
  emailSave.textContent = 'Save email';
  const emailStatus = document.createElement('div');
  emailStatus.className = 'set-hint';
  const emailResend = document.createElement('button');
  emailResend.className = 'set-save';
  emailResend.textContent = 'Resend verification email';
  emailResend.style.display = 'none';
  emailResend.addEventListener('click', async () => {
    emailResend.disabled = true;
    try {
      const r = await api.resendVerification();
      toast(r.sent ? `Verification email sent to ${r.to}` : r.error ?? 'Could not send', r.sent ? 'info' : 'error');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not send', 'error');
    } finally {
      emailResend.disabled = false;
    }
  });
  const me = store.state.session?.user;
  if (me?.email) {
    emailInput.value = me.email;
    emailInput.disabled = true;
    emailSave.style.display = 'none';
    emailStatus.textContent = me.emailVerified ? '✓ verified' : 'not verified yet — check your inbox';
    if (!me.emailVerified) emailResend.style.display = '';
  } else {
    emailStatus.textContent = 'No email on file.';
  }
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
      toast('Email saved — check your inbox to confirm it', 'info');
      emailInput.disabled = true;
      emailSave.style.display = 'none';
      emailStatus.textContent = 'not verified yet — check your inbox';
      emailResend.style.display = '';
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Update failed', 'error');
    } finally {
      emailSave.disabled = false;
    }
  });
  const emailSection = document.createElement('section');
  emailSection.className = 'set-section';
  emailSection.append(emailHint, emailField, emailSave, emailStatus, emailResend);
  root.appendChild(emailSection);

  // ── password ──
  const pwHint = document.createElement('p');
  pwHint.className = 'set-hint';
  pwHint.textContent = 'Password — at least 8 characters.';
  const pwCurrent = field('Current password', 'password', 'set-pw-current');
  const pwNew = field('New password', 'password', 'set-pw-new');
  const pwConfirm = field('Confirm new password', 'password', 'set-pw-confirm');
  const pwSave = document.createElement('button');
  pwSave.className = 'set-save';
  pwSave.textContent = 'Change password';
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
      pwCurrent.querySelector<HTMLInputElement>('#set-pw-current')!.value = '';
      pwNew.querySelector<HTMLInputElement>('#set-pw-new')!.value = '';
      pwConfirm.querySelector<HTMLInputElement>('#set-pw-confirm')!.value = '';
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Update failed', 'error');
    } finally {
      pwSave.disabled = false;
    }
  });
  const pwSection = document.createElement('section');
  pwSection.className = 'set-section';
  pwSection.append(pwHint, pwCurrent, pwNew, pwConfirm, pwSave);
  root.appendChild(pwSection);

  // ── log out ──
  const logout = document.createElement('button');
  logout.className = 'set-logout';
  logout.textContent = 'Log out';
  logout.addEventListener('click', () => {
    closeCurrent?.();
    import('../api').then(({ setToken }) => {
      setToken(null);
      location.reload();
    });
  });
  root.appendChild(logout);

  closeCurrent = openModal(root);
}
