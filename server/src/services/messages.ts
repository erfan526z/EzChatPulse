import type { Db } from '../db.js';
import { BadRequest, Forbidden, NotFound } from '../errors.js';
import { assertMember, isAdmin } from './membership.js';
import { fileDTO, type FileDTO } from './files.js';

export type { FileDTO };

export interface MessageDTO {
  id: number;
  chatId: number;
  senderId: number;
  kind: 'text' | 'image' | 'file';
  text: string | null;
  file: FileDTO | null;
  replyTo: number | null;
  createdAt: number;
  editedAt: number | null;
  deletedAt: number | null;
}

interface MessageRow {
  id: number;
  chat_id: number;
  sender_id: number;
  kind: 'text' | 'image' | 'file';
  text: string | null;
  reply_to: number | null;
  created_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  f_id: number | null;
  f_name: string | null;
  f_mime: string | null;
  f_size: number | null;
}

const MESSAGE_SELECT = `
  SELECT m.id, m.chat_id, m.sender_id, m.kind, m.text, m.reply_to, m.created_at,
         m.edited_at, m.deleted_at,
         f.id AS f_id, f.name AS f_name, f.mime AS f_mime, f.size AS f_size
  FROM messages m
  LEFT JOIN files f ON f.id = m.file_id
`;

function rowToDTO(row: MessageRow): MessageDTO {
  return {
    id: row.id,
    chatId: row.chat_id,
    senderId: row.sender_id,
    kind: row.kind,
    text: row.text,
    replyTo: row.reply_to,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    deletedAt: row.deleted_at,
    file: row.f_id
      ? fileDTO({ id: row.f_id, name: row.f_name!, mime: row.f_mime!, size: row.f_size! })
      : null,
  };
}

/** Is the message hidden for this viewer (delete-for-me)? */
function isHiddenFor(db: Db, msgId: number, viewerId: number): boolean {
  return !!db.prepare('SELECT 1 FROM message_hidden WHERE message_id = ? AND user_id = ?').get(msgId, viewerId);
}

export function getMessage(db: Db, id: number, viewerId?: number): MessageDTO | null {
  const row = db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(id) as MessageRow | undefined;
  if (!row) return null;
  if (viewerId !== undefined && isHiddenFor(db, id, viewerId)) return null;
  return rowToDTO(row);
}

export interface SendInput {
  tempId?: string;
  kind?: string;
  text?: string | null;
  fileId?: number | null;
  replyTo?: number | null;
}

export interface SendResult {
  tempId: string;
  msg: MessageDTO;
}

export function sendMessage(db: Db, senderId: number, chatId: number, input: SendInput): SendResult {
  assertMember(db, chatId, senderId);

  const kind = input.kind ?? 'text';
  if (kind !== 'text' && kind !== 'image' && kind !== 'file') {
    throw new BadRequest('Invalid message kind');
  }
  const text = (input.text ?? '').trim();
  if (kind === 'text' && !text) throw new BadRequest('Message text is empty');
  if (text.length > 4096) throw new BadRequest('Message too long (max 4096 characters)');

  let fileId: number | null = null;
  if (kind === 'image' || kind === 'file') {
    fileId = Number(input.fileId);
    if (!Number.isInteger(fileId)) throw new BadRequest('fileId is required for media messages');
    const file = db.prepare('SELECT id, owner_id FROM files WHERE id = ?').get(fileId) as
      | { id: number; owner_id: number }
      | undefined;
    if (!file) throw new BadRequest('File not found');
    if (file.owner_id !== senderId) throw new Forbidden('Cannot attach a file you did not upload');
  }

  let replyTo: number | null = null;
  if (input.replyTo != null) {
    replyTo = Number(input.replyTo);
    const reply = db.prepare('SELECT id, chat_id FROM messages WHERE id = ?').get(replyTo) as
      | { id: number; chat_id: number }
      | undefined;
    if (!reply || reply.chat_id !== chatId) throw new BadRequest('reply_to must reference a message in this chat');
  }

  const now = Date.now();
  const info = db
    .prepare('INSERT INTO messages (chat_id, sender_id, kind, text, file_id, reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(chatId, senderId, kind, text || null, fileId, replyTo, now);

  const msg = getMessage(db, Number(info.lastInsertRowid))!;
  return { tempId: String(input.tempId ?? ''), msg };
}

/**
 * Keyset pagination — O(page size), constant time regardless of total history.
 * Returns newest-first pages; pass the oldest id seen so far as `before`.
 */
export function listMessages(db: Db, viewerId: number, chatId: number, before?: number, limit = 50): MessageDTO[] {
  assertMember(db, chatId, viewerId);
  const capped = Math.min(Math.max(Math.floor(limit), 1), 100);
  const rows = db
    .prepare(
      `${MESSAGE_SELECT}
       WHERE m.chat_id = ? AND (? IS NULL OR m.id < ?)
         AND m.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = ?)
       ORDER BY m.id DESC LIMIT ?`,
    )
    .all(chatId, before ?? null, before ?? null, viewerId, capped) as MessageRow[];
  return rows.map(rowToDTO);
}

/** Load a message and verify it belongs to the chat (throws NotFound otherwise). */
function getChatMessage(db: Db, chatId: number, msgId: number): MessageRow {
  const row = db.prepare(`${MESSAGE_SELECT} WHERE m.id = ? AND m.chat_id = ?`).get(msgId, chatId) as
    | MessageRow
    | undefined;
  if (!row) throw new NotFound('Message not found');
  return row;
}

/** Edit a message's text (sender only, text messages only). Returns the updated message. */
export function editMessage(db: Db, actorId: number, chatId: number, msgId: number, text: string): MessageDTO {
  assertMember(db, chatId, actorId);
  const row = getChatMessage(db, chatId, msgId);
  if (row.deleted_at) throw new BadRequest('Cannot edit a deleted message');
  if (row.sender_id !== actorId) throw new Forbidden('Only the sender can edit a message');
  if (row.kind !== 'text') throw new BadRequest('Only text messages can be edited');
  const clean = text.trim();
  if (!clean) throw new BadRequest('Message text is empty');
  if (clean.length > 4096) throw new BadRequest('Message too long (max 4096 characters)');
  db.prepare('UPDATE messages SET text = ?, edited_at = ? WHERE id = ?').run(clean, Date.now(), msgId);
  return getMessage(db, msgId)!;
}

/**
 * Delete for everyone — soft delete: the row is flagged `deleted_at` and
 * excluded from every normal query (history, previews, unread counts), so it
 * is invisible to all users but retained for N days until the admin cleanup
 * runs. Client removes the row on the broadcast — no tombstone shown.
 * Allowed for the sender, or a group admin deleting any message in their group.
 * Idempotent: deleting an already-deleted message is a no-op.
 */
export function deleteMessageForEveryone(db: Db, actorId: number, chatId: number, msgId: number): void {
  assertMember(db, chatId, actorId);
  const row = db.prepare('SELECT id, sender_id, chat_id, deleted_at FROM messages WHERE id = ? AND chat_id = ?').get(msgId, chatId) as
    | { id: number; sender_id: number; chat_id: number; deleted_at: number | null }
    | undefined;
  if (!row || row.deleted_at) return; // gone or already deleted — idempotent
  const chat = db.prepare('SELECT type FROM chats WHERE id = ?').get(chatId) as { type: string } | undefined;
  const isSender = row.sender_id === actorId;
  const isGroupAdmin = chat?.type === 'group' && isAdmin(db, chatId, actorId);
  if (!isSender && !isGroupAdmin) throw new Forbidden('Only the sender or a group admin can delete for everyone');
  db.prepare('UPDATE messages SET deleted_at = ? WHERE id = ?').run(Date.now(), msgId);
}

/** Delete for me: the message stays for everyone else, hidden only for the actor. */
export function deleteMessageForMe(db: Db, actorId: number, chatId: number, msgId: number): void {
  assertMember(db, chatId, actorId);
  getChatMessage(db, chatId, msgId); // must exist in this chat
  db.prepare(
    `INSERT INTO message_hidden (user_id, message_id, hidden_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id, message_id) DO NOTHING`,
  ).run(actorId, msgId, Date.now());
}

/** Advance the user's read cursor (monotonic — never goes backwards). */
export function markRead(db: Db, userId: number, chatId: number, msgId: number): void {
  assertMember(db, chatId, userId);
  db.prepare(
    `INSERT INTO read_state (chat_id, user_id, last_read_message_id, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(chat_id, user_id) DO UPDATE SET
       last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id),
       updated_at = excluded.updated_at`,
  ).run(chatId, userId, msgId, Date.now());
}
