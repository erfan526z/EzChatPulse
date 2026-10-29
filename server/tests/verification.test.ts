import { test, beforeEach, after } from "node:test";
import assert from 'node:assert/strict';
import { createTestContext, registerUser, type TestContext } from './helpers.js';
import { setMailTransport } from '../src/services/mailer.js';
import { createVerificationToken, verifyEmailToken } from '../src/services/verification.js';
import { getDb } from '../src/db.js';

/** Capture outgoing mail instead of hitting the network. */
const outbox: Array<{ to: string; subject: string; html: string; text?: string }> = [];
setMailTransport(async (m) => {
  outbox.push(m);
  return { sent: true, id: `test-${outbox.length}` };
});
after(() => setMailTransport(null));

function authed(port: number, token: string, path: string, options: RequestInit = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${token}`, ...(options.headers ?? {}) },
  });
}

function tokenFromMail(html: string): string {
  const m = html.match(/\/verify\?token=([^"&\s]+)/);
  if (!m) throw new Error('no verification link in email');
  return decodeURIComponent(m[1]);
}

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createTestContext();
  outbox.length = 0;
  delete process.env.ADMIN_USERNAMES_OVERRIDE;
});

// ── tokens ──────────────────────────────────────────────────────────────

test('verification token: valid for the same address, fails when tampered or expired', async () => {
  try {
    const db = getDb();
    const user = db
      .prepare('INSERT INTO users (username, display_name, password_hash, created_at, email) VALUES (?,?,?,?,?)')
      .run('tokuser', 'Tok User', 'x', Date.now(), 'tok@example.com');
    const id = Number(user.lastInsertRowid);

    const token = createVerificationToken(id, 'tok@example.com');
    assert.equal(verifyEmailToken(db, token).userId, id);
    const row = db.prepare('SELECT email_verified FROM users WHERE id = ?').get(id) as { email_verified: number };
    assert.equal(row.email_verified, 1, 'account marked verified');

    // tampered signature
    const [v, uid, exp, sig] = token.split('.');
    assert.throws(() => verifyEmailToken(db, `${v}.${uid}.${exp}.${sig.slice(0, -2)}XX`), /not valid/);
    // garbage
    assert.throws(() => verifyEmailToken(db, 'nope'), /not valid/);
    // unknown user
    assert.throws(() => verifyEmailToken(db, `v1.999999.${exp}.${sig}`), /not valid|not found/i);
    // expired
    const expired = createVerificationToken(id, 'tok@example.com').replace(
      /^v1\.(\d+)\.(\d+)\./,
      (_m, u, e) => `v1.${u}.${Number(e) - 100000}.`,
    );
    assert.throws(() => verifyEmailToken(db, expired), /expired|not valid/);
  } finally {
    await ctx.close();
  }
});

test('verification token is bound to the address (changing email invalidates it)', async () => {
  try {
    const db = getDb();
    const user = db
      .prepare('INSERT INTO users (username, display_name, password_hash, created_at, email) VALUES (?,?,?,?,?)')
      .run('bound', 'Bound', 'x', Date.now(), 'old@example.com');
    const id = Number(user.lastInsertRowid);
    const token = createVerificationToken(id, 'old@example.com');

    db.prepare('UPDATE users SET email = ? WHERE id = ?').run('new@example.com', id);
    assert.throws(() => verifyEmailToken(db, token), /not valid/);
  } finally {
    await ctx.close();
  }
});

// ── sending ─────────────────────────────────────────────────────────────

test('setting an email sends a verification message with a working link', async () => {
  try {
    const user = await registerUser(ctx, 'mailer', 'Mailer', 'password123');
    const res = await authed(ctx.port, user.token, '/api/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'mailer@example.com' }),
    });
    assert.equal(res.status, 200);

    // fire-and-forget: give the microtask a moment
    for (let i = 0; i < 40 && outbox.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(outbox.length, 1, 'one email sent');
    assert.equal(outbox[0].to, 'mailer@example.com');
    assert.match(outbox[0].subject, /confirm your email/i);

    const token = tokenFromMail(outbox[0].html);
    const verified = verifyEmailToken(getDb(), token);
    assert.equal(verified.email, 'mailer@example.com');
  } finally {
    await ctx.close();
  }
});

test('resend endpoint: works once, then respects the 60s cooldown', async () => {
  try {
    const user = await registerUser(ctx, 'resend', 'Resend', 'password123');
    await authed(ctx.port, user.token, '/api/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'resend@example.com' }),
    });
    for (let i = 0; i < 40 && outbox.length === 0; i++) await new Promise((r) => setTimeout(r, 25));

    const first = await authed(ctx.port, user.token, '/api/me/verify-email', { method: 'POST' });
    assert.equal(first.status, 400, 'cooldown right after the signup mail');
    const body = (await first.json()) as { error: string };
    assert.match(body.error, /wait/i);
  } finally {
    await ctx.close();
  }
});

test('a verified account cannot be asked to verify again', async () => {
  try {
    const user = await registerUser(ctx, 'already', 'Already', 'password123');
    await authed(ctx.port, user.token, '/api/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'already@example.com' }),
    });
    for (let i = 0; i < 40 && outbox.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    verifyEmailToken(getDb(), tokenFromMail(outbox[0].html));

    const res = await authed(ctx.port, user.token, '/api/me/verify-email', { method: 'POST' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { sent: false, error: 'already verified' });
  } finally {
    await ctx.close();
  }
});

// ── /api/me shape ───────────────────────────────────────────────────────

test('/api/me exposes the verification state and the admin policy flag', async () => {
  try {
    const user = await registerUser(ctx, 'shape', 'Shape', 'password123');
    const res = await authed(ctx.port, user.token, '/api/me');
    const body = (await res.json()) as any;
    assert.equal(body.user.email, null);
    assert.equal(body.user.emailVerified, false);
    assert.equal(body.requireVerifiedEmail, false, 'off by default so existing accounts keep working');
  } finally {
    await ctx.close();
  }
});

// ── admin controls ──────────────────────────────────────────────────────

test('admin: require-verified toggle, manual verify, and stats counts', async () => {
  const previous = process.env.ADMIN_USERNAMES;
  process.env.ADMIN_USERNAMES = 'admin';
  try {
    const admin = await registerUser(ctx, 'admin', 'Admin', 'password123');
    const other = await registerUser(ctx, 'other', 'Other', 'password123');

    const on = await authed(ctx.port, admin.token, '/api/admin/require-verified-email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(on.status, 200);
    assert.equal(((await on.json()) as any).requireVerifiedEmail, true);

    const stats = (await (await authed(ctx.port, admin.token, '/api/admin/stats')).json()) as any;
    assert.equal(stats.requireVerifiedEmail, true);
    assert.equal(stats.emailVerified, 0);
    assert.equal(stats.pendingVerification, 2);

    // manual verify (no email on file — admin decides the account is fine)
    const verified = await authed(ctx.port, admin.token, `/api/admin/users/${other.user.id}/verify-email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(verified.status, 200);

    const after = (await (await authed(ctx.port, admin.token, '/api/admin/stats')).json()) as any;
    assert.equal(after.pendingVerification, 1);

    // non-admin cannot toggle it
    const denied = await authed(ctx.port, other.token, '/api/admin/require-verified-email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(denied.status, 403);
  } finally {
    if (previous === undefined) delete process.env.ADMIN_USERNAMES;
    else process.env.ADMIN_USERNAMES = previous;
    await ctx.close();
  }
});

test('enforcement: unverified accounts are blocked from sending while the switch is on', async () => {
  const previous = process.env.ADMIN_USERNAMES;
  process.env.ADMIN_USERNAMES = 'admin';
  try {
    const { sendingBlockedByVerification } = await import('../src/services/verification.js');
    const admin = await registerUser(ctx, 'admin', 'Admin', 'password123');
    const blocked = await registerUser(ctx, 'blocked', 'Blocked', 'password123');

    // switch off → nobody is blocked
    assert.equal(sendingBlockedByVerification(getDb(), blocked.user.id), false);

    await authed(ctx.port, admin.token, '/api/admin/require-verified-email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });

    // no email at all → blocked
    assert.equal(sendingBlockedByVerification(getDb(), blocked.user.id), true);

    // email set but unverified → still blocked
    await authed(ctx.port, blocked.token, '/api/me', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'blocked@example.com' }),
    });
    assert.equal(sendingBlockedByVerification(getDb(), blocked.user.id), true);

    // verified → allowed
    for (let i = 0; i < 40 && outbox.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    verifyEmailToken(getDb(), tokenFromMail(outbox[0].html));
    assert.equal(sendingBlockedByVerification(getDb(), blocked.user.id), false);
  } finally {
    if (previous === undefined) delete process.env.ADMIN_USERNAMES;
    else process.env.ADMIN_USERNAMES = previous;
    await ctx.close();
  }
});
