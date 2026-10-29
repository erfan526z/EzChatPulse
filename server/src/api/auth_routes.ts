import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { getDb, getSetting } from '../db.js';
import { register, login, requireAuth, getUserById, getPrivateUser, updateDisplayName, changePassword, setEmail } from '../auth.js';
import { isOnline, broadcastUserUpdate } from '../ws/hub.js';
import { rateLimit } from '../rate-limit.js';
import { config } from '../config.js';
import { BadRequest } from '../errors.js';
import { createChallenge, verifyChallenge } from '../services/captcha.js';

const router = Router();

// ── captcha policy + failed-login tracking ──────────────────────────────

/** In-memory failed-login counters (per username, 15-minute window). */
const loginFailures = new Map<string, { count: number; firstAt: number }>();
const FAILURE_WINDOW_MS = 15 * 60_000;
const FAILURE_MAX_KEYS = 5_000;

function captchaPolicy(db: ReturnType<typeof getDb>): { enabled: boolean; threshold: number } {
  const enabled = getSetting(db, 'captcha_enabled', 'true') === 'true';
  const raw = Number(getSetting(db, 'captcha_after_failures', '3'));
  const threshold = Number.isFinite(raw) ? Math.max(0, Math.min(50, Math.trunc(raw))) : 3;
  return { enabled, threshold };
}

function failureCount(key: string): number {
  const state = loginFailures.get(key);
  if (!state) return 0;
  if (Date.now() - state.firstAt > FAILURE_WINDOW_MS) {
    loginFailures.delete(key);
    return 0;
  }
  return state.count;
}

function recordFailure(key: string): number {
  const now = Date.now();
  const state = loginFailures.get(key);
  if (!state || now - state.firstAt > FAILURE_WINDOW_MS) {
    if (loginFailures.size > FAILURE_MAX_KEYS) loginFailures.clear();
    loginFailures.set(key, { count: 1, firstAt: now });
    return 1;
  }
  state.count += 1;
  return state.count;
}

/** Wrap an async route handler so AppError is forwarded to Express error middleware. */
function wrap(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

/** N attempts per minute per IP on auth endpoints (brute-force guard). */
function authLimiter(req: Request, res: Response, next: NextFunction): void {
  if (!rateLimit(`auth:${req.ip}`, config.authRatePerMin, 60_000)) {
    res.status(429).json({ error: 'Too many attempts — try again in a minute' });
    return;
  }
  next();
}

router.post('/register', authLimiter, wrap(async (req, res) => {
  const db = getDb();
  if (getSetting(db, 'registration_open', process.env.REGISTRATION_OPEN ?? 'true') !== 'true') {
    res.status(403).json({ error: 'Registration is currently closed' });
    return;
  }
  const { username, displayName, password, email, captchaToken, captchaAnswer } = req.body ?? {};
  if (!username || !displayName || !password) {
    res.status(400).json({ error: 'username, displayName, and password are required' });
    return;
  }
  const policy = captchaPolicy(db);
  if (policy.enabled) {
    if (!captchaToken) {
      res.status(400).json({ error: 'Captcha required', captchaRequired: true, captcha: createChallenge() });
      return;
    }
    verifyChallenge(db, captchaToken, captchaAnswer); // 400 on wrong / expired / replayed
  }
  const result = register(getDb(), username, displayName, password, typeof email === 'string' ? email : undefined);
  res.status(201).json(result);
}));

router.post('/login', authLimiter, wrap(async (req, res) => {
  const db = getDb();
  const { username, password, captchaToken, captchaAnswer } = req.body ?? {};
  if (!username || !password) {
    res.status(400).json({ error: 'username and password are required' });
    return;
  }

  const policy = captchaPolicy(db);
  const key = String(username).trim().toLowerCase();
  const failures = failureCount(key);
  const requiresCaptcha = policy.enabled && policy.threshold > 0 && failures >= policy.threshold;

  if (requiresCaptcha) {
    if (!captchaToken) {
      res.status(400).json({
        error: 'Too many failed attempts — solve the captcha to continue',
        captchaRequired: true,
        captcha: createChallenge(),
      });
      return;
    }
    verifyChallenge(db, captchaToken, captchaAnswer);
  }

  try {
    const result = login(db, username, password);
    loginFailures.delete(key);
    res.json({ ...result, user: { ...result.user, online: isOnline(result.user.id) } });
  } catch (err) {
    const count = recordFailure(key);
    if (policy.enabled && policy.threshold > 0 && count >= policy.threshold) {
      // hand back a challenge so the client can render it immediately
      res.status((err as { statusCode?: number }).statusCode ?? 401).json({
        error: 'Invalid username or password — captcha required from now on',
        captchaRequired: true,
        captcha: createChallenge(),
      });
      return;
    }
    throw err;
  }
}));

router.get('/me', requireAuth, wrap(async (req, res) => {
  const user = getPrivateUser(getDb(), req.userId);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json({ user: { ...user, online: isOnline(user.id) } });
}));

/**
 * PATCH /api/me — update profile fields.
 * Body: { displayName?: string }, { currentPassword, newPassword } and/or { email }.
 * A display-name change is fanned out in real time to everyone who shares a chat
 * (email is private — never broadcast, never in public DTOs).
 */
router.patch('/me', requireAuth, wrap(async (req, res) => {
  const { displayName, currentPassword, newPassword, email } = req.body ?? {};
  const userId = req.userId;
  let privateUser = getPrivateUser(getDb(), userId);
  if (!privateUser) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  let changed = false;
  if (displayName !== undefined) {
    updateDisplayName(getDb(), userId, displayName);
    privateUser = getPrivateUser(getDb(), userId)!;
    changed = true;
  }
  if (newPassword !== undefined) {
    if (typeof currentPassword !== 'string') throw new BadRequest('currentPassword is required to change the password');
    changePassword(getDb(), userId, currentPassword, newPassword);
    changed = true;
  }
  if (email !== undefined) {
    if (typeof email !== 'string') throw new BadRequest('email must be a string');
    privateUser = setEmail(getDb(), userId, email);
    changed = true;
  }
  if (!changed) throw new BadRequest('Nothing to update');
  if (displayName !== undefined) {
    // public DTO only — email never leaves this server in broadcasts
    broadcastUserUpdate(userId, { t: 'user.updated', user: getUserById(getDb(), userId) });
  }
  res.json({ user: { ...privateUser, online: isOnline(privateUser.id) } });
}));

export default router;
