import type { ChatSummary, MessageDTO, Session, UIChat, UIMessage, UserDTO, MemberInfo } from './types';

export type ConnectionStatus = 'connecting' | 'online' | 'offline';

interface State {
  session: Session | null;
  connection: ConnectionStatus;
  chats: Map<number, UIChat>;
  activeChatId: number | null;
  userMap: Map<number, UserDTO>;
  /** Server policy: must an account verify its email before sending? */
  requireVerifiedEmail: boolean;
}

type Listener = () => void;

class Store {
  state: State = {
    session: null,
    connection: 'connecting',
    chats: new Map(),
    activeChatId: null,
    userMap: new Map(),
    requireVerifiedEmail: false,
  };

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Notify all subscribers (public touch for one-off mutations). */
  touch(): void {
    this.notify();
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  setSession(s: Session | null): void {
    this.state.session = s;
    this.notify();
  }

  setRequireVerifiedEmail(v: boolean): void {
    if (this.state.requireVerifiedEmail === v) return;
    this.state.requireVerifiedEmail = v;
    this.notify();
  }

  setConnection(c: ConnectionStatus): void {
    this.state.connection = c;
    this.notify();
  }

  setActiveChat(id: number | null): void {
    this.state.activeChatId = id;
    this.notify();
  }

  upsertChat(chat: ChatSummary & { lastMessage?: MessageDTO | null; unread?: number; readBy?: { userId: number; msgId: number }[] }): UIChat {
    const existing = this.state.chats.get(chat.id);
    const merged: UIChat =
      existing ??
      ({
        ...chat,
        lastMessage: chat.lastMessage ?? null,
        unread: chat.unread ?? 0,
        messages: [],
        hasMore: true,
        loadingHistory: false,
        typingUsers: new Map(),
        readBy: new Map(),
      } as UIChat);
    merged.type = chat.type;
    merged.name = chat.name;
    merged.createdAt = chat.createdAt;
    merged.members = chat.members;
    if (chat.lastMessage !== undefined) merged.lastMessage = chat.lastMessage;
    if (chat.unread !== undefined) merged.unread = chat.unread;
    // seed read cursors from the server (monotonic — only ever advances)
    if (chat.readBy) for (const r of chat.readBy) merged.readBy.set(r.userId, r.msgId);
    this.state.chats.set(chat.id, merged);
    this.notify();
    return merged;
  }

  removeChat(chatId: number): void {
    this.state.chats.delete(chatId);
    if (this.state.activeChatId === chatId) this.state.activeChatId = null;
    this.notify();
  }

  addMessage(chatId: number, msg: UIMessage, mode: 'append' | 'prepend' | 'update' = 'append'): void {
    const chat = this.state.chats.get(chatId);
    if (!chat) return;
    if (mode === 'update') {
      // reconcile an optimistic send (matched by tempId, else by server id)
      const byTemp = chat.messages.findIndex((m) => m.tempId && msg.tempId && m.tempId === msg.tempId);
      const target = byTemp >= 0 ? byTemp : chat.messages.findIndex((m) => m.id === msg.id);
      if (target >= 0) {
        chat.messages[target] = { ...msg, pending: false, failed: false };
      } else {
        chat.messages.push({ ...msg, pending: false });
      }
    } else if (mode === 'append') {
      if (!chat.messages.some((m) => m.id === msg.id && m.id !== 0)) chat.messages.push(msg);
    } else {
      chat.messages.unshift(msg);
    }
    if (mode !== 'prepend') chat.lastMessage = msg;
    this.notify();
  }

  setMessageFailed(chatId: number, tempId: string): void {
    const chat = this.state.chats.get(chatId);
    if (!chat) return;
    const m = chat.messages.find((x) => x.tempId === tempId);
    if (m) {
      m.pending = false;
      m.failed = true;
      this.notify();
    }
  }

  /** Apply a server-driven mutation (edit, delete-for-everyone) by message id. */
  updateMessage(chatId: number, patch: Partial<UIMessage> & { id: number }): void {
    const chat = this.state.chats.get(chatId);
    if (!chat) return;
    const idx = chat.messages.findIndex((m) => m.id === patch.id);
    if (idx < 0) return;
    const prev = chat.messages[idx]!;
    chat.messages[idx] = { ...prev, ...patch, rev: (prev.rev ?? 0) + 1 };
    this.notify();
  }

  /** Apply a user-profile update (own session + member lists everywhere). */
  setUser(user: UserDTO): void {
    if (this.state.session && this.state.session.user.id === user.id) {
      this.state.session.user = user;
    }
    for (const chat of this.state.chats.values()) {
      const m = chat.members.find((x) => x.userId === user.id);
      if (m) m.displayName = user.displayName;
    }
    this.notify();
  }

  /** Remove a message entirely (delete-for-me / delete-for-everyone). */
  removeMessage(chatId: number, msgId: number): void {
    const chat = this.state.chats.get(chatId);
    if (!chat) return;
    const idx = chat.messages.findIndex((m) => m.id === msgId);
    if (idx >= 0) chat.messages.splice(idx, 1);
    // keep the sidebar preview honest: if the removed message was the last
    // one we knew about, fall back to the previous message (or nothing)
    if (chat.lastMessage?.id === msgId) {
      chat.lastMessage = chat.messages[chat.messages.length - 1] ?? null;
    }
    this.notify();
  }

  setTyping(chatId: number, userId: number, isTyping: boolean): void {
    const chat = this.state.chats.get(chatId);
    if (!chat) return;
    if (isTyping) chat.typingUsers.set(userId, Date.now() + 5000);
    else chat.typingUsers.delete(userId);
    this.notify();
  }

  setRead(chatId: number, userId: number, msgId: number): void {
    const chat = this.state.chats.get(chatId);
    if (!chat) return;
    const prev = chat.readBy.get(userId) ?? 0;
    if (msgId > prev) chat.readBy.set(userId, msgId);
    this.notify();
  }

  setPresence(user: Partial<UserDTO> & { id: number; online: boolean; lastSeenAt?: number | null }): void {
    const existing = this.state.userMap.get(user.id);
    this.state.userMap.set(user.id, {
      ...(existing ?? { id: user.id, username: '', displayName: '', createdAt: 0, online: false, lastSeenAt: null }),
      ...user,
    } as UserDTO);
    for (const chat of this.state.chats.values()) {
      const m = chat.members.find((x) => x.userId === user.id);
      if (m) {
        m.online = user.online;
        if (user.lastSeenAt !== undefined && user.lastSeenAt !== null) m.lastSeenAt = user.lastSeenAt;
      }
    }
    this.notify();
  }

  setMembers(chatId: number, members: MemberInfo[]): void {
    const chat = this.state.chats.get(chatId);
    if (!chat) return;
    chat.members = members;
    this.notify();
  }

  /** Chats ordered by recency (last message time, else creation). */
  sortedChats(): UIChat[] {
    return [...this.state.chats.values()].sort(
      (a, b) => (b.lastMessage?.createdAt ?? b.createdAt) - (a.lastMessage?.createdAt ?? a.createdAt),
    );
  }

  activeChat(): UIChat | null {
    return this.state.activeChatId != null ? (this.state.chats.get(this.state.activeChatId) ?? null) : null;
  }

  /** Display name of a private chat = the other member. */
  chatTitle(chat: UIChat): string {
    if (chat.type === 'group') return chat.name ?? 'Group';
    const me = this.state.session?.user.id;
    const other = chat.members.find((m) => m.userId !== me);
    return other?.displayName ?? chat.name ?? 'Chat';
  }
}

export const store = new Store();
