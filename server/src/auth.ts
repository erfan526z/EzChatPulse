import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { config } from './config.js';
import type { Db } from './db.js';
import { BadRequest, Conflict, Unauthorized } from './errors.js';

const SALT_ROUNDS = 10;

// ── DTO ────────────────────────────────────────────────────────────────
export interface UserDTO {
  id: number;
  username: string;
  displayName: string;
  createdAt: number;
}

/** Private profile shape — only ever returned to the user themselves. */
export interface PrivateUser extends UserDTO {
  email: string | null;
  emailVerified: boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function toDTO(row: {
  id: number;
  username: string;
  display_name: string;
  created_at: number;
}): UserDTO {
  return { id: row.id, username: row.username, displayName: row.display_name, createdAt: row.created_at };
}

export function toPrivateDTO(row: {
  id: number;
  username: string;
  display_name: string;
  created_at: number;
  email: string | null;
  email_verified: number;
}): PrivateUser {
  return {
    ...toDTO(row),
    email: row.email ?? null,
    emailVerified: row.email_verified === 1,
  };
}

export function isValidEmail(email: string): boolean {
  return email.length <= 254 && EMAIL_RE.test(email);
}

// ── Registration ───────────────────────────────────────────────────────
export function register(
  db: Db,
  username: string,
  displayName: string,
  password: string,
  email?: string,
): { token: string; user: UserDTO } {
  if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
    throw new BadRequest('Username must be 3–32 alphanumeric characters or underscores');
  }
  if (password.length < 8) {
    throw new BadRequest('Password must be at least 8 characters');
  }
  const cleanEmail = email?.trim() ?? '';
  if (cleanEmail && !isValidEmail(cleanEmail)) {
    throw new BadRequest('Invalid email address');
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) throw new Conflict('Username is already taken');

  const hash = bcrypt.hashSync(password, SALT_ROUNDS);
  const now = Date.now();
  const info = db
    .prepare('INSERT INTO users (username, display_name, password_hash, created_at, email, email_verified) VALUES (?, ?, ?, ?, ?, 0)')
    .run(username, displayName, hash, now, cleanEmail || null);

  const user = toDTO({ id: Number(info.lastInsertRowid), username, display_name: displayName, created_at: now });
  const token = jwt.sign({ sub: user.id }, config.jwtSecret, { expiresIn: '7d' });
  return { token, user };
}

// ── Login ──────────────────────────────────────────────────────────────
export function login(
  db: Db,
  username: string,
  password: string,
): { token: string; user: UserDTO } {
  const row = db
    .prepare('SELECT id, username, display_name, password_hash, created_at FROM users WHERE username = ?')
    .get(username) as
    | { id: number; username: string; display_name: string; password_hash: string; created_at: number }
    | undefined;

  if (!row) throw new Unauthorized('Invalid username or password');
  if (!bcrypt.compareSync(password, row.password_hash)) throw new Unauthorized('Invalid username or password');

  const user = toDTO(row);
  const token = jwt.sign({ sub: user.id }, config.jwtSecret, { expiresIn: '7d' });
  return { token, user };
}

// ── Lookups ────────────────────────────────────────────────────────────
export function getUserById(db: Db, id: number): UserDTO | null {
  const row = db
    .prepare('SELECT id, username, display_name, created_at FROM users WHERE id = ?')
    .get(id) as { id: number; username: string; display_name: string; created_at: number } | undefined;
  return row ? toDTO(row) : null;
}

// ── Profile updates ────────────────────────────────────────────────────
export function updateDisplayName(db: Db, userId: number, displayName: string): UserDTO {
  const name = displayName.trim();
  if (!name) throw new BadRequest('Display name cannot be empty');
  if (name.length > 32) throw new BadRequest('Display name must be at most 32 characters');
  db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name, userId);
  const user = getUserById(db, userId);
  if (!user) throw new Unauthorized('User not found');
  return user;
}

export function changePassword(db: Db, userId: number, current: string, next: string): void {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as
    | { password_hash: string }
    | undefined;
  if (!row) throw new Unauthorized('User not found');
  if (!bcrypt.compareSync(current, row.password_hash)) throw new BadRequest('Current password is incorrect');
  if (next.length < 8) throw new BadRequest('New password must be at least 8 characters');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(next, SALT_ROUNDS), userId);
}

/**
 * Set the account email — allowed exactly once (email cannot be changed normally,
 * per spec: users without an email get one chance to set it).
 */
export function setEmail(db: Db, userId: number, email: string): PrivateUser {
  const row = db
    .prepare('SELECT id, username, display_name, created_at, email, email_verified FROM users WHERE id = ?')
    .get(userId) as
    | { id: number; username: string; display_name: string; created_at: number; email: string | null; email_verified: number }
    | undefined;
  if (!row) throw new Unauthorized('User not found');
  if (row.email) throw new BadRequest('Email is already set and cannot be changed');
  const clean = email.trim();
  if (!isValidEmail(clean)) throw new BadRequest('Invalid email address');
  db.prepare('UPDATE users SET email = ? WHERE id = ?').run(clean, userId);
  return toPrivateDTO({ ...row, email: clean });
}

/** Private profile (with email) — only for /api/me responses to the user themselves. */
export function getPrivateUser(db: Db, id: number): PrivateUser | null {
  const row = db
    .prepare('SELECT id, username, display_name, created_at, email, email_verified FROM users WHERE id = ?')
    .get(id) as
    | { id: number; username: string; display_name: string; created_at: number; email: string | null; email_verified: number }
    | undefined;
  return row ? toPrivateDTO(row) : null;
}

/**
 * User search.
 *
 * `strict` (the default) only returns an account when the query is the account's
 * FULL username or FULL display name (case-insensitive). That closes the
 * enumerate-the-userbase hole where typing one letter listed everyone whose name
 * contained it. Pass `strict: false` for admins / when the admin panel has
 * switched strict mode off, where substring matching is intended.
 */
export function searchUsers(db: Db, query: string, opts: { strict?: boolean } = {}): UserDTO[] {
  const q = query.trim();
  if (!q) return [];
  const strict = opts.strict !== false;

  type Row = { id: number; username: string; display_name: string; created_at: number };
  const sql = 'SELECT id, username, display_name, created_at FROM users WHERE ';
  const order = ' ORDER BY username LIMIT 20';

  let rows: Row[];
  if (strict) {
    rows = db
      .prepare(`${sql}(username = ? COLLATE NOCASE OR display_name = ? COLLATE NOCASE)${order}`)
      .all(q, q) as Row[];
  } else {
    // escape LIKE wildcards so a query of "%" cannot dump the whole user list
    const escaped = q.replace(/[\\%_]/g, (c) => `\\${c}`);
    rows = db
      .prepare(
        `${sql}(username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')${order}`,
      )
      .all(`%${escaped}%`, `%${escaped}%`) as Row[];
  }
  return rows.map(toDTO);
}

// ── Express middleware ─────────────────────────────────────────────────
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid authorization header' });
    return;
  }
  try {
    const payload = jwt.verify(header.slice(7), config.jwtSecret) as jwt.JwtPayload;
    const sub = Number(payload.sub);
    if (!Number.isInteger(sub)) throw new Error('invalid sub');
    req.userId = sub;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
