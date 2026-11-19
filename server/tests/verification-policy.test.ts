import { test, beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, destroyTestContext, registerUser, solvedCaptcha, type TestContext } from './helpers.js';
import { setMailTransport } from '../src/services/mailer.js';
import {
  createVerificationToken,
  requireVerifiedEmailSetting,
  sendingBlockedByVerification,
  verifyEmailToken,
} from '../src/services/verification.js';
import { getDb, setSetting } from '../src/db.js';

/**
 * Turning email verification on, without locking anyone out.
 *
 * The policy: from the moment it is switched on, an address is required to sign
 * up and an unverified account cannot send. Accounts that already existed are
 * grandfathered (migration v13 sets `verification_exempt = 1`), because most of
 * them never gave an address and could not verify if asked.
 */

let ctx: TestContext;
const outbox: Array<{ to: string; subject: string; html: string }> = [];

beforeEach(async () => {
  ctx = await createTestContext();
  outbox.length = 0;
});

afterEach(async () => {
  await destroyTestContext(ctx);
});

after(() => setMailTransport(null));

setMailTransport(async (m) => {
  outbox.push(m);
  return { sent: true, id: `t-${outbox.length}` };
});

const enablePolicy = (): void => {
  setSetting(getDb(), 'require_verified_email', 'true');
};

/** Signup as it actually happens once the policy is on: address plus captcha. */
async function registerWithEmail(username: string, email: string): Promise<{ token: string; user: { id: number } }> {
  const res = await fetch(`http://127.0.0.1:${ctx.port}/api/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username,
      displayName: username,
      password: 'password123',
      email,
      ...(await solvedCaptcha(ctx.port)),
    }),
  });
  if (res.status !== 201) throw new Error(`register failed (${res.status}): ${await res.text()}`);
  return res.json() as Promise<{ token: string; user: { id: number } }>;
}

test('policy is off by default and blocks nobody', async () => {
  const alice = await registerUser(ctx, 'alice', 'Alice', 'password123');
  assert.equal(requireVerifiedEmailSetting(getDb()), false);
  assert.equal(sendingBlockedByVerification(getDb(), alice.user.id), false);
});

test('an account that predates the policy keeps sending (grandfathered)', async () => {
  const bob = await registerUser(ctx, 'bob', 'Bob', 'password123');
  // simulate what migration v13 did for accounts that existed at the switch
  getDb().prepare('UPDATE users SET verification_exempt = 1 WHERE id = ?').run(bob.user.id);
  enablePolicy();
  assert.equal(requireVerifiedEmailSetting(getDb()), true);
  assert.equal(
    sendingBlockedByVerification(getDb(), bob.user.id),
    false,
    'an existing account must not be silenced by flipping the switch',
  );
});

test('a new unverified account cannot send, and can after verifying', async () => {
  enablePolicy();
  const carol = await registerWithEmail('carol', 'carol@example.com');
  assert.equal(sendingBlockedByVerification(getDb(), carol.user.id), true, 'new account starts blocked');

  const token = createVerificationToken(carol.user.id, 'carol@example.com');
  verifyEmailToken(getDb(), token);
  assert.equal(sendingBlockedByVerification(getDb(), carol.user.id), false, 'verifying unblocks sending');
});

test('signup requires a usable address once the policy is on', async () => {
  const base = `http://127.0.0.1:${ctx.port}`;
  const attempt = (body: Record<string, unknown>) =>
    fetch(`${base}/api/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  // bypassing captcha: the default policy is threshold-based and a first signup
  // from a fresh limiter is allowed, same as the other registration tests
  enablePolicy();

  const withoutEmail = await attempt({ username: 'dave', displayName: 'Dave', password: 'password123' });
  assert.equal(withoutEmail.status, 400);
  const body = (await withoutEmail.json()) as { error: string; emailRequired?: boolean };
  assert.match(body.error, /email address is required/i);
  assert.equal(body.emailRequired, true, 'the client uses this to mark the field required');

  const badEmail = await attempt({ username: 'dave', displayName: 'Dave', password: 'password123', email: 'nope' });
  assert.equal(badEmail.status, 400);

  const good = await attempt({
    username: 'dave',
    displayName: 'Dave',
    password: 'password123',
    email: 'dave@example.com',
    ...(await solvedCaptcha(ctx.port)),
  });
  assert.equal(good.status, 201, 'a valid address gets through');
  assert.equal(outbox.length > 0, true, 'and a confirmation mail goes out');
});

test('the signup form can ask what the server requires', async () => {
  const base = `http://127.0.0.1:${ctx.port}`;
  const before = await (await fetch(`${base}/api/registration-policy`)).json();
  assert.deepEqual(before, { open: true, emailRequired: false });

  enablePolicy();
  const after = await (await fetch(`${base}/api/registration-policy`)).json();
  assert.deepEqual(after, { open: true, emailRequired: true });
});
