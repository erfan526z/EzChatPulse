import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, registerUser, solveCaptchaSvg, solvedCaptcha } from './helpers.js';
import { createChallenge, verifyChallenge, resetCaptchaCounters, captchaCounters } from '../src/services/captcha.js';
import { getDb } from '../src/db.js';

/** HTTP helpers against a running test context. */
function helpers(port: number) {
  const post = async (path: string, body: unknown, token?: string) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  };
  const get = async (path: string) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  };
  return { post, get };
}

test('challenge: returns a token, an SVG question and a TTL', async () => {
  const ctx = await createTestContext();
  try {
    const { get } = helpers(ctx.port);
    const res = await get('/api/captcha');
    assert.equal(res.status, 200);
    assert.match(res.body.token, /^v1\.\d+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.match(res.body.svg, /^<svg[\s\S]*<\/svg>$/);
    assert.ok(res.body.svg.includes('<text'), 'question is rendered as text');
    assert.equal(res.body.expiresInSec, 300);
    // the answer must NOT be sent to the client in any form
    const parsed = solveCaptchaSvg(res.body.svg);
    assert.ok(Number.isInteger(Number(parsed)), 'question is solvable from the rendered text');
  } finally {
    await ctx.close();
  }
});

test('verify: correct answer passes, wrong answer fails, tampering fails', async () => {
  const ctx = await createTestContext();
  try {
    const db = getDb();
    resetCaptchaCounters();

    const c = createChallenge();
    const answer = solveCaptchaSvg(c.svg);
    assert.doesNotThrow(() => verifyChallenge(db, c.token, answer));

    const c2 = createChallenge();
    const answer2 = solveCaptchaSvg(c2.svg);
    assert.throws(() => verifyChallenge(db, c2.token, String(Number(answer2) + 1)), /incorrect/);

    // tampered signature — the HMAC no longer matches (reported as a wrong answer,
    // which is the same 400 outcome as "invalid")
    const parts = createChallenge().token.split('.');
    parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith('AA') ? 'BB' : 'AA');
    assert.throws(() => verifyChallenge(db, parts.join('.'), '1'), /incorrect|invalid/);

    // malformed tokens
    assert.throws(() => verifyChallenge(db, 'garbage', '1'), /invalid/);
    assert.throws(() => verifyChallenge(db, '', '1'), /invalid/);
    assert.throws(() => verifyChallenge(db, undefined, '1'), /invalid/);

    assert.ok(captchaCounters().failures >= 1, 'failures are counted for the admin stats');
    assert.ok(captchaCounters().solved >= 1, 'solves are counted');
  } finally {
    await ctx.close();
  }
});

test('verify: expired challenges are rejected', async () => {
  const ctx = await createTestContext();
  try {
    const db = getDb();
    const c = createChallenge();
    const answer = solveCaptchaSvg(c.svg);
    const [, exp, nonce, sig] = c.token.split('.');
    // re-issue the same signature with a timestamp in the past
    const expired = `v1.${Number(exp) - 400}.${nonce}.${sig}`;
    assert.throws(() => verifyChallenge(db, expired, answer), /expired|invalid/);
  } finally {
    await ctx.close();
  }
});

test('verify: a solved token cannot be replayed (single use)', async () => {
  const ctx = await createTestContext();
  try {
    const db = getDb();
    const c = createChallenge();
    const answer = solveCaptchaSvg(c.svg);
    assert.doesNotThrow(() => verifyChallenge(db, c.token, answer));
    assert.throws(() => verifyChallenge(db, c.token, answer), /already used/);
  } finally {
    await ctx.close();
  }
});

test('registration requires a captcha when enabled (default) and accepts a solved one', async () => {
  const ctx = await createTestContext();
  const { post } = helpers(ctx.port);
  try {
    const withoutCaptcha = await post('/api/register', {
      username: 'nocap',
      displayName: 'No Cap',
      password: 'password123',
    });
    assert.equal(withoutCaptcha.status, 400);
    assert.equal(withoutCaptcha.body.captchaRequired, true);
    assert.ok(withoutCaptcha.body.captcha?.svg, 'a challenge is returned so the client can render it');

    const wrong = await post('/api/register', {
      username: 'wrongcap',
      displayName: 'Wrong Cap',
      password: 'password123',
      captchaToken: withoutCaptcha.body.captcha.token,
      captchaAnswer: 'NaN',
    });
    assert.equal(wrong.status, 400);

    // a fresh, correctly solved challenge succeeds
    const ok = await post('/api/register', {
      username: 'realcap',
      displayName: 'Real Cap',
      password: 'password123',
      ...(await solvedCaptcha(ctx.port)),
    });
    assert.equal(ok.status, 201);
  } finally {
    await ctx.close();
  }
});

test('admin can disable the captcha (registration then needs none)', async () => {
  const ctx = await createTestContext();
  const { post } = helpers(ctx.port);
  const previous = process.env.ADMIN_USERNAMES;
  process.env.ADMIN_USERNAMES = 'admin';
  try {
    const admin = await registerUser(ctx, 'admin', 'Admin', 'password123');

    const off = await post('/api/admin/captcha', { enabled: false }, admin.token);
    assert.equal(off.status, 200);
    assert.equal(off.body.captchaEnabled, false);

    const registered = await post('/api/register', {
      username: 'freeuser',
      displayName: 'Free User',
      password: 'password123',
    });
    assert.equal(registered.status, 201, 'no captcha needed while disabled');

    const backOn = await post('/api/admin/captcha', { enabled: true, afterFailures: 2 }, admin.token);
    assert.equal(backOn.body.captchaEnabled, true);
    assert.equal(backOn.body.captchaAfterFailures, 2);

    const blockedAgain = await post('/api/register', {
      username: 'freeuser2',
      displayName: 'Free User 2',
      password: 'password123',
    });
    assert.equal(blockedAgain.status, 400);
    assert.equal(blockedAgain.body.captchaRequired, true);
  } finally {
    if (previous === undefined) delete process.env.ADMIN_USERNAMES;
    else process.env.ADMIN_USERNAMES = previous;
    await ctx.close();
  }
});

test('non-admins cannot change captcha settings', async () => {
  const ctx = await createTestContext();
  const { post } = helpers(ctx.port);
  try {
    const user = await registerUser(ctx, 'plainuser', 'Plain', 'password123');
    const res = await post('/api/admin/captcha', { enabled: false }, user.token);
    assert.equal(res.status, 403);
  } finally {
    await ctx.close();
  }
});

test('login demands a captcha after the configured number of failures', async () => {
  const ctx = await createTestContext();
  const { post } = helpers(ctx.port);
  const previous = process.env.ADMIN_USERNAMES;
  process.env.ADMIN_USERNAMES = 'admin';
  try {
    const admin = await registerUser(ctx, 'admin', 'Admin', 'password123');
    await registerUser(ctx, 'target', 'Target', 'password123');
    // threshold 2: the 3rd attempt must carry a captcha
    await post('/api/admin/captcha', { enabled: true, afterFailures: 2 }, admin.token);

    const first = await post('/api/login', { username: 'target', password: 'nope' });
    assert.equal(first.status, 401);
    assert.notEqual(first.body.captchaRequired, true, 'no captcha on the first failure');

    const second = await post('/api/login', { username: 'target', password: 'nope' });
    assert.equal(second.status, 401);
    assert.equal(second.body.captchaRequired, true, 'captcha appears when the threshold is reached');
    assert.ok(second.body.captcha?.svg);

    // third attempt without solving → rejected as captcha-required, even with the RIGHT password
    const thirdNoSolve = await post('/api/login', { username: 'target', password: 'password123' });
    assert.equal(thirdNoSolve.status, 400);
    assert.equal(thirdNoSolve.body.captchaRequired, true);

    // solving it lets the correct password through
    const solved = await post('/api/login', {
      username: 'target',
      password: 'password123',
      ...(await solvedCaptcha(ctx.port)),
    });
    assert.equal(solved.status, 200);
    assert.ok(solved.body.token);
  } finally {
    if (previous === undefined) delete process.env.ADMIN_USERNAMES;
    else process.env.ADMIN_USERNAMES = previous;
    await ctx.close();
  }
});

test('a successful login clears the failure counter', async () => {
  const ctx = await createTestContext();
  const { post } = helpers(ctx.port);
  const previous = process.env.ADMIN_USERNAMES;
  process.env.ADMIN_USERNAMES = 'admin';
  try {
    const admin = await registerUser(ctx, 'admin', 'Admin', 'password123');
    await registerUser(ctx, 'clearme', 'Clear Me', 'password123');
    await post('/api/admin/captcha', { enabled: true, afterFailures: 3 }, admin.token);

    await post('/api/login', { username: 'clearme', password: 'bad1' });
    await post('/api/login', { username: 'clearme', password: 'bad2' });
    const ok = await post('/api/login', { username: 'clearme', password: 'password123' });
    assert.equal(ok.status, 200);

    // counter reset → the next two failures must not trigger a captcha
    const after1 = await post('/api/login', { username: 'clearme', password: 'bad3' });
    assert.equal(after1.status, 401);
    assert.notEqual(after1.body.captchaRequired, true, 'failures were cleared by the successful login');
  } finally {
    if (previous === undefined) delete process.env.ADMIN_USERNAMES;
    else process.env.ADMIN_USERNAMES = previous;
    await ctx.close();
  }
});
