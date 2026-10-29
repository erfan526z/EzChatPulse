import { Router } from 'express';
import { getDb, getSetting } from '../db.js';
import { isAdminUsername } from '../config.js';
import { requireAuth, getUserById, searchUsers } from '../auth.js';
import { isOnline } from '../ws/hub.js';

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

export default router;
