import { api, authedFileUrl } from '../api';
import { store } from '../store';
import { socket } from '../ws';
import { loadMore } from '../actions';
import { avatarEl, formatTime, formatLastSeen, formatBytes, isImageMime } from './format';
import { openModal, toast, confirmDialog } from './toast';
import { mountEmojiPanel } from './emoji-panel';
import type { UIChat, UIMessage, MemberInfo } from '../types';

let currentChatId: number | null = null;
let atBottom = true;
let lastTypingSent = 0;

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

/** Stable DOM key for a message row (tempId for optimistic sends, else server id). */
const keyOf = (m: UIMessage): string => (m.tempId ? `t:${m.tempId}` : `m:${m.id}`);

export function mountChatPane(): void {
  const headerEl = $('#chat-header');
  const messagesEl = $('#messages');
  const typingBar = $('#typing-bar');
  const composerEl = $('#composer');
  const emptyState = $('#empty-state');
  const chatPane = $('#chat-pane');

  // ── header ────────────────────────────────────────────────────────────
  function subtitle(chat: UIChat): string {
    if (chat.type === 'group') {
      const onlineCount = chat.members.filter((m) => m.online).length;
      return `${chat.members.length} members · ${onlineCount} online`;
    }
    const me = store.state.session?.user.id;
    const other = chat.members.find((m) => m.userId !== me);
    if (!other) return '';
    return other.online ? 'online' : formatLastSeen(other.lastSeenAt);
  }

  function renderHeader(chat: UIChat): void {
    headerEl.innerHTML = '';
    const back = document.createElement('button');
    back.className = 'icon-btn back-btn';
    back.title = 'Back';
    back.textContent = '‹';
    back.addEventListener('click', () => store.setActiveChat(null));
    headerEl.appendChild(back);

    const avatarId =
      chat.type === 'private'
        ? (chat.members.find((m) => m.userId !== store.state.session?.user.id)?.userId ?? chat.id)
        : chat.id;
    const avatar = avatarEl(avatarId, store.chatTitle(chat), 40);
    if (chat.type === 'group') avatar.classList.add('group-avatar');
    headerEl.appendChild(avatar);

    const info = document.createElement('div');
    info.className = 'chat-header-info';
    const name = document.createElement('div');
    name.className = 'chat-header-name';
    name.textContent = store.chatTitle(chat);
    const sub = document.createElement('div');
    sub.className = 'chat-header-sub';
    sub.id = 'chat-header-sub';
    sub.textContent = subtitle(chat);
    info.append(name, sub);
    headerEl.appendChild(info);

    if (chat.type === 'group') {
      const btn = document.createElement('button');
      btn.className = 'icon-btn';
      btn.title = 'Members';
      btn.textContent = '👥';
      btn.addEventListener('click', () => openMembersModal(chat));
      headerEl.appendChild(btn);
    }
  }

  function updateHeaderSub(chat: UIChat): void {
    const sub = document.querySelector('#chat-header-sub');
    if (sub) sub.textContent = subtitle(chat);
  }

  // ── message nodes ─────────────────────────────────────────────────────
  function isMine(msg: UIMessage): boolean {
    return msg.senderId === store.state.session?.user.id;
  }

  function dayKey(ts: number): string {
    return new Date(ts).toDateString();
  }

  function dayLabel(ts: number): string {
    return new Date(ts).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  }

  function bubbleContent(msg: UIMessage): HTMLElement {
    const content = document.createElement('div');
    content.className = 'msg-content';
    content.setAttribute('dir', 'auto'); // RTL-aware bubbles (Persian etc.)
    if (msg.deletedAt) {
      content.classList.add('msg-deleted');
      content.removeAttribute('dir');
      content.textContent = 'This message was deleted';
      return content;
    }
    if (msg.kind === 'text') {
      content.textContent = msg.text ?? '';
    } else if (msg.kind === 'image' && msg.file) {
      const img = document.createElement('img');
      img.src = msg.file.url;
      img.alt = msg.file.name;
      img.loading = 'lazy';
      img.addEventListener('click', () => openLightbox(msg.file!.url, msg.file!.name));
      void authedFileUrl(msg.file.url)
        .then((u) => {
          img.src = u;
        })
        .catch(() => {
          img.classList.add('img-error');
          img.title = 'Failed to load image';
        });
      content.appendChild(img);
      if (msg.text) {
        const cap = document.createElement('div');
        cap.className = 'msg-caption';
        cap.textContent = msg.text;
        content.appendChild(cap);
      }
    } else if (msg.file) {
      const row = document.createElement('div');
      row.className = 'file-row';
      row.innerHTML = `<span class="file-icon">📎</span>`;
      const meta = document.createElement('div');
      meta.className = 'file-meta';
      const fname = document.createElement('div');
      fname.className = 'file-name';
      fname.textContent = msg.file.name;
      const fsize = document.createElement('div');
      fsize.className = 'file-size';
      fsize.textContent = formatBytes(msg.file.size);
      meta.append(fname, fsize);
      const dl = document.createElement('a');
      dl.className = 'file-dl';
      dl.textContent = '⬇';
      dl.href = msg.file.url;
      dl.title = 'Download';
      dl.addEventListener('click', async (e) => {
        e.preventDefault();
        try {
          const u = await authedFileUrl(msg.file!.url);
          const a = document.createElement('a');
          a.href = u;
          a.download = msg.file!.name;
          a.click();
        } catch {
          toast('Download failed', 'error');
        }
      });
      row.append(meta, dl);
      content.appendChild(row);
      if (msg.text) {
        const cap = document.createElement('div');
        cap.className = 'msg-caption';
        cap.textContent = msg.text;
        content.appendChild(cap);
      }
    }
    return content;
  }

  function makeMessageNode(chat: UIChat, msg: UIMessage): HTMLElement {
    const mine = isMine(msg);
    const row = document.createElement('div');
    row.className = `msg-row ${mine ? 'mine' : 'theirs'}`;
    row.dataset.key = msg.tempId ? `t:${msg.tempId}` : `m:${msg.id}`;
    if (msg.pending) row.classList.add('pending');
    if (msg.failed) row.classList.add('failed');

    if (!mine && chat.type === 'group') {
      const sender = chat.members.find((m) => m.userId === msg.senderId);
      row.appendChild(avatarEl(msg.senderId, sender?.displayName ?? '?', 34));
    }

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    if (!mine && chat.type === 'group') {
      const senderName = document.createElement('div');
      senderName.className = 'msg-sender';
      const sender = chat.members.find((m) => m.userId === msg.senderId);
      senderName.textContent = sender?.displayName ?? `user ${msg.senderId}`;
      bubble.appendChild(senderName);
    }
    bubble.appendChild(bubbleContent(msg));

    // reply quote: preview of the original message, click → scroll to it
    if (msg.replyTo) {
      const target = chat.messages.find((m) => m.id === msg.replyTo);
      const quote = document.createElement('div');
      quote.className = 'msg-quote';
      if (target) {
        const qSender = document.createElement('div');
        qSender.className = 'msg-quote-sender';
        qSender.textContent =
          chat.members.find((m) => m.userId === target.senderId)?.displayName ?? `user ${target.senderId}`;
        const qText = document.createElement('div');
        qText.className = 'msg-quote-text';
        qText.textContent = previewOf(target);
        quote.append(qSender, qText);
        quote.addEventListener('click', (e) => {
          e.stopPropagation();
          const row = messagesEl.querySelector<HTMLElement>(`.msg-row[data-key="m:${target.id}"]`);
          if (!row) return;
          row.scrollIntoView({ behavior: 'smooth', block: 'center' });
          row.classList.add('flash');
          setTimeout(() => row.classList.remove('flash'), 1600);
        });
      } else {
        quote.classList.add('msg-quote-gone');
        quote.textContent = 'Original message';
      }
      bubble.insertBefore(quote, bubble.querySelector('.msg-content'));
    }

    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    const time = document.createElement('span');
    time.className = 'msg-time';
    time.textContent = formatTime(msg.createdAt);
    meta.appendChild(time);
    if (msg.editedAt) {
      const edited = document.createElement('span');
      edited.className = 'msg-edited';
      edited.textContent = 'edited';
      meta.appendChild(edited);
    }
    if (mine) {
      const ticks = document.createElement('span');
      ticks.className = 'msg-ticks';
      ticks.textContent = msg.pending ? '…' : msg.failed ? '!' : '✓';
      ticks.title = msg.failed ? 'Not delivered — click to retry' : 'Sent';
      meta.appendChild(ticks);
    }
    bubble.appendChild(meta);
    row.appendChild(bubble);

    // right-click (desktop) opens the message menu at the cursor
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openMessageMenu(chat, msg, row, e.clientX, e.clientY);
    });

    // single tap (mobile) opens the menu too — but only for a real tap:
    // short duration + negligible movement, so scrolling/dragging never triggers it
    let tStartX = 0;
    let tStartY = 0;
    let tStartT = 0;
    row.addEventListener(
      'touchstart',
      (e) => {
        const t = e.touches[0]!;
        tStartX = t.clientX;
        tStartY = t.clientY;
        tStartT = Date.now();
      },
      { passive: true },
    );
    row.addEventListener('touchend', (e) => {
      const t = e.changedTouches[0]!;
      const dt = Date.now() - tStartT;
      if (msg.failed) return; // tap on a failed message = retry
      if (dt > 400 || Math.hypot(t.clientX - tStartX, t.clientY - tStartY) > 10) return;
      const target = e.target as HTMLElement;
      // don't hijack taps on images (lightbox) or download links
      if (target.closest('.msg-content img, .file-dl, a, .edit-input, .ctx-menu')) return;
      e.preventDefault();
      const rect = row.getBoundingClientRect();
      openMessageMenu(chat, msg, row, rect.left + rect.width / 2, rect.top);
    });

    row.dataset.rev = String(msg.rev ?? 0);

    if (msg.failed) {
      row.addEventListener('click', () => {
        if (!msg.tempId) return;
        store.setMessageFailed(chat.id, msg.tempId); // clears failed flag? no — re-send below
        sendText(chat.id, msg.text ?? '', msg.tempId);
      });
    }
    return row;
  }

  function refreshTicks(): void {
    const chat = store.activeChat();
    if (!chat) return;
    const me = store.state.session?.user.id;
    const maxRead = Math.max(0, ...[...chat.readBy.entries()].filter(([uid]) => uid !== me).map(([, v]) => v));
    const mine = messagesEl.querySelectorAll('.msg-row.mine');
    for (const row of mine) {
      const key = (row as HTMLElement).dataset.key ?? '';
      // Resolve the message from the store, not by parsing the DOM key: rows of
      // optimistic sends keep a `t:<tempId>` key after ack, so id can't be
      // derived from the key itself.
      const storeMsg = chat.messages.find((m) => (m.tempId ? `t:${m.tempId}` : `m:${m.id}`) === key);
      if (!storeMsg) continue;
      const ticks = row.querySelector<HTMLElement>('.msg-ticks');
      if (!ticks) continue;
      if (row.classList.contains('pending')) ticks.textContent = '…';
      else if (row.classList.contains('failed')) ticks.textContent = '!';
      else ticks.textContent = storeMsg.id > 0 && maxRead >= storeMsg.id ? '✓✓' : '✓';
    }
  }

  // ── edit & delete ─────────────────────────────────────────────────────
  let editingKey: string | null = null;

  /** Rebuild one row from its store message (used to cancel an edit). */
  function rebuildRow(chat: UIChat, msg: UIMessage): void {
    const el = messagesEl.querySelector<HTMLElement>(`.msg-row[data-key="${CSS.escape(keyOf(msg))}"]`);
    if (!el) return;
    el.replaceWith(makeMessageNode(chat, msg));
  }

  function beginEdit(chat: UIChat, msg: UIMessage, row: HTMLElement): void {
    const bubble = row.querySelector<HTMLElement>('.msg-bubble');
    if (!bubble) return;
    editingKey = keyOf(msg);
    messagesEl.querySelectorAll<HTMLElement>('.msg-row.show-actions').forEach((r) => r.classList.remove('show-actions'));
    bubble.innerHTML = '';
    const ta = document.createElement('textarea');
    ta.className = 'edit-input';
    ta.value = msg.text ?? '';
    ta.maxLength = 4096;
    ta.dir = 'auto';
    const bar = document.createElement('div');
    bar.className = 'edit-bar';
    const save = document.createElement('button');
    save.className = 'edit-save';
    save.textContent = 'Save';
    const cancel = document.createElement('button');
    cancel.className = 'edit-cancel';
    cancel.textContent = 'Cancel';
    bar.append(save, cancel);
    bubble.append(ta, bar);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    const finish = (): void => {
      editingKey = null;
    };
    save.addEventListener('click', (e) => {
      e.stopPropagation();
      const text = ta.value.trim();
      if (!text) return;
      finish();
      socket.send({ t: 'msg.edit', cid: chat.id, msgId: msg.id, text });
    });
    cancel.addEventListener('click', (e) => {
      e.stopPropagation();
      finish();
      rebuildRow(chat, msg);
    });
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const text = ta.value.trim();
        if (!text) return;
        finish();
        socket.send({ t: 'msg.edit', cid: chat.id, msgId: msg.id, text });
      } else if (e.key === 'Escape') {
        finish();
        rebuildRow(chat, msg);
      }
    });
  }

  // ── message context menu ──────────────────────────────────────────────
  let menuOpenCleanup: (() => void) | null = null;

  function closeMessageMenu(): void {
    menuOpenCleanup?.();
    menuOpenCleanup = null;
  }

  function menuItem(label: string, danger: boolean, onPick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = danger ? 'ctx-item danger' : 'ctx-item';
    b.textContent = label;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onPick();
    });
    return b;
  }

  /** Confirm before a destructive delete (misclick protection). */
  function confirmDelete(chat: UIChat, msg: UIMessage, mode: 'me' | 'everyone'): void {
    const root = document.createElement('div');
    root.className = 'confirm-modal';
    const title = document.createElement('h2');
    title.textContent = mode === 'everyone' ? 'Delete for everyone?' : 'Delete for me?';
    const body = document.createElement('p');
    body.textContent =
      mode === 'everyone'
        ? 'This removes the message for all members and cannot be undone.'
        : 'The message will be hidden from your view only. This cannot be undone.';
    const actions = document.createElement('div');
    actions.className = 'confirm-actions';
    const cancel = document.createElement('button');
    cancel.className = 'confirm-cancel';
    cancel.textContent = 'Cancel';
    const del = document.createElement('button');
    del.className = 'confirm-delete';
    del.textContent = 'Delete';
    const close = openModal(root);
    cancel.addEventListener('click', close);
    del.addEventListener('click', () => {
      close();
      socket.send({ t: 'msg.delete', cid: chat.id, msgId: msg.id, mode });
    });
    actions.append(cancel, del);
    root.append(title, body, actions);
  }

  /** Open the per-message menu (Reply / Edit / Delete for me / Delete for everyone). */
  function openMessageMenu(chat: UIChat, msg: UIMessage, row: HTMLElement, x: number, y: number): void {
    closeMessageMenu();
    const mine = isMine(msg);
    const me = store.state.session?.user.id;
    const myRole = chat.members.find((m) => m.userId === me)?.role;
    const isAdmin = chat.type === 'group' && myRole === 'admin';
    const canEdit = mine && msg.kind === 'text' && !msg.deletedAt && !msg.pending;

    const menu = document.createElement('div');
    menu.className = 'ctx-menu';
    menu.appendChild(
      menuItem('↩ Reply', false, () => {
        closeMessageMenu();
        setReplyingTo(msg);
        input.focus();
      }),
    );
    if (canEdit) {
      menu.appendChild(
        menuItem('✎ Edit', false, () => {
          closeMessageMenu();
          beginEdit(chat, msg, row);
        }),
      );
    }
    menu.appendChild(
      menuItem('🗑 Delete for me', false, () => {
        closeMessageMenu();
        confirmDelete(chat, msg, 'me');
      }),
    );
    if (mine || isAdmin) {
      menu.appendChild(
        menuItem('🗑 Delete for everyone', true, () => {
          closeMessageMenu();
          confirmDelete(chat, msg, 'everyone');
        }),
      );
    }
    document.body.appendChild(menu);

    // position at the cursor (desktop) or the tapped row (mobile), clamped to the viewport
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    menu.style.left = `${Math.min(Math.max(8, x), window.innerWidth - mw - 8)}px`;
    menu.style.top = `${Math.min(Math.max(8, y), window.innerHeight - mh - 8)}px`;

    const onDocDown = (e: PointerEvent): void => {
      if (!menu.contains(e.target as Node)) closeMessageMenu();
    };
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeMessageMenu();
    };
    const onScroll = (): void => closeMessageMenu();
    menuOpenCleanup = () => {
      document.removeEventListener('pointerdown', onDocDown);
      document.removeEventListener('keydown', onEsc);
      window.removeEventListener('scroll', onScroll, true);
      menu.remove();
    };
    // defer the outside-click listener so the opening interaction isn't swallowed
    setTimeout(() => {
      document.addEventListener('pointerdown', onDocDown);
      document.addEventListener('keydown', onEsc);
      window.addEventListener('scroll', onScroll, true);
    }, 0);
  }

  // ── rendering ─────────────────────────────────────────────────────────
  function renderChat(chat: UIChat): void {
    closeMessageMenu();
    emojiPanel.close();
    setReplyingTo(null);
    currentChatId = chat.id;
    chatPane.classList.remove('hidden');
    emptyState.classList.add('hidden');
    renderHeader(chat);
    messagesEl.innerHTML = '';
    renderMessages(chat);
    renderTypingBar(chat);
    scrollToBottom(true);
    refreshTicks();
  }

  function renderMessages(chat: UIChat): void {
    messagesEl.innerHTML = '';
    let lastDay = '';
    for (const msg of chat.messages) {
      const d = dayKey(msg.createdAt);
      if (d !== lastDay) {
        lastDay = d;
        const sep = document.createElement('div');
        sep.className = 'day-sep';
        const span = document.createElement('span');
        span.textContent = dayLabel(msg.createdAt);
        sep.appendChild(span);
        messagesEl.appendChild(sep);
      }
      messagesEl.appendChild(makeMessageNode(chat, msg));
    }
  }

  function appendMessage(chat: UIChat, msg: UIMessage): void {
    const d = dayKey(msg.createdAt);
    const nodes = messagesEl.children;
    let lastDay = '';
    for (let i = nodes.length - 1; i >= 0; i--) {
      const el = nodes[i] as HTMLElement;
      if (el.classList.contains('msg-row')) {
        const ts = chat.messages.find((m) => el.dataset.key === (m.tempId ? `t:${m.tempId}` : `m:${m.id}`))?.createdAt;
        lastDay = ts ? dayKey(ts) : '';
        break;
      }
    }
    if (d !== lastDay) {
      const sep = document.createElement('div');
      sep.className = 'day-sep';
      const span = document.createElement('span');
      span.textContent = dayLabel(msg.createdAt);
      sep.appendChild(span);
      messagesEl.appendChild(sep);
    }
    messagesEl.appendChild(makeMessageNode(chat, msg));
  }

  /** Insert an older message ABOVE the current first row (history pagination).
   *  `idx` is its index in chat.messages; the next message in the array is the
   *  one directly below it (already in the DOM from an earlier notify), so we
   *  insert before that row to keep consecutive prepends chronological. */
  function prependMessage(chat: UIChat, msg: UIMessage, idx: number): void {
    const next = idx + 1 < chat.messages.length ? chat.messages[idx + 1] : undefined;
    const nextKey = next ? keyOf(next) : null;
    const anchorEl = nextKey
      ? messagesEl.querySelector<HTMLElement>(`.msg-row[data-key="${CSS.escape(nextKey)}"]`)
      : null;
    const frag = document.createDocumentFragment();
    const d = dayKey(msg.createdAt);
    const nextDay = next ? dayKey(next.createdAt) : '';
    if (next && d !== nextDay) {
      const sep = document.createElement('div');
      sep.className = 'day-sep';
      const span = document.createElement('span');
      span.textContent = dayLabel(msg.createdAt);
      sep.appendChild(span);
      frag.appendChild(sep);
    }
    frag.appendChild(makeMessageNode(chat, msg));
    if (anchorEl) {
      messagesEl.insertBefore(frag, anchorEl);
    } else {
      const firstRow = messagesEl.querySelector<HTMLElement>('.msg-row');
      if (firstRow) messagesEl.insertBefore(frag, firstRow);
      else messagesEl.appendChild(frag);
    }
  }

  function renderTypingBar(chat: UIChat): void {
    const now = Date.now();
    const names = [...chat.typingUsers.entries()]
      .filter(([, exp]) => exp > now)
      .map(([uid]) => {
        const member = chat.members.find((m) => m.userId === uid);
        return member?.displayName ?? `user ${uid}`;
      });
    if (names.length === 0) {
      typingBar.classList.add('hidden');
      typingBar.textContent = '';
      return;
    }
    typingBar.classList.remove('hidden');
    typingBar.innerHTML = `<span class="typing-dots"><i></i><i></i><i></i></span><span>${names.join(', ')} ${names.length > 1 ? 'are' : 'is'} typing…</span>`;
  }

  // ── scroll & history ──────────────────────────────────────────────────
  function scrollToBottom(force = false): void {
    if (force || atBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  messagesEl.addEventListener('scroll', () => {
    const chat = store.activeChat();
    atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
    if (chat && messagesEl.scrollTop < 60) {
      const first = chat.messages[0];
      if (first && chat.hasMore && !chat.loadingHistory) {
        const prevHeight = messagesEl.scrollHeight;
        void loadMore(chat.id, first.id).then(() => {
          messagesEl.scrollTop = messagesEl.scrollHeight - prevHeight;
        });
      }
    }
  });

  // ── composer ──────────────────────────────────────────────────────────
  composerEl.innerHTML = `
    <div id="verify-banner" class="verify-banner hidden">
      <span class="verify-banner-text">Confirm your email address to send messages.</span>
      <button type="button" id="verify-banner-btn" class="verify-banner-btn">Add email</button>
    </div>
    <div id="reply-bar" class="reply-bar hidden"></div>
    <div id="composer-row">
      <button id="attach-btn" class="icon-btn attach-btn" title="Attach file">＋</button>
      <button id="emoji-btn" class="icon-btn emoji-btn" title="Emoji">😊</button>
      <textarea id="msg-input" rows="1" dir="auto" placeholder="Message" maxlength="4096"></textarea>
      <button id="send-btn" class="send-btn" title="Send">➤</button>
    </div>
    <input type="file" id="file-input" hidden />
    <div id="upload-progress" class="hidden"><div id="upload-bar"></div></div>
  `;

  // "Verify your email" nudge: only when the server policy requires it and this
  // account has not confirmed an address yet — with a direct route to settings.
  const verifyBanner = document.querySelector('#verify-banner') as HTMLDivElement;
  const verifyBannerBtn = document.querySelector('#verify-banner-btn') as HTMLButtonElement;
  verifyBannerBtn.addEventListener('click', () => {
    void import('./settings').then((m) => m.openSettingsModal());
  });
  const renderVerifyBanner = (): void => {
    const user = store.state.session?.user;
    const needs = Boolean(store.state.requireVerifiedEmail) && !user?.emailVerified;
    verifyBanner.classList.toggle('hidden', !needs);
    verifyBannerBtn.textContent = user?.email ? 'Resend verification' : 'Add email';
  };
  store.subscribe(renderVerifyBanner);
  renderVerifyBanner();

  const input = $('#msg-input') as HTMLTextAreaElement;
  const sendBtn = $('#send-btn') as HTMLButtonElement;
  const attachBtn = $('#attach-btn') as HTMLButtonElement;
  const fileInput = $('#file-input') as HTMLInputElement;
  const progressWrap = $('#upload-progress') as HTMLDivElement;
  const progressBar = $('#upload-bar') as HTMLDivElement;
  const emojiPanel = mountEmojiPanel(input, composerEl);

  // ── reply state ───────────────────────────────────────────────────────
  let replyingTo: UIMessage | null = null;
  const replyBar = document.querySelector('#reply-bar') as HTMLDivElement;
  const replyInfo = document.createElement('div');
  replyInfo.className = 'reply-info';
  const replyClose = document.createElement('button');
  replyClose.className = 'reply-close';
  replyClose.textContent = '✕';
  replyClose.title = 'Cancel reply';
  replyClose.addEventListener('click', () => setReplyingTo(null));
  replyBar.append(replyInfo, replyClose);

  function previewOf(msg: UIMessage): string {
    if (msg.deletedAt) return 'This message was deleted';
    if (msg.kind === 'image') return '[Photo]';
    if (msg.kind === 'file' && msg.file) return `[File: ${msg.file.name}]`;
    return msg.text ?? '';
  }

  function setReplyingTo(msg: UIMessage | null): void {
    replyingTo = msg;
    if (msg) {
      const chat = store.activeChat();
      const sender = chat?.members.find((m) => m.userId === msg.senderId)?.displayName ?? 'Unknown';
      replyInfo.textContent = `↩ ${sender}: ${previewOf(msg)}`;
      replyBar.classList.remove('hidden');
    } else {
      replyBar.classList.add('hidden');
    }
  }

  function autoGrow(): void {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  }

  input.addEventListener('input', () => {
    autoGrow();
    const now = Date.now();
    const chat = store.activeChat();
    if (chat && now - lastTypingSent > 1500) {
      lastTypingSent = now;
      socket.send({ t: 'typing', cid: chat.id });
    }
  });

  function sendText(chatId: number, text: string, tempId?: string, replyTo?: number): void {
    const t = tempId ?? `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (!tempId) {
      store.addMessage(chatId, {
        id: 0,
        chatId,
        senderId: store.state.session?.user.id ?? 0,
        kind: 'text',
        text,
        file: null,
        replyTo: replyTo ?? null,
        createdAt: Date.now(),
        tempId: t,
        pending: true,
      });
    }
    socket.send({ t: 'msg.send', cid: chatId, tempId: t, kind: 'text', text, replyTo });
  }

  function send(): void {
    const chat = store.activeChat();
    const text = input.value.trim();
    if (!chat || !text) return;
    sendText(chat.id, text, undefined, replyingTo?.id);
    input.value = '';
    autoGrow();
    emojiPanel.close();
    setReplyingTo(null);
  }

  sendBtn.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    // phones have no Shift — Enter must insert a newline there (send via ➤)
    if (window.matchMedia('(pointer: coarse)').matches) return;
    if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      send();
    }
  });

  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    void attachFile(file);
  });

  async function attachFile(file: File): Promise<void> {
    const chat = store.activeChat();
    if (!chat) return;
    progressWrap.classList.remove('hidden');
    try {
      const { file: meta } = await api.upload(file, (pct) => {
        progressBar.style.width = `${pct}%`;
      });
      const kind = isImageMime(meta.mime) ? 'image' : 'file';
      const tempId = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      store.addMessage(chat.id, {
        id: 0,
        chatId: chat.id,
        senderId: store.state.session?.user.id ?? 0,
        kind,
        text: '',
        file: meta,
        replyTo: null,
        createdAt: Date.now(),
        tempId,
        pending: true,
      });
      socket.send({ t: 'msg.send', cid: chat.id, tempId, kind, fileId: meta.id });
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Upload failed', 'error');
    } finally {
      progressWrap.classList.add('hidden');
      progressBar.style.width = '0%';
    }
  }

  // ── store subscription ────────────────────────────────────────────────
  store.subscribe(() => {
    const chat = store.activeChat();
    if (!chat) {
      currentChatId = null;
      chatPane.classList.add('hidden');
      emptyState.classList.remove('hidden');
      return;
    }
    if (chat.id !== currentChatId) {
      renderChat(chat);
      return;
    }
    // incremental updates for the already-open chat
    renderHeader(chat); // cheap; keeps presence subtitle fresh
    updateHeaderSub(chat);
    const domRows = [...messagesEl.querySelectorAll<HTMLElement>('.msg-row')];
    const rendered = new Set(domRows.map((el) => el.dataset.key));
    const firstRenderedKey = domRows[0]?.dataset.key ?? null;
    const lastRenderedKey = domRows.length ? (domRows[domRows.length - 1]!.dataset.key ?? null) : null;
    const firstRenderedIdx = firstRenderedKey
      ? chat.messages.findIndex((m) => keyOf(m) === firstRenderedKey)
      : -1;
    let appended = 0;
    for (let i = 0; i < chat.messages.length; i++) {
      const msg = chat.messages[i]!;
      const key = keyOf(msg);
      if (rendered.has(key)) continue;
      // messages older than the rendered window go on top (history pagination);
      // everything else (new msgs, first-page streaming) appends at the bottom
      if (firstRenderedIdx >= 0 && i < firstRenderedIdx) prependMessage(chat, msg, i);
      else {
        appendMessage(chat, msg);
        appended++;
      }
    }
    // reconcile existing rows: remove gone messages (delete-for-me), rebuild
    // rows whose store message changed (ack, edit, delete-for-everyone)
    for (const el of messagesEl.querySelectorAll<HTMLElement>('.msg-row')) {
      const key = el.dataset.key ?? '';
      const storeMsg = chat.messages.find((m) => keyOf(m) === key);
      if (!storeMsg) {
        el.remove();
        continue;
      }
      const revChanged = Number(el.dataset.rev ?? 0) !== (storeMsg.rev ?? 0);
      const stateChanged =
        el.classList.contains('pending') !== !!storeMsg.pending ||
        el.classList.contains('failed') !== !!storeMsg.failed;
      if (revChanged || stateChanged) {
        el.replaceWith(makeMessageNode(chat, storeMsg));
      }
    }
    // follow new messages only when they were APPENDED and the user is at the
    // bottom. Prepend-only updates (older history) must not move the viewport.
    const newLast = chat.messages[chat.messages.length - 1];
    if (appended > 0 && lastRenderedKey && newLast && keyOf(newLast) !== lastRenderedKey) {
      scrollToBottom();
    }
    renderTypingBar(chat);
    refreshTicks();
  });
}

// ── members modal ───────────────────────────────────────────────────────
function openMembersModal(chat: UIChat): void {
  const me = store.state.session?.user.id;
  const amAdmin = chat.members.find((m) => m.userId === me)?.role === 'admin';
  const root = document.createElement('div');
  root.className = 'members-modal';
  root.innerHTML = `
    <h2>${chat.name ?? 'Group'}</h2>
    <div id="mm-list"></div>
    <div id="mm-add" class="hidden">
      <input id="mm-q" type="text" placeholder="Search users…" maxlength="32" />
      <div id="mm-results"></div>
    </div>
    <button id="mm-toggle">＋ Add member</button>
    <div id="mm-footer">
      <button id="mm-leave">Leave group</button>
      ${amAdmin ? '<button id="mm-delete" class="mm-delete">Delete group</button>' : ''}
    </div>
  `;

  const listEl = root.querySelector<HTMLDivElement>('#mm-list')!;
  const addEl = root.querySelector<HTMLDivElement>('#mm-add')!;
  const toggleBtn = root.querySelector<HTMLButtonElement>('#mm-toggle')!;
  const qInput = root.querySelector<HTMLInputElement>('#mm-q')!;
  const resultsEl = root.querySelector<HTMLDivElement>('#mm-results')!;

  function renderList(members: MemberInfo[]): void {
    listEl.innerHTML = '';
    for (const member of members) {
      const row = document.createElement('div');
      row.className = 'mm-row';
      row.appendChild(avatarEl(member.userId, member.displayName, 32));
      const info = document.createElement('div');
      info.className = 'mm-info';
      const name = document.createElement('div');
      name.className = 'mm-name';
      name.textContent = member.displayName + (member.userId === me ? ' (you)' : '');
      const sub = document.createElement('div');
      sub.className = 'mm-sub';
      sub.textContent = member.online ? 'online' : formatLastSeen(member.lastSeenAt);
      if (member.role === 'admin') sub.textContent += ' · admin';
      info.append(name, sub);
      row.appendChild(info);
      if (amAdmin && member.userId !== me) {
        const kick = document.createElement('button');
        kick.className = 'mm-kick';
        kick.textContent = 'Remove';
        kick.addEventListener('click', async () => {
          try {
            await api.removeMember(chat.id, member.userId);
            toast(`${member.displayName} removed`);
            const updated = chat.members.filter((m) => m.userId !== member.userId);
            store.setMembers(chat.id, updated);
          } catch (err) {
            toast(err instanceof Error ? err.message : 'Failed to remove', 'error');
          }
        });
        row.appendChild(kick);
      }
      listEl.appendChild(row);
    }
  }

  renderList(chat.members);

  toggleBtn.addEventListener('click', () => {
    addEl.classList.toggle('hidden');
    toggleBtn.classList.toggle('hidden');
    if (!addEl.classList.contains('hidden')) qInput.focus();
  });

  let debounce: ReturnType<typeof setTimeout> | undefined;
  qInput.addEventListener('input', () => {
    clearTimeout(debounce);
    const q = qInput.value.trim();
    if (!q) {
      resultsEl.innerHTML = '';
      return;
    }
    debounce = setTimeout(async () => {
      try {
        const { users } = await api.users(q);
        resultsEl.innerHTML = '';
        for (const user of users) {
          if (user.id === me || chat.members.some((m) => m.userId === user.id)) continue;
          const row = document.createElement('div');
          row.className = 'gm-result';
          row.appendChild(avatarEl(user.id, user.displayName, 30));
          const span = document.createElement('span');
          span.textContent = `${user.displayName} (@${user.username})`;
          row.appendChild(span);
          row.addEventListener('click', async () => {
            try {
              const { members } = await api.addMember(chat.id, user.id);
              store.setMembers(chat.id, members as MemberInfo[]);
              renderList(members as MemberInfo[]);
              toast(`${user.displayName} added`);
              qInput.value = '';
              resultsEl.innerHTML = '';
            } catch (err) {
              toast(err instanceof Error ? err.message : 'Failed to add', 'error');
            }
          });
          resultsEl.appendChild(row);
        }
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Search failed', 'error');
      }
    }, 250);
  });

  // leave / delete the group (with confirmation)
  const leaveBtn = root.querySelector<HTMLButtonElement>('#mm-leave')!;
  leaveBtn.addEventListener('click', async () => {
    const ok = await confirmDialog(
      'Leave group?',
      amAdmin
        ? `You are the admin — after you leave, no one can manage "${chat.name}".`
        : `You will lose access to "${chat.name}".`,
      'Leave',
    );
    if (!ok) return;
    try {
      await api.leaveGroup(chat.id);
      closeModal(); // chat.removed event drops it from the sidebar
      toast('Left the group');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to leave', 'error');
    }
  });

  const deleteBtn = root.querySelector<HTMLButtonElement>('#mm-delete');
  deleteBtn?.addEventListener('click', async () => {
    const ok = await confirmDialog(
      'Delete group?',
      `"${chat.name}" and all its messages will be permanently deleted for everyone. Cannot be undone.`,
      'Delete group',
    );
    if (!ok) return;
    try {
      await api.deleteGroup(chat.id);
      closeModal(); // chat.deleted event closes the pane + removes from sidebar
      toast('Group deleted');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to delete', 'error');
    }
  });

  const closeModal = openModal(root);
}

// ── lightbox ────────────────────────────────────────────────────────────
async function openLightbox(url: string, name: string): Promise<void> {
  const lb = $('#lightbox');
  lb.innerHTML = '';
  lb.classList.remove('hidden');
  const img = document.createElement('img');
  img.alt = name;
  try {
    img.src = await authedFileUrl(url);
  } catch {
    img.alt = 'Failed to load image';
  }
  const close = document.createElement('button');
  close.className = 'lb-close';
  close.textContent = '✕';
  close.addEventListener('click', () => lb.classList.add('hidden'));
  lb.addEventListener('click', (e) => {
    if (e.target === lb) lb.classList.add('hidden');
  });
  lb.append(img, close);
}
