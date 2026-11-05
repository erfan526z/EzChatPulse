import type { Db } from '../db.js';
import { BadRequest, Conflict, Forbidden, NotFound } from '../errors.js';
import { isOnline } from '../ws/hub.js';
import { isMember } from './membership.js';
import { getMessage, type MessageDTO } from './messages.js';
import { avatarUrlOf } from '../auth.js';

export interface MemberInfo {
  userId: number;
  username: string;
  displayName: string;
  role: 'member' | 'admin';
  online: boolean;
  lastSeenAt: number | null;
  avatarUrl: string | null;
}

export interface ChatDTO {
  id: number;
  type: 'private' | 'group';
  name: string | null;
  createdAt: number;
  members: MemberInfo[];
  lastMessage: MessageDTO | null;
  unread: number;
  /** Other members' read cursors: userId → highest message id they've read. */
  readBy: { userId: number; msgId: number }[];
}

/** Viewer-agnostic chat shape used in real-time events (no per-viewer fields). */
export interface ChatSummary {
  id: number;
  type: 'private' | 'group';
  name: string | null;
  createdAt: number;
  members: MemberInfo[];
}

function assertAdmin(db: Db, chatId: number, userId: number): void {
  const row = db
    .prepare('SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?')
    .get(chatId, userId) as { role: string } | undefined;
  if (!row) throw new Forbidden('You are not a member of this chat');
  if (row.role !== 'admin') throw new Forbidden('Only admins can do this');
}

/** Find the private chat between two users, creating it if needed. Returns chat id. */
export function findOrCreatePrivate(db: Db, userId: number, otherId: number): number {
  if (userId === otherId) throw new BadRequest('Cannot start a chat with yourself');
  const other = db.prepare('SELECT id FROM users WHERE id = ?').get(otherId);
  if (!other) throw new NotFound('User not found');

  const [a, b] = userId < otherId ? [userId, otherId] : [otherId, userId];
  const existing = db
    .prepare(
      `SELECT c.id FROM chats c
       JOIN chat_members x ON x.chat_id = c.id AND x.user_id = ?
       JOIN chat_members y ON y.chat_id = c.id AND y.user_id = ?
       WHERE c.type = 'private'`,
    )
    .get(a, b) as { id: number } | undefined;
  if (existing) return existing.id;

  const now = Date.now();
  return db.transaction(() => {
    const info = db
      .prepare('INSERT INTO chats (type, created_by, created_at) VALUES (?, ?, ?)')
      .run('private', userId, now);
    const chatId = Number(info.lastInsertRowid);
    const ins = db.prepare('INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)');
    ins.run(chatId, a, 'member', now);
    ins.run(chatId, b, 'member', now);
    return chatId;
  })();
}

/** Create a group chat; creator becomes admin. Returns chat id. */
export function createGroup(db: Db, creatorId: number, name: string, userIds: number[]): number {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 64) throw new BadRequest('Group name must be 1–64 characters');

  const others = new Set<number>();
  for (const id of userIds) {
    const n = Number(id);
    if (!Number.isInteger(n) || n === creatorId) continue;
    others.add(n);
  }
  for (const id of others) {
    if (!db.prepare('SELECT id FROM users WHERE id = ?').get(id)) throw new NotFound('User not found');
  }

  const now = Date.now();
  return db.transaction(() => {
    const info = db
      .prepare('INSERT INTO chats (type, name, created_by, created_at) VALUES (?, ?, ?, ?)')
      .run('group', trimmed, creatorId, now);
    const chatId = Number(info.lastInsertRowid);
    const ins = db.prepare('INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)');
    ins.run(chatId, creatorId, 'admin', now);
    for (const id of others) ins.run(chatId, id, 'member', now);
    return chatId;
  })();
}

export function addMember(db: Db, actorId: number, chatId: number, newUserId: number): void {
  assertAdmin(db, chatId, actorId);
  const chat = db.prepare('SELECT type FROM chats WHERE id = ?').get(chatId) as { type: string } | undefined;
  if (!chat) throw new NotFound('Chat not found');
  if (chat.type !== 'group') throw new BadRequest('Only group chats can have members added');
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(newUserId)) throw new NotFound('User not found');
  const existing = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, newUserId);
  if (existing) throw new Conflict('User is already a member');
  db.prepare('INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)').run(
    chatId,
    newUserId,
    'member',
    Date.now(),
  );
}

export function removeMember(db: Db, actorId: number, chatId: number, targetUserId: number): void {
  assertAdmin(db, chatId, actorId);
  const chat = db.prepare('SELECT type FROM chats WHERE id = ?').get(chatId) as { type: string } | undefined;
  if (!chat) throw new NotFound('Chat not found');
  if (chat.type !== 'group') throw new BadRequest('Only group chats can have members removed');
  if (actorId === targetUserId) throw new BadRequest('Admins cannot remove themselves');
  const member = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, targetUserId);
  if (!member) throw new NotFound('User is not a member of this chat');
  db.prepare('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?').run(chatId, targetUserId);
}

/**
 * A member leaves a group. If they were the last member, the chat (and all its
 * messages/members/read state) is deleted entirely. Returns true when the chat
 * was deleted.
 */
export function leaveGroup(db: Db, userId: number, chatId: number): boolean {
  const chat = db.prepare('SELECT type FROM chats WHERE id = ?').get(chatId) as { type: string } | undefined;
  if (!chat) throw new NotFound('Chat not found');
  if (chat.type !== 'group') throw new BadRequest('Only group chats can be left');
  const member = db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, userId);
  if (!member) throw new Forbidden('You are not a member of this chat');
  const remaining = (db.prepare('SELECT COUNT(*) AS n FROM chat_members WHERE chat_id = ?').get(chatId) as { n: number }).n;
  if (remaining <= 1) {
    db.prepare('DELETE FROM chats WHERE id = ?').run(chatId); // cascades members/messages/read_state
    return true;
  }
  db.prepare('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?').run(chatId, userId);
  return false;
}

/** Admin destroys a group chat (cascades to messages, members, read state). */
export function deleteGroup(db: Db, actorId: number, chatId: number): void {
  const chat = db.prepare('SELECT type FROM chats WHERE id = ?').get(chatId) as { type: string } | undefined;
  if (!chat) throw new NotFound('Chat not found');
  if (chat.type !== 'group') throw new BadRequest('Only group chats can be deleted');
  assertAdmin(db, chatId, actorId);
  db.prepare('DELETE FROM chats WHERE id = ?').run(chatId);
}

export function listMembers(db: Db, chatId: number): MemberInfo[] {
  const rows = db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.last_seen_at, u.avatar_file_id, cm.role
       FROM chat_members cm
       JOIN users u ON u.id = cm.user_id
       WHERE cm.chat_id = ?
       ORDER BY cm.joined_at`,
    )
    .all(chatId) as Array<{
    id: number;
    username: string;
    display_name: string;
    last_seen_at: number | null;
    avatar_file_id: number | null;
    role: string;
  }>;
  return rows.map((r) => ({
    userId: r.id,
    username: r.username,
    displayName: r.display_name,
    role: r.role as 'member' | 'admin',
    online: isOnline(r.id),
    lastSeenAt: r.last_seen_at,
    avatarUrl: avatarUrlOf(r.avatar_file_id),
  }));
}

/** Read cursors of all members (userId → highest message id read). */
export function listReadState(db: Db, chatId: number): { userId: number; msgId: number }[] {
  const rows = db
    .prepare(
      `SELECT user_id, last_read_message_id
       FROM read_state
       WHERE chat_id = ? AND last_read_message_id > 0`,
    )
    .all(chatId) as Array<{ user_id: number; last_read_message_id: number }>;
  return rows.map((r) => ({ userId: r.user_id, msgId: r.last_read_message_id }));
}

/** Full chat detail for one viewer (membership required). */
export function getChat(db: Db, chatId: number, viewerId: number): ChatDTO | null {
  const row = db
    .prepare(
      `SELECT c.id, c.type, c.name, c.created_at,
              (SELECT MAX(m.id) FROM messages m WHERE m.chat_id = c.id AND m.deleted_at IS NULL) AS last_msg_id,
              (SELECT COUNT(*) FROM messages m
               WHERE m.chat_id = c.id AND m.id > COALESCE(rs.last_read_message_id, 0)
                 AND m.sender_id != ? AND m.deleted_at IS NULL) AS unread
       FROM chats c
       LEFT JOIN read_state rs ON rs.chat_id = c.id AND rs.user_id = ?
       WHERE c.id = ?`,
    )
    .get(viewerId, viewerId, chatId) as
    | {
        id: number;
        type: string;
        name: string | null;
        created_at: number;
        last_msg_id: number | null;
        unread: number;
      }
    | undefined;
  if (!row) return null;
  if (!isMember(db, chatId, viewerId)) throw new Forbidden('You are not a member of this chat');
  return {
    id: row.id,
    type: row.type as 'private' | 'group',
    name: row.name,
    createdAt: row.created_at,
    unread: row.unread,
    lastMessage: row.last_msg_id ? getMessage(db, row.last_msg_id, viewerId) : null,
    members: listMembers(db, chatId),
    readBy: listReadState(db, chatId),
  };
}

/** Viewer-agnostic summary for real-time events. */
export function chatSummary(db: Db, chatId: number): ChatSummary {
  const row = db.prepare('SELECT id, type, name, created_at FROM chats WHERE id = ?').get(chatId) as {
    id: number;
    type: string;
    name: string | null;
    created_at: number;
  };
  return {
    id: row.id,
    type: row.type as 'private' | 'group',
    name: row.name,
    createdAt: row.created_at,
    members: listMembers(db, chatId),
  };
}

/** All chats the user belongs to, newest activity first, with unread + last message. */
export function listChats(db: Db, userId: number): ChatDTO[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.type, c.name, c.created_at,
              (SELECT MAX(m.id) FROM messages m WHERE m.chat_id = c.id AND m.deleted_at IS NULL) AS last_msg_id,
              (SELECT COUNT(*) FROM messages m
               WHERE m.chat_id = c.id AND m.id > COALESCE(rs.last_read_message_id, 0)
                 AND m.sender_id != ? AND m.deleted_at IS NULL) AS unread,
              (SELECT MAX(m.created_at) FROM messages m WHERE m.chat_id = c.id AND m.deleted_at IS NULL) AS last_activity
       FROM chats c
       JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = ?
       LEFT JOIN read_state rs ON rs.chat_id = c.id AND rs.user_id = ?
       ORDER BY COALESCE(last_activity, c.created_at) DESC`,
    )
    .all(userId, userId, userId) as Array<{
    id: number;
    type: string;
    name: string | null;
    created_at: number;
    last_msg_id: number | null;
    unread: number;
  }>;

  return rows.map((r) => ({
    id: r.id,
    type: r.type as 'private' | 'group',
    name: r.name,
    createdAt: r.created_at,
    unread: r.unread,
    lastMessage: r.last_msg_id ? getMessage(db, r.last_msg_id, userId) : null,
    members: listMembers(db, r.id),
    readBy: listReadState(db, r.id),
  }));
}
