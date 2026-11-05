import { Router } from 'express';
import { getDb, getSetting } from '../db.js';
import { isAdminUsername } from '../config.js';
import { requireAuth, getUserById, searchUsers, avatarUrlOf } from '../auth.js';
import { isOnline } from '../ws/hub.js';
import { BadRequest, Forbidden, NotFound } from '../errors.js';

const router = Router();

/**
 * User search.
 *
 * Secure default: a non-admin only finds an account by its FULL username or FULL
 * display name — no substring scanning, so the user list cannot be harvested one
 * letter at a time. Admins keep substring search so they can manage accounts, and
 * the admin panel can relax it for everyone via the `strict_search` setting.
 */
router.get('/', requireAuth, (req, res) => {
  const q = String(req.query.q ?? '');
  const db = getDb();
  const me = getUserById(db, req.userId);
  const strictSetting = getSetting(db, 'strict_search', 'true') === 'true';
  const isAdmin = me ? isAdminUsername(me.username) : false;

  const users = searchUsers(db, q, { strict: strictSetting && !isAdmin }).map((u) => ({
    ...u,
    online: isOnline(u.id),
  }));
  res.json({ users });
});

/**
 * A person's profile: name, username, bio, picture and the groups you share.
 *
 * Access follows the same principle as strict search — a non-admin can only look
 * at someone they already share a chat with, so profile ids (which are sequential)
 * cannot be walked to harvest names and bios. Admins can view anyone.
 */
router.get('/:id/profile', requireAuth, (req, res) => {
  const targetId = Number(req.params.id);
  if (!Number.isInteger(targetId) || targetId <= 0) throw new BadRequest('Invalid user id');

  const db = getDb();
  const me = getUserById(db, req.userId);
  if (!me) throw new Forbidden('Unknown account');

  const row = db
    .prepare('SELECT id, username, display_name, created_at, bio, avatar_file_id, last_seen_at FROM users WHERE id = ?')
    .get(targetId) as
    | {
        id: number;
        username: string;
        display_name: string;
        created_at: number;
        bio: string | null;
        avatar_file_id: number | null;
        last_seen_at: number | null;
      }
    | undefined;
  if (!row) throw new NotFound('User not found');

  const isSelf = targetId === req.userId;
  const isAdmin = isAdminUsername(me.username);

  // chats the two accounts both belong to — this is also the common-group list
  const shared = db
    .prepare(
      `SELECT c.id, c.type, c.name, c.created_at
       FROM chats c
       JOIN chat_members a ON a.chat_id = c.id AND a.user_id = ?
       JOIN chat_members b ON b.chat_id = c.id AND b.user_id = ?
       ORDER BY c.type, c.name COLLATE NOCASE, c.id`,
    )
    .all(req.userId, targetId) as Array<{ id: number; type: 'private' | 'group'; name: string | null; created_at: number }>;

  if (!isSelf && !isAdmin && shared.length === 0) {
    throw new Forbidden('You can only view the profile of someone you share a chat with');
  }

  res.json({
    user: {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      createdAt: row.created_at,
      bio: row.bio,
      avatarUrl: avatarUrlOf(row.avatar_file_id),
      online: isOnline(row.id),
      lastSeenAt: row.last_seen_at,
    },
    commonGroups: shared
      .filter((c) => c.type === 'group')
      .map((c) => ({ id: c.id, name: c.name ?? 'Group', createdAt: c.created_at })),
    sharedPrivateChat: shared.some((c) => c.type === 'private'),
  });
});

export default router;
