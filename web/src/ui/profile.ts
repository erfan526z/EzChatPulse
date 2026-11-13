import { api } from '../api';
import { store } from '../store';
import { openChat } from '../actions';
import { avatarEl, formatLastSeen } from './format';
import { openModal, toast } from './toast';

/**
 * A person's profile: picture, name, @username, bio and the groups you share.
 *
 * Server-side rule: you can only open the profile of someone you already share a
 * chat with (or anyone, if you are an admin) — so ids cannot be walked to harvest
 * names. A 403 is shown as a short explanation rather than silently failing.
 *
 * Rendered through the shared `openModal` helper: it adds the `.show` class that
 * makes `.modal-overlay` visible, wraps the content in `.modal-box` and handles
 * click-to-close.
 */
/** The profile currently on screen, so a second click cannot stack a new card on top. */
let closeActive: (() => void) | null = null;

export async function openProfile(userId: number): Promise<void> {
  closeActive?.();
  let data;
  try {
    data = await api.profile(userId);
  } catch (err) {
    const status = (err as { status?: number }).status;
    toast(
      status === 403 ? 'You can only view profiles of people you share a chat with' : 'Could not load that profile',
      'error',
    );
    return;
  }

  const { user, commonGroups } = data;
  const isMe = store.state.session?.user.id === user.id;

  const card = document.createElement('div');
  card.className = 'profile-card';

  // ── head: big avatar, name, handle, presence (the lab's centred block) ──
  const head = document.createElement('div');
  head.className = 'profile-head';
  const avatar = avatarEl(user.id, user.displayName, 84, user.avatarUrl);
  avatar.classList.add('profile-avatar');
  const nameEl = document.createElement('div');
  nameEl.className = 'profile-name';
  nameEl.textContent = user.displayName;
  const handle = document.createElement('div');
  handle.className = 'profile-handle';
  handle.textContent = `@${user.username}`;
  const presence = document.createElement('div');
  presence.className = 'profile-presence';
  presence.textContent = user.online ? 'online' : formatLastSeen(user.lastSeenAt);
  head.append(avatar, nameEl, handle, presence);
  card.appendChild(head);

  // ── fields: value above its label, as in the lab ──────────────────────
  const fieldGroup = (value: string, label: string): HTMLDivElement => {
    const g = document.createElement('div');
    g.className = 'profile-field';
    const v = document.createElement('div');
    v.className = 'profile-field-value';
    v.textContent = value;
    const l = document.createElement('div');
    l.className = 'profile-field-label';
    l.textContent = label;
    g.append(v, l);
    return g;
  };

  if (user.bio) card.appendChild(fieldGroup(user.bio, 'Bio'));
  card.appendChild(fieldGroup(`@${user.username}`, 'Username'));
  card.appendChild(fieldGroup(`member since ${new Date(user.createdAt).toLocaleDateString()}`, 'Joined'));

  if (!isMe) {
    const groupsTitle = document.createElement('div');
    groupsTitle.className = 'profile-section-title';
    groupsTitle.textContent = commonGroups.length ? 'Common groups' : 'No common groups';
    card.appendChild(groupsTitle);

    if (commonGroups.length) {
      const list = document.createElement('div');
      list.className = 'profile-groups';
      for (const g of commonGroups) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'profile-group';
        const gAvatar = avatarEl(g.id, g.name, 32);
        gAvatar.classList.add('group-avatar');
        const gName = document.createElement('span');
        gName.className = 'profile-group-name';
        gName.textContent = g.name;
        const chev = document.createElement('span');
        chev.className = 'profile-group-chev';
        chev.textContent = '›';
        row.append(gAvatar, gName, chev);
        row.addEventListener('click', () => {
          close();
          void openChat(g.id);
        });
        list.appendChild(row);
      }
      card.appendChild(list);
    }

    const actions = document.createElement('div');
    actions.className = 'profile-actions';
    const msgBtn = document.createElement('button');
    msgBtn.type = 'button';
    msgBtn.className = 'set-save';
    msgBtn.textContent = 'Message';
    msgBtn.addEventListener('click', async () => {
      try {
        const { chatId } = await api.createPrivate(user.id);
        close();
        await openChat(chatId);
      } catch {
        toast('Could not open that chat', 'error');
      }
    });
    actions.appendChild(msgBtn);
    card.appendChild(actions);
  }

  const dismiss = openModal(card);
  const close = (): void => {
    if (closeActive === close) closeActive = null;
    dismiss();
  };
  closeActive = close;

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', onKey);
    }
  };
  document.addEventListener('keydown', onKey);
}
