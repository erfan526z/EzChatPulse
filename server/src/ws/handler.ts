import { WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { register, unregister, isOnline, broadcastToChat } from './hub.js';
import { scheduleLastSeen, announceOnline, announceOffline } from '../presence.js';
import { handleTyping } from './typing.js';
import { sendMessage, markRead, editMessage, deleteMessageForEveryone, deleteMessageForMe } from '../services/messages.js';
import { AppError } from '../errors.js';
import { rateLimit } from '../rate-limit.js';
import { sendingBlockedByVerification } from '../services/verification.js';

const AUTH_TIMEOUT_MS = 5000;

/* Extend WebSocket with an optional userId property. */
type ExtSocket = WebSocket & { userId?: number };

export function handleConnection(raw: WebSocket): void {
  const ws = raw as ExtSocket;
  let authed = false;

  const timer = setTimeout(() => {
    if (!authed) ws.close(4001, 'Auth timeout');
  }, AUTH_TIMEOUT_MS);

  ws.on('message', (data) => {
    const frameBytes = Buffer.isBuffer(data) ? data.length : typeof data === 'string' ? Buffer.byteLength(data) : 0;
    if (frameBytes > config.maxWsFrameBytes) {
      sendError(ws, 'TOO_LARGE', `Frame exceeds ${config.maxWsFrameBytes} bytes`);
      return;
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(data));
    } catch {
      sendError(ws, 'BAD_REQUEST', 'Invalid JSON');
      return;
    }

    // ── Auth handshake ─────────────────────────────────────────
    if (msg.t === 'auth' && typeof msg.token === 'string') {
      try {
        const payload = jwt.verify(msg.token, config.jwtSecret) as jwt.JwtPayload;
        const sub = Number(payload.sub);
        if (!Number.isInteger(sub)) throw new Error('invalid sub');
        clearTimeout(timer);
        authed = true;
        ws.userId = sub;
        register(ws.userId, ws);

        // Presence: clear stale last_seen, tell shared chats we're online
        getDb().prepare('UPDATE users SET last_seen_at = NULL WHERE id = ?').run(ws.userId);
        announceOnline(ws.userId);

        ws.send(JSON.stringify({ t: 'ready', userId: ws.userId }));
      } catch {
        sendError(ws, 'AUTH_FAILED', 'Invalid or expired token');
      }
      return;
    }

    if (!ws.userId) {
      sendError(ws, 'AUTH_REQUIRED', 'Send {t:"auth", token:...} first');
      return;
    }

    // ── Authenticated message types ────────────────────────────
    switch (msg.t) {
      case 'msg.send':
        // S1: when the admin requires verified emails, unverified accounts can
        // read but not send. Answer with a typed error the client can explain.
        if (sendingBlockedByVerification(getDb(), ws.userId)) {
          sendError(ws, 'EMAIL_NOT_VERIFIED', 'Confirm your email address to send messages');
          return;
        }
        handleSend(ws, msg);
        break;
      case 'msg.edit':
        handleEdit(ws, msg);
        break;
      case 'msg.delete':
        handleDelete(ws, msg);
        break;
      case 'read':
        handleRead(ws, msg);
        break;
      case 'typing': {
        const cid = Number(msg.cid);
        if (!Number.isInteger(cid)) {
          sendError(ws, 'BAD_REQUEST', 'cid must be an integer');
          return;
        }
        handleTyping(ws.userId!, cid);
        break;
      }
      default:
        sendError(ws, 'UNKNOWN_TYPE', `Unknown message type: ${msg.t}`);
    }
  });

  ws.on('close', () => {
    clearTimeout(timer);
    if (ws.userId) {
      unregister(ws.userId, ws);
      if (!isOnline(ws.userId)) {
        scheduleLastSeen(ws.userId);
        announceOffline(ws.userId);
      }
    }
  });

  ws.on('error', () => {
    /* close event will fire next */
  });
}

function handleSend(ws: ExtSocket, msg: Record<string, unknown>): void {
  const cid = Number(msg.cid);
  if (!Number.isInteger(cid)) {
    sendError(ws, 'BAD_REQUEST', 'cid must be an integer');
    return;
  }
  // 30 messages/second per user — spam guard
  if (!rateLimit(`send:${ws.userId}`, 30, 1000)) {
    sendError(ws, 'RATE_LIMITED', 'Sending too fast — slow down');
    return;
  }
  try {
    const result = sendMessage(getDb(), ws.userId!, cid, {
      tempId: typeof msg.tempId === 'string' ? msg.tempId : '',
      kind: typeof msg.kind === 'string' ? msg.kind : 'text',
      text: typeof msg.text === 'string' ? msg.text : '',
      fileId: msg.fileId != null ? Number(msg.fileId) : null,
      replyTo: msg.replyTo != null ? Number(msg.replyTo) : null,
    });

    // Sender: acknowledge with the server-assigned id (client reconciles optimistic send)
    ws.send(JSON.stringify({ t: 'msg.ack', tempId: result.tempId, msg: result.msg }));
    // Other online members: deliver the message
    broadcastToChat(result.msg.chatId, { t: 'msg.new', msg: result.msg }, ws.userId);
  } catch (err) {
    sendWsError(ws, err);
  }
}

function handleEdit(ws: ExtSocket, msg: Record<string, unknown>): void {
  const cid = Number(msg.cid);
  const msgId = Number(msg.msgId);
  if (!Number.isInteger(cid) || !Number.isInteger(msgId)) {
    sendError(ws, 'BAD_REQUEST', 'cid and msgId must be integers');
    return;
  }
  if (typeof msg.text !== 'string') {
    sendError(ws, 'BAD_REQUEST', 'text is required');
    return;
  }
  if (!rateLimit(`send:${ws.userId}`, 30, 1000)) {
    sendError(ws, 'RATE_LIMITED', 'Sending too fast — slow down');
    return;
  }
  try {
    const updated = editMessage(getDb(), ws.userId!, cid, msgId, msg.text);
    // everyone (including the sender) gets the updated message — idempotent by id
    broadcastToChat(cid, { t: 'msg.edited', msg: updated });
  } catch (err) {
    sendWsError(ws, err);
  }
}

function handleDelete(ws: ExtSocket, msg: Record<string, unknown>): void {
  const cid = Number(msg.cid);
  const msgId = Number(msg.msgId);
  const mode = msg.mode === 'everyone' ? 'everyone' : 'me';
  if (!Number.isInteger(cid) || !Number.isInteger(msgId)) {
    sendError(ws, 'BAD_REQUEST', 'cid and msgId must be integers');
    return;
  }
  try {
    if (mode === 'everyone') {
      deleteMessageForEveryone(getDb(), ws.userId!, cid, msgId);
      broadcastToChat(cid, { t: 'msg.deleted', cid, msgId, mode: 'everyone' });
    } else {
      deleteMessageForMe(getDb(), ws.userId!, cid, msgId);
      // affects only the actor — acknowledge, no broadcast
      ws.send(JSON.stringify({ t: 'msg.deleted', cid, msgId, mode: 'me' }));
    }
  } catch (err) {
    sendWsError(ws, err);
  }
}

function handleRead(ws: ExtSocket, msg: Record<string, unknown>): void {
  const cid = Number(msg.cid);
  const msgId = Number(msg.msgId);
  if (!Number.isInteger(cid) || !Number.isInteger(msgId)) {
    sendError(ws, 'BAD_REQUEST', 'cid and msgId must be integers');
    return;
  }
  try {
    markRead(getDb(), ws.userId!, cid, msgId);
    broadcastToChat(cid, { t: 'read', cid, userId: ws.userId, msgId });
  } catch (err) {
    sendWsError(ws, err);
  }
}

function sendWsError(ws: WebSocket, err: unknown): void {
  if (err instanceof AppError) {
    const code: Record<number, string> = {
      400: 'BAD_REQUEST',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'CONFLICT',
    };
    sendError(ws, code[err.statusCode] ?? 'ERROR', err.message);
  } else {
    console.error('ws handler error:', err);
    sendError(ws, 'INTERNAL', 'Internal server error');
  }
}

function sendError(ws: WebSocket, code: string, message: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ t: 'error', code, message }));
  }
}
