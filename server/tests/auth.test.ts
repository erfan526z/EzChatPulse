import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import {
  createTestContext,
  destroyTestContext,
  registerUser,
  solvedCaptcha,
  wsConnectAuthed,
  waitForMessage,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(async () => {
  await destroyTestContext(ctx);
});

function api(path: string, options: RequestInit = {}) {
  return fetch(`http://127.0.0.1:${ctx.port}${path}`, options);
}

function authed(path: string, token: string, options: RequestInit = {}) {
  return api(path, {
    ...options,
    headers: { authorization: `Bearer ${token}`, ...(options.headers ?? {}) },
  });
}

// ── Registration ────────────────────────────────────────────────────────

test('register creates a user and returns a token', async () => {
  const res = await api('/api/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'alice',
      displayName: 'Alice',
      password: 'password123',
      ...(await solvedCaptcha(ctx.port)),
    }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as any;
  assert.equal(body.user.username, 'alice');
  assert.equal(body.user.displayName, 'Alice');
  assert.ok(body.user.id > 0);
  assert.ok(typeof body.token === 'string' && body.token.length > 20);
});

test('register rejects duplicate username with 409', async () => {
  await registerUser(ctx, 'bob', 'Bob', 'password123');
  const res = await api('/api/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'bob',
      displayName: 'Bob2',
      password: 'password123',
      ...(await solvedCaptcha(ctx.port)),
    }),
  });
  assert.equal(res.status, 409);
});

test('register rejects weak username and short password', async () => {
  const badUsername = await api('/api/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'a!',
      displayName: 'X',
      password: 'password123',
      ...(await solvedCaptcha(ctx.port)),
    }),
  });
  assert.equal(badUsername.status, 400);

  const shortPw = await api('/api/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'carol',
      displayName: 'Carol',
      password: 'short',
      ...(await solvedCaptcha(ctx.port)),
    }),
  });
  assert.equal(shortPw.status, 400);
});

// ── Login ───────────────────────────────────────────────────────────────

test('login succeeds with correct credentials', async () => {
  await registerUser(ctx, 'dave', 'Dave', 'password123');
  const res = await api('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'dave', password: 'password123' }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.user.username, 'dave');
  assert.ok(body.token);
  assert.equal(body.user.online, false); // not connected yet
});

test('login rejects wrong password with 401', async () => {
  await registerUser(ctx, 'erin', 'Erin', 'password123');
  const res = await api('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'erin', password: 'wrongpass' }),
  });
  assert.equal(res.status, 401);
});

test('login rejects unknown username with 401 (no user enumeration)', async () => {
  const res = await api('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'ghost', password: 'whatever123' }),
  });
  assert.equal(res.status, 401);
});

// ── /api/me ─────────────────────────────────────────────────────────────

test('/api/me returns the authenticated user', async () => {
  const { token } = await registerUser(ctx, 'frank', 'Frank', 'password123');
  const res = await authed('/api/me', token);
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.user.username, 'frank');
});

test('/api/me rejects missing/invalid tokens', async () => {
  const noToken = await api('/api/me');
  assert.equal(noToken.status, 401);

  const badToken = await authed('/api/me', 'not.a.jwt');
  assert.equal(badToken.status, 401);
});

// ── User search ─────────────────────────────────────────────────────────

test('/api/users?q= requires the FULL username (strict search by default)', async () => {
  await registerUser(ctx, 'alice', 'Alice', 'password123');
  await registerUser(ctx, 'bob', 'Bob', 'password123');
  const { token } = await registerUser(ctx, 'carol', 'Carol', 'password123');

  // partial name must NOT match anymore (this is what stopped user enumeration)
  const partial = await authed('/api/users?q=al', token);
  assert.equal(partial.status, 200);
  assert.equal(((await partial.json()) as any).users.length, 0);

  // the exact username does match
  const exact = await authed('/api/users?q=alice', token);
  const body = (await exact.json()) as any;
  assert.equal(body.users.length, 1);
  assert.equal(body.users[0].username, 'alice');
});

test('/api/users requires auth', async () => {
  const res = await api('/api/users?q=a');
  assert.equal(res.status, 401);
});

// ── WebSocket handshake ─────────────────────────────────────────────────

test('ws auth with valid token receives ready', async () => {
  const { token } = await registerUser(ctx, 'grace', 'Grace', 'password123');
  const ws = await wsConnectAuthed(ctx.port, token);
  assert.ok(ws.messages.some((m) => m.t === 'ready'));
  ws.close();
});

test('ws without auth receives AUTH_REQUIRED error', async () => {
  const ws = await new Promise<any>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${ctx.port}/ws`);
    const timer = setTimeout(() => reject(new Error('timeout')), 2000);
    socket.on('message', (data: unknown) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(data)));
    });
    socket.on('open', () => socket.send(JSON.stringify({ t: 'ping' })));
    socket.on('error', reject);
  });
  assert.equal(ws.t, 'error');
  assert.equal(ws.code, 'AUTH_REQUIRED');
});

test('ws with invalid token receives AUTH_FAILED', async () => {
  const ws = await new Promise<any>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${ctx.port}/ws`);
    const timer = setTimeout(() => reject(new Error('timeout')), 2000);
    socket.on('message', (data: unknown) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(data)));
    });
    socket.on('open', () => socket.send(JSON.stringify({ t: 'auth', token: 'bogus.token.here' })));
    socket.on('error', reject);
  });
  assert.equal(ws.t, 'error');
  assert.equal(ws.code, 'AUTH_FAILED');
});

test('online status flips true when ws connected, false after close', async () => {
  const { token, user } = await registerUser(ctx, 'heidi', 'Heidi', 'password123');

  const ws = await wsConnectAuthed(ctx.port, token);

  const res = await authed('/api/me', token);
  const body = (await res.json()) as any;
  assert.equal(body.user.online, true);

  ws.close();
  await new Promise((r) => setTimeout(r, 50));

  const res2 = await authed('/api/me', token);
  const body2 = (await res2.json()) as any;
  assert.equal(body2.user.online, false);
});

test('unknown ws message type returns UNKNOWN_TYPE error', async () => {
  const { token } = await registerUser(ctx, 'ivan', 'Ivan', 'password123');
  const ws = await wsConnectAuthed(ctx.port, token);
  ws.send(JSON.stringify({ t: 'definitely-not-real' }));
  const msg = await waitForMessage(ws, (m) => m.t === 'error');
  assert.equal(msg.code, 'UNKNOWN_TYPE');
  ws.close();
});

// ── Profile updates (PATCH /api/me) ────────────────────────────────────

test('display name update persists and is broadcast to chat partners', async () => {
  const alice = await registerUser(ctx, 'alice', 'Alice', 'password123');
  const bob = await registerUser(ctx, 'bob', 'Bob', 'password123');

  // they share a chat so Bob's socket should receive the broadcast
  const chatRes = await authed('/api/chats', alice.token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'private', userId: bob.user.id }),
  });
  assert.equal(chatRes.status, 201);
  const wsB = await wsConnectAuthed(ctx.port, bob.token);

  const res = await authed('/api/me', alice.token, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: 'Alice Prime' }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as any;
  assert.equal(body.user.displayName, 'Alice Prime');

  // persisted: /api/me reflects it
  const me = (await (await authed('/api/me', alice.token)).json()) as any;
  assert.equal(me.user.displayName, 'Alice Prime');

  // Bob (chat partner) got the real-time broadcast
  const evt = await waitForMessage(wsB, (m) => m.t === 'user.updated' && m.user.id === alice.user.id);
  assert.equal(evt.user.displayName, 'Alice Prime');

  wsB.close();
});

test('display name rejects empty / too-long values', async () => {
  const alice = await registerUser(ctx, 'alice', 'Alice', 'password123');
  const empty = await authed('/api/me', alice.token, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: '   ' }),
  });
  assert.equal(empty.status, 400);
  const long = await authed('/api/me', alice.token, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: 'x'.repeat(40) }),
  });
  assert.equal(long.status, 400);
});

test('password change: wrong current rejected, new password works for login', async () => {
  const alice = await registerUser(ctx, 'alice', 'Alice', 'password123');

  const wrong = await authed('/api/me', alice.token, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ currentPassword: 'not-the-password', newPassword: 'brandnewpass1' }),
  });
  assert.equal(wrong.status, 400);

  const ok = await authed('/api/me', alice.token, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ currentPassword: 'password123', newPassword: 'brandnewpass1' }),
  });
  assert.equal(ok.status, 200);

  // old password no longer works, new one does
  const oldLogin = await api('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'password123' }),
  });
  assert.equal(oldLogin.status, 401);
  const newLogin = await api('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'brandnewpass1' }),
  });
  assert.equal(newLogin.status, 200);
});

// ── Email capture ──────────────────────────────────────────────────────

test('email can be set once; second attempt rejected; invalid format rejected', async () => {
  const alice = await registerUser(ctx, 'alice', 'Alice', 'password123');

  // invalid format
  const bad = await authed('/api/me', alice.token, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'not-an-email' }),
  });
  assert.equal(bad.status, 400);

  // set once
  const ok = await authed('/api/me', alice.token, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'alice@example.com' }),
  });
  assert.equal(ok.status, 200);
  const body = (await ok.json()) as any;
  assert.equal(body.user.email, 'alice@example.com');
  assert.equal(body.user.emailVerified, false, 'no verification flow yet');

  // /api/me returns it privately
  const me = (await (await authed('/api/me', alice.token)).json()) as any;
  assert.equal(me.user.email, 'alice@example.com');

  // cannot change it afterwards
  const again = await authed('/api/me', alice.token, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'other@example.com' }),
  });
  assert.equal(again.status, 400);
});

test('email is never leaked into public DTOs (search, members)', async () => {
  const alice = await registerUser(ctx, 'alice', 'Alice', 'password123');
  await authed('/api/me', alice.token, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'alice@example.com' }),
  });

  // user search must not include email
  const search = await (await authed('/api/users?q=alice', alice.token)).json();
  const found = search.users.find((u: any) => u.username === 'alice') as any;
  assert.ok(found, 'search finds the user');
  assert.equal('email' in found, false, 'email must not be in search results');
  assert.equal('emailVerified' in found, false);

  // chat members must not include email either
  const bob = await registerUser(ctx, 'bob', 'Bob', 'password123');
  const chat = await authed('/api/chats', alice.token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'private', userId: bob.user.id }),
  });
  const chatId = ((await chat.json()) as any).chatId as number;
  const detail = (await (await authed(`/api/chats/${chatId}`, alice.token)).json()) as any;
  for (const m of detail.chat.members) {
    assert.equal('email' in m, false, 'members must not carry email');
  }
});

test('registration accepts an optional email', async () => {
  const res = await api('/api/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: 'mailuser',
      displayName: 'Mail User',
      password: 'password123',
      email: 'mail@example.com',
      ...(await solvedCaptcha(ctx.port)),
    }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as any;
  assert.equal('email' in body.user, false, 'register response stays public (no email)');
  const me = (await (await authed('/api/me', body.token)).json()) as any;
  assert.equal(me.user.email, 'mail@example.com');
});
