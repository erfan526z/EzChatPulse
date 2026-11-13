import { store } from '../store';
import { avatarEl, formatTime } from './format';
import { openCreateGroupModal, openNewChatModal } from './group';
import { openSettings } from './settings';
import { openDrawer } from './drawer';
import { api } from '../api';
import { toast } from './toast';
import type { UIChat, UIMessage, UserDTO } from '../types';

function previewText(m: UIMessage | null): string {
  if (!m) return 'No messages yet';
  if (m.kind === 'image') return '📷 Photo';
  if (m.kind === 'file') return `📎 ${m.file?.name ?? 'File'}`;
  return m.text ?? '';
}

export function mountSidebar(onSelect: (chatId: number) => void): void {
  const sidebar = document.querySelector<HTMLElement>('#sidebar')!;
  const list = document.querySelector('#chat-list')!;
  const drawerBtn = document.querySelector<HTMLButtonElement>('#btn-drawer')!;
  const meBtn = document.querySelector<HTMLButtonElement>('#btn-me')!;
  const connDot = document.querySelector<HTMLSpanElement>('#conn-dot')!;
  drawerBtn.addEventListener('click', () => openDrawer(sidebar));
  meBtn.addEventListener('click', () => openSettings());
  const search = document.querySelector<HTMLInputElement>('#sidebar-search')!;
  const newBtn = document.querySelector<HTMLButtonElement>('#btn-new')!;
  const newMenu = document.querySelector<HTMLDivElement>('#new-menu')!;
  const miNewChat = document.querySelector<HTMLButtonElement>('#mi-new-chat')!;
  const miNewGroup = document.querySelector<HTMLButtonElement>('#mi-new-group')!;
  let lastKey = '';
  let searching = false;

  let lastMeKey = '';

  function renderMe(): void {
    const session = store.state.session;
    if (!session) return;
    // the avatar only needs repainting when the picture or name changes
    const key = `${session.user.displayName}|${session.user.avatarUrl ?? ''}`;
    if (key !== lastMeKey) {
      lastMeKey = key;
      meBtn.innerHTML = '';
      meBtn.appendChild(avatarEl(session.user.id, session.user.displayName, 32, session.user.avatarUrl));
      meBtn.title = `${session.user.displayName} — settings`;
    }
    connDot.className = `conn-dot conn-${store.state.connection}`;
    connDot.title = `connection: ${store.state.connection}`;
  }

  function chatItem(chat: UIChat): HTMLElement {
    const el = document.createElement('div');
    el.className = 'chat-item' + (store.state.activeChatId === chat.id ? ' active' : '');
    const me = store.state.session?.user.id;
    const title = store.chatTitle(chat);

    const peer = chat.type === 'private' ? chat.members.find((m) => m.userId !== me) : undefined;
    const avatarId = peer?.userId ?? chat.id;
    const avatarName = chat.type === 'private' ? title : chat.name ?? 'G';
    const avatar = avatarEl(avatarId, avatarName, 46, peer?.avatarUrl);
    if (chat.type === 'group') avatar.classList.add('group-avatar');

    // presence dot for private chats
    if (chat.type === 'private') {
      const other = chat.members.find((m) => m.userId !== me);
      if (other) {
        const dot = document.createElement('span');
        dot.className = `presence-dot ${other.online ? 'online' : ''}`;
        avatar.appendChild(dot);
      }
    }
    el.appendChild(avatar);

    const body = document.createElement('div');
    body.className = 'chat-item-body';

    const top = document.createElement('div');
    top.className = 'chat-item-top';
    const nameEl = document.createElement('span');
    nameEl.className = 'chat-item-name';
    nameEl.textContent = title + (chat.type === 'group' ? ` · ${chat.members.length}` : '');
    const timeEl = document.createElement('span');
    timeEl.className = 'chat-item-time';
    timeEl.textContent = chat.lastMessage ? formatTime(chat.lastMessage.createdAt) : '';
    top.append(nameEl, timeEl);

    const bottom = document.createElement('div');
    bottom.className = 'chat-item-bottom';
    const preview = document.createElement('span');
    preview.className = 'chat-item-preview';
    const lm = chat.lastMessage;
    const prefix = lm && lm.senderId === me ? 'You: ' : '';
    preview.textContent = lm ? prefix + previewText(lm) : previewText(null);
    const unread = document.createElement('span');
    unread.className = 'unread-badge' + (chat.unread > 0 ? '' : ' hidden');
    unread.textContent = String(Math.min(chat.unread, 99));
    bottom.append(preview, unread);

    body.append(top, bottom);
    el.appendChild(body);
    el.addEventListener('click', () => onSelect(chat.id));
    return el;
  }

  function renderChats(): void {
    const chats = store.sortedChats();
    // activeChatId is part of the key so the .active highlight moves on switch
    const key =
      `active:${store.state.activeChatId}|` +
      chats
        .map(
          (c) =>
            `${c.id}:${c.lastMessage?.id ?? 0}:${c.unread}:${c.members
              // name + avatar belong in the key: a profile change from another
              // member must repaint the row, not just the header
              .map((m) => `${m.userId}:${m.displayName}:${m.avatarUrl ?? ''}${m.online ? '+on' : ''}`)
              .join(',')}`,
        )
        .join('|');
    if (key === lastKey) return;
    lastKey = key;
    list.innerHTML = '';
    if (chats.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'list-empty';
      hint.textContent = 'No chats yet — tap “＋” below to start one';
      list.appendChild(hint);
      return;
    }
    for (const chat of chats) list.appendChild(chatItem(chat));
  }

  /** One-tap "start chat" row shown in search results for unknown users. */
  function userResultRow(user: UserDTO): HTMLElement {
    const row = document.createElement('div');
    row.className = 'chat-item search-user';
    row.appendChild(avatarEl(user.id, user.displayName, 46, user.avatarUrl));
    const body = document.createElement('div');
    body.className = 'chat-item-body';
    const top = document.createElement('div');
    top.className = 'chat-item-top';
    const name = document.createElement('span');
    name.className = 'chat-item-name';
    name.textContent = user.displayName;
    const uname = document.createElement('span');
    uname.className = 'chat-item-time';
    uname.textContent = `@${user.username}`;
    top.append(name, uname);
    const bottom = document.createElement('div');
    bottom.className = 'chat-item-bottom';
    const prev = document.createElement('span');
    prev.className = 'chat-item-preview';
    prev.textContent = 'Start chat';
    bottom.appendChild(prev);
    body.append(top, bottom);
    row.appendChild(body);
    row.addEventListener('click', () => {
      void (async () => {
        try {
          const { chatId } = await api.createPrivate(user.id);
          search.value = '';
          searching = false;
          store.setActiveChat(chatId);
        } catch (err) {
          toast(err instanceof Error ? err.message : 'Failed to start chat', 'error');
        }
      })();
    });
    return row;
  }

  let searchDebounce: ReturnType<typeof setTimeout> | undefined;

  function doSearch(q: string): void {
    const me = store.state.session?.user.id;
    const ql = q.trim().toLowerCase();
    list.innerHTML = '';
    if (!ql) {
      searching = false;
      renderChats();
      return;
    }
    // chats matching the query (by title)
    const chats = store.sortedChats().filter((c) => store.chatTitle(c).toLowerCase().includes(ql));
    for (const c of chats) list.appendChild(chatItem(c));
    // users matching the query that we don't already have a private chat with
    void api
      .users(q.trim())
      .then(({ users }) => {
        if (search.value.trim().toLowerCase() !== ql) return; // stale result
        const have = new Set(
          chats.filter((c) => c.type === 'private').flatMap((c) => c.members.map((m) => m.userId)),
        );
        for (const user of users) {
          if (user.id === me || have.has(user.id)) continue;
          list.appendChild(userResultRow(user));
        }
      })
      .catch(() => {
        /* search is best-effort */
      });
  }

  search.addEventListener('input', () => {
    const q = search.value;
    if (!q.trim()) {
      searching = false;
      clearTimeout(searchDebounce);
      // the list currently shows search results; lastKey still matches the
      // pre-search render, so force a rebuild instead of early-returning
      lastKey = '';
      renderChats();
      return;
    }
    searching = true;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => doSearch(q), 200);
  });

  // ── “＋” menu: new chat / new group ──────────────────────────────────
  function toggleMenu(force?: boolean): void {
    const show = force ?? newMenu.classList.contains('hidden');
    newMenu.classList.toggle('hidden', !show);
  }
  newBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMenu();
  });
  miNewChat.addEventListener('click', () => {
    toggleMenu(false);
    openNewChatModal();
  });
  miNewGroup.addEventListener('click', () => {
    toggleMenu(false);
    openCreateGroupModal();
  });
  document.addEventListener('click', () => toggleMenu(false));

  store.subscribe(() => {
    renderMe();
    if (!searching) renderChats();
  });
  renderMe();
  renderChats();
}
