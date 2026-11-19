import { Router } from 'express';
import { BadRequest, Forbidden, NotFound } from '../errors.js';
import type { Request, Response, NextFunction } from 'express';
import { getDb } from '../db.js';
import { requireAuth } from '../auth.js';
import {
  findOrCreatePrivate,
  listChats,
  getChat,
  chatSummary,
  createGroup,
  addMember,
  removeMember,
  leaveGroup,
  deleteGroup,
} from '../services/chats.js';
import { listMessages, markRead } from '../services/messages.js';
import { broadcastToChat, sendToUser } from '../ws/hub.js';
import { memberIds } from '../services/membership.js';

const router = Router();

const wrap = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

router.get('/chats', requireAuth, wrap(async (req, res) => {
  const chats = listChats(getDb(), req.userId);
  res.json({ chats });
}));

router.get('/chats/:id', requireAuth, wrap(async (req, res) => {
  const chatId = Number(req.params.id);
  const chat = getChat(getDb(), chatId, req.userId);
  if (!chat) {
    res.status(404).json({ error: 'Chat not found' });
    return;
  }
  res.json({ chat });
}));

router.post('/chats', requireAuth, wrap(async (req, res) => {
  const { type } = req.body;
  if (type === 'private') {
    const db = getDb();
    const chatId = findOrCreatePrivate(db, req.userId, Number(req.body.userId));
    // tell both members' devices about the chat (new or re-opened)
    broadcastToChat(chatId, { t: 'chat.created', chat: chatSummary(db, chatId) });
    res.status(201).json({ chatId });
    return;
  }
  if (type === 'group') {
    const db = getDb();
    const chatId = createGroup(db, req.userId, String(req.body.name ?? ''), Array.isArray(req.body.userIds) ? req.body.userIds : []);
    broadcastToChat(chatId, { t: 'chat.created', chat: chatSummary(db, chatId) });
    res.status(201).json({ chatId });
    return;
  }
  res.status(400).json({ error: 'type must be "private" or "group"' });
}));

router.get('/chats/:id/messages', requireAuth, wrap(async (req, res) => {
  const chatId = Number(req.params.id);
  const before = req.query.before != null ? Number(req.query.before) : undefined;
  const limit = req.query.limit != null ? Number(req.query.limit) : 50;
  const messages = listMessages(getDb(), req.userId, chatId, before, limit);
  res.json({ messages });
}));

router.post('/chats/:id/read', requireAuth, wrap(async (req, res) => {
  const chatId = Number(req.params.id);
  const msgId = Number(req.body.msgId);
  if (!Number.isInteger(msgId)) {
    res.status(400).json({ error: 'msgId is required' });
    return;
  }
  markRead(getDb(), req.userId, chatId, msgId);
  res.json({ ok: true });
}));

/**
 * Group description — the blurb on the group info page.
 * Admin only, trimmed, capped; broadcast so every member's header updates.
 */
router.patch('/chats/:id', requireAuth, wrap(async (req, res) => {
  const chatId = Number(req.params.id);
  const { description } = req.body ?? {};
  if (description !== undefined && typeof description !== 'string') {
    throw new BadRequest('description must be a string');
  }
  const db = getDb();
  const chat = db.prepare('SELECT type FROM chats WHERE id = ?').get(chatId) as { type: string } | undefined;
  if (!chat) throw new NotFound('Chat not found');
  if (chat.type !== 'group') throw new BadRequest('Only groups have a description');
  const role = db
    .prepare('SELECT role FROM chat_members WHERE chat_id = ? AND user_id = ?')
    .get(chatId, req.userId) as { role: string } | undefined;
  if (!role) throw new Forbidden('You are not a member of this chat');
  if (role.role !== 'admin') throw new Forbidden('Only the group admin can edit it');
  if (description !== undefined) {
    const clean = description.trim();
    if (clean.length > 255) throw new BadRequest('description must be at most 255 characters');
    db.prepare('UPDATE chats SET description = ? WHERE id = ?').run(clean || null, chatId);
    broadcastToChat(chatId, { t: 'chat.updated', chat: chatSummary(db, chatId) });
  }
  res.json({ chat: chatSummary(db, chatId) });
}));

router.post('/chats/:id/members', requireAuth, wrap(async (req, res) => {
  const chatId = Number(req.params.id);
  const newUserId = Number(req.body.userId);
  if (!Number.isInteger(newUserId)) {
    res.status(400).json({ error: 'userId is required' });
    return;
  }
  const db = getDb();
  addMember(db, req.userId, chatId, newUserId);

  const summary = chatSummary(db, chatId);
  broadcastToChat(chatId, { t: 'chat.member', cid: chatId, action: 'added', userId: newUserId, chat: summary });
  sendToUser(newUserId, { t: 'chat.created', chat: summary }); // new member (and their devices) gets the chat
  res.status(200).json({ members: summary.members });
}));

router.delete('/chats/:id/members', requireAuth, wrap(async (req, res) => {
  const chatId = Number(req.params.id);
  const targetUserId = Number(req.body.userId);
  if (!Number.isInteger(targetUserId)) {
    res.status(400).json({ error: 'userId is required' });
    return;
  }
  removeMember(getDb(), req.userId, chatId, targetUserId);

  broadcastToChat(chatId, { t: 'chat.member', cid: chatId, action: 'removed', userId: targetUserId });
  sendToUser(targetUserId, { t: 'chat.removed', cid: chatId }); // removed user drops the chat from their UI
  res.json({ ok: true });
}));

/** Leave a group. Last member leaving deletes the chat entirely. */
router.post('/chats/:id/leave', requireAuth, wrap(async (req, res) => {
  const chatId = Number(req.params.id);
  const db = getDb();
  const chatDeleted = leaveGroup(db, req.userId, chatId);
  if (!chatDeleted) {
    // remaining members get the updated member list; the leaver's devices drop the chat
    const summary = chatSummary(db, chatId);
    broadcastToChat(chatId, { t: 'chat.member', cid: chatId, action: 'left', userId: req.userId, chat: summary });
  }
  sendToUser(req.userId, { t: 'chat.removed', cid: chatId });
  res.json({ ok: true, chatDeleted });
}));

/** Admin destroys a group — all members' devices drop it. */
router.delete('/chats/:id', requireAuth, wrap(async (req, res) => {
  const chatId = Number(req.params.id);
  const db = getDb();
  const ids = memberIds(db, chatId); // capture before the cascade wipes membership
  deleteGroup(db, req.userId, chatId);
  for (const id of ids) sendToUser(id, { t: 'chat.deleted', cid: chatId });
  res.json({ ok: true });
}));

export default router;
