import { api } from '../api';
import { store } from '../store';
import { openChat } from '../actions';
import { avatarEl, formatLastSeen } from './format';
import { toast } from './toast';

/**
 * A person's profile: picture, name, @username, bio and the groups you share.
 *
 * Server-side rule: you can only open the profile of someone you already share a
 * chat with (or anyone, if you are an admin) — so ids cannot be walked to harvest
 * names. A 403 is shown as a short explanation rather than silently failing.
 */
export async function openProfile(userId: number): Promise<void> {
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

  const root = document.createElement('div');
  root.className = 'profile-card';

  const head = document.createElement('div');
  head.className = 'profile-head';
  const avatar = avatarEl(user.id, user.displayName, 96, user.avatarUrl);
  avatar.classList.add('profile-avatar');
  const headText = document.createElement('div');
  headText.className = 'profile-head-text';
  const nameEl = document.createElement('div');
  nameEl.className = 'profile-name';
  nameEl.textContent = user.displayName;
  const handle = document.createElement('div');
  handle.className = 'profile-handle';
  handle.textContent = `@${user.username}`;
  const presence = document.createElement('div');
  presence.className = 'profile-presence';
  presence.textContent = user.online ? 'online' : formatLastSeen(user.lastSeenAt);
  headText.append(nameEl, handle, presence);
  head.append(avatar, headText);
  root.appendChild(head);

  if (user.bio) {
    const bio = document.createElement('p');
    bio.className = 'profile-bio';
    bio.textContent = user.bio;
    root.appendChild(bio);
  }

  const meta = document.createElement('div');
  meta.className = 'profile-meta';
  meta.textContent = `member since ${new Date(user.createdAt).toLocaleDateString()}`;
  root.appendChild(meta);

  if (!isMe) {
    const groupsTitle = document.createElement('div');
    groupsTitle.className = 'profile-section-title';
    groupsTitle.textContent = commonGroups.length
      ? `Common groups · ${commonGroups.length}`
      : 'No common groups';
    root.appendChild(groupsTitle);

    if (commonGroups.length) {
      const list = document.createElement('div');
      list.className = 'profile-groups';
      for (const g of commonGroups) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'profile-group';
        row.textContent = g.name;
        row.addEventListener('click', () => {
          close();
          void openChat(g.id);
        });
        list.appendChild(row);
      }
      root.appendChild(list);
    }

    const actions = document.createElement('div');
    actions.className = 'profile-actions';
    const msgBtn = document.createElement('button');
    msgBtn.type = 'button';
    msgBtn.className = 'primary-btn';
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
    root.appendChild(actions);
  }

  function close(): void {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') close();
  }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.appendChild(root);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onKey);
  document.querySelector('#modal-root')!.appendChild(overlay);
}
