import { store } from './store';
import { getToken } from './api';
import { loadChatDetail } from './actions';

class ChatSocket {
  private ws: WebSocket | null = null;
  private reconnectDelay = 1000;
  private closed = false;

  connect(): void {
    this.closed = false;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectDelay = 1000;
      const token = getToken();
      if (token) ws.send(JSON.stringify({ t: 'auth', token }));
    };
    ws.onmessage = (ev) => this.dispatch(JSON.parse(ev.data as string));
    ws.onclose = () => {
      if (!this.closed) {
        store.setConnection('offline');
        setTimeout(() => this.connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10_000);
      }
    };
    ws.onerror = () => ws.close();
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }

  send(obj: object): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  private dispatch(msg: Record<string, any>): void {
    switch (msg.t) {
      case 'ready':
        store.setConnection('online');
        break;

      case 'msg.ack': {
        const m = msg.msg as { chatId: number };
        store.addMessage(m.chatId, { ...msg.msg, tempId: msg.tempId }, 'update');
        break;
      }

      case 'user.updated':
        store.setUser(msg.user);
        break;

      case 'msg.edited':
        store.updateMessage(msg.msg.chatId, msg.msg);
        break;

      case 'msg.deleted':
        // both modes remove the message from the viewer's list:
        //  - 'me': hidden only for this user
        //  - 'everyone': hard-deleted server-side, gone for everyone
        store.removeMessage(msg.cid, msg.msgId);
        break;

      case 'msg.new': {
        const chat = store.state.chats.get(msg.msg.chatId);
        const isActive = store.state.activeChatId === msg.msg.chatId;
        store.addMessage(msg.msg.chatId, msg.msg, 'append');
        const me = store.state.session?.user.id;
        if (chat && !isActive && msg.msg.senderId !== me) {
          chat.unread = (chat.unread ?? 0) + 1;
          store.touch();
        } else if (isActive) {
          // auto mark read when the app is focused on this chat
          this.send({ t: 'read', cid: msg.msg.chatId, msgId: msg.msg.id });
        }
        break;
      }

      case 'typing':
        store.setTyping(msg.cid, msg.userId, true);
        setTimeout(() => store.setTyping(msg.cid, msg.userId, false), 5000);
        break;

      case 'presence':
        store.setPresence({
          id: msg.userId,
          online: msg.online,
          lastSeenAt: msg.lastSeenAt ?? null,
        });
        break;

      case 'read':
        store.setRead(msg.cid, msg.userId, msg.msgId);
        break;

      case 'chat.created':
        store.upsertChat(msg.chat);
        void loadChatDetail(msg.chat.id); // fetch lastMessage + unread for the viewer
        break;

      case 'chat.member':
        if (msg.chat?.members) store.setMembers(msg.cid, msg.chat.members);
        break;

      case 'chat.removed':
        store.removeChat(msg.cid);
        break;

      case 'chat.deleted':
        store.removeChat(msg.cid);
        break;

      case 'error':
        console.warn('server ws error:', msg.code, msg.message);
        void import('./ui/toast').then(({ toast }) => {
          // Actionable errors: send the user straight to the place that fixes it.
          if (msg.code === 'EMAIL_NOT_VERIFIED') {
            toast(msg.message ?? 'Confirm your email address to send messages', 'error', {
              label: 'Open settings',
              onClick: () => void import('./ui/settings').then((m) => m.openSettingsModal()),
            });
            return;
          }
          toast(msg.message ?? 'Something went wrong', 'error');
        });
        break;
    }
  }
}

export const socket = new ChatSocket();
