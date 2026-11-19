import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTestContext,
  destroyTestContext,
  registerUser,
  seedMessages,
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function authed(path: string, token: string, options: RequestInit = {}) {
  return fetch(`http://127.0.0.1:${ctx.port}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${token}`, ...(options.headers ?? {}) },
  });
}

async function createGroup(token: string, name: string, userIds: number[]): Promise<number> {
  const res = await authed('/api/chats', token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'group', name, userIds }),
  });
  assert.equal(res.status, 201, `create group failed: ${res.status}`);
  return ((await res.json()) as any).chatId as number;
}

// ── Creation ────────────────────────────────────────────────────────────

test('create group: creator is admin, all members receive chat.created', async () => {
  const alice = await registerUser(ctx, 'alice', 'Alice', 'password123');
  const bob = await registerUser(ctx, 'bob', 'Bob', 'password123');
  const carol = await registerUser(ctx, 'carol', 'Carol', 'password123');

  const wsA = await wsConnectAuthed(ctx.port, alice.token);
  const wsB = await wsConnectAuthed(ctx.port, bob.token);
  const wsC = await wsConnectAuthed(ctx.port, carol.token);

  const chatId = await createGroup(alice.token, 'Dev Team', [bob.user.id, carol.user.id]);

  // Both members get chat.created
  const evtB = await waitForMessage(wsB, (m) => m.t === 'chat.created' && m.chat.id === chatId);
  assert.equal(evtB.chat.name, 'Dev Team');
  assert.equal(evtB.chat.members.length, 3);
  const evtC = await waitForMessage(wsC, (m) => m.t === 'chat.created' && m.chat.id === chatId);
  assert.equal(evtC.chat.members.length, 3);

  // Roles
  const detail = await (await authed(`/api/chats/${chatId}`, alice.token)).json();
  const aliceMember = detail.chat.members.find((m: any) => m.userId === alice.user.id);
  const bobMember = detail.chat.members.find((m: any) => m.userId === bob.user.id);
  assert.equal(aliceMember.role, 'admin');
  assert.equal(bobMember.role, 'member');

  wsA.close(); wsB.close(); wsC.close();
});

test('create group with unknown user returns 404', async () => {
  const alice = await registerUser(ctx, 'alice', 'Alice', 'password123');
  const res = await authed('/api/chats', alice.token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'group', name: 'Bad', userIds: [999999] }),
  });
  assert.equal(res.status, 404);
});

test('group chat appears in listChats with name and members', async () => {
  const alice = await registerUser(ctx, 'alice', 'Alice', 'password123');
  const bob = await registerUser(ctx, 'bob', 'Bob', 'password123');
  await createGroup(alice.token, 'Dev Team', [bob.user.id]);

  const chats = await (await authed('/api/chats', alice.token)).json();
  const group = chats.chats.find((c: any) => c.type === 'group');
  assert.equal(group.name, 'Dev Team');
  assert.equal(group.members.length, 2);
});

// ── Group messaging fan-out ─────────────────────────────────────────────

test('group message fans out to all online members', async () => {
  const alice = await registerUser(ctx, 'alice', 'Alice', 'password123');
  const bob = await registerUser(ctx, 'bob', 'Bob', 'password123');
  const carol = await registerUser(ctx, 'carol', 'Carol', 'password123');
  const chatId = await createGroup(alice.token, 'Dev Team', [bob.user.id, carol.user.id]);

  const wsA = await wsConnectAuthed(ctx.port, alice.token);
  const wsB = await wsConnectAuthed(ctx.port, bob.token);
  const wsC = await wsConnectAuthed(ctx.port, carol.token);

  wsA.send(JSON.stringify({ t: 'msg.send', cid: chatId, tempId: 'g1', text: 'meeting at 5' }));

  const ack = await waitForMessage(wsA, (m) => m.t === 'msg.ack');
  const evtB = await waitForMessage(wsB, (m) => m.t === 'msg.new');
  const evtC = await waitForMessage(wsC, (m) => m.t === 'msg.new');
  assert.equal(evtB.msg.id, ack.msg.id);
  assert.equal(evtC.msg.id, ack.msg.id);
  assert.equal(evtB.msg.text, 'meeting at 5');

  wsA.close(); wsB.close(); wsC.close();
});

// ── Membership management ───────────────────────────────────────────────

test('add member: admin adds, new member gets chat.created and can send', async () => {
  const alice = await registerUser(ctx, 'alice', 'Alice', 'password123');
  const bob = await registerUser(ctx, 'bob', 'Bob', 'password123');
  const carol = await registerUser(ctx, 'carol', 'Carol', 'password123');
  const chatId = await createGroup(alice.token, 'Dev Team', [bob.user.id]);

  const wsA = await wsConnectAuthed(ctx.port, alice.token);
  const wsB = await wsConnectAuthed(ctx.port, bob.token);
  const wsC = await wsConnectAuthed(ctx.port, carol.token);

  const res = await authed(`/api/chats/${chatId}/members`, alice.token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: carol.user.id }),
  });
  assert.equal(res.status, 200);

  // Existing members see the added event with updated chat summary
  const addEvt = await waitForMessage(wsB, (m) => m.t === 'chat.member' && m.action === 'added');
  assert.equal(addEvt.userId, carol.user.id);
  assert.equal(addEvt.chat.members.length, 3);

  // Carol gets the chat and can now send to it
  const createdEvt = await waitForMessage(wsC, (m) => m.t === 'chat.created');
  assert.equal(createdEvt.chat.id, chatId);
  wsC.send(JSON.stringify({ t: 'msg.send', cid: chatId, tempId: 'c1', text: 'hi from carol' }));
  const ack = await waitForMessage(wsC, (m) => m.t === 'msg.ack');
  assert.equal(ack.msg.text, 'hi from carol');

  wsA.close(); wsB.close(); wsC.close();
});

test('non-admin cannot add members', async () => {
  const alice = await registerUser(ctx, 'alice', 'Alice', 'password123');
  const bob = await registerUser(ctx, 'bob', 'Bob', 'password123');
  const carol = await registerUser(ctx, 'carol', 'Carol', 'password123');
  const dave = await registerUser(ctx, 'dave', 'Dave', 'password123');
  const chatId = await createGroup(alice.token, 'Dev Team', [bob.user.id, carol.user.id]);

  const res = await authed(`/api/chats/${chatId}/members`, bob.token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: dave.user.id }),
  });
  assert.equal(res.status, 403);
});

test('remove member: kicked user loses access, gets chat.removed', async () => {
  const alice = await registerUser(ctx, 'alice', 'Alice', 'password123');
  const bob = await registerUser(ctx, 'bob', 'Bob', 'password123');
  const carol = await registerUser(ctx, 'carol', 'Carol', 'password123');
  const chatId = await createGroup(alice.token, 'Dev Team', [bob.user.id, carol.user.id]);

  const wsB = await wsConnectAuthed(ctx.port, bob.token);
  const wsC = await wsConnectAuthed(ctx.port, carol.token);

  const res = await authed(`/api/chats/${chatId}/members`, alice.token, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: carol.user.id }),
  });
  assert.equal(res.status, 200);

  // Carol is notified and removed
  const removedEvt = await waitForMessage(wsC, (m) => m.t === 'chat.removed');
  assert.equal(removedEvt.cid, chatId);

  // Bob sees the membership change
  const memberEvt = await waitForMessage(wsB, (m) => m.t === 'chat.member' && m.action === 'removed');
  assert.equal(memberEvt.userId, carol.user.id);

  // Carol can no longer send or read history
  wsC.send(JSON.stringify({ t: 'msg.send', cid: chatId, tempId: 'x', text: 'am i still in?' }));
  const err = await waitForMessage(wsC, (m) => m.t === 'error');
  assert.equal(err.code, 'FORBIDDEN');
  const history = await authed(`/api/chats/${chatId}/messages`, carol.token);
  assert.equal(history.status, 403);

  wsB.close(); wsC.close();
});

test('admin cannot remove themselves', async () => {
  const alice = await registerUser(ctx, 'alice', 'Alice', 'password123');
  const bob = await registerUser(ctx, 'bob', 'Bob', 'password123');
  const chatId = await createGroup(alice.token, 'Dev Team', [bob.user.id]);

  const res = await authed(`/api/chats/${chatId}/members`, alice.token, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: alice.user.id }),
  });
  assert.equal(res.status, 400);
});

// ── Leave & delete group ───────────────────────────────────────────────

test('member leaves: removed for them, remaining members get member.left', async () => {
  const alice = await registerUser(ctx, 'alice', 'Alice', 'password123');
  const bob = await registerUser(ctx, 'bob', 'Bob', 'password123');
  const carol = await registerUser(ctx, 'carol', 'Carol', 'password123');
  const chatId = await createGroup(alice.token, 'Dev Team', [bob.user.id, carol.user.id]);

  const wsA = await wsConnectAuthed(ctx.port, alice.token);
  const wsC = await wsConnectAuthed(ctx.port, carol.token);

  // Carol leaves
  const res = await authed(`/api/chats/${chatId}/leave`, carol.token, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as any).chatDeleted, false);

  // Carol's chat list no longer has it; her history access is revoked
  const carolChats = (await (await authed('/api/chats', carol.token)).json()) as any;
  assert.ok(!carolChats.chats.some((c: any) => c.id === chatId), 'chat gone from leaver list');
  const hist = await authed(`/api/chats/${chatId}/messages`, carol.token);
  assert.equal(hist.status, 403, 'leaver cannot read history');

  // Alice (remaining member) got the member.left broadcast with updated members
  const evt = await waitForMessage(wsA, (m) => m.t === 'chat.member' && m.action === 'left' && m.userId === carol.user.id);
  assert.ok(evt.chat?.members?.length === 2, 'members list shrunk');
  assert.ok(!evt.chat.members.some((m: any) => m.userId === carol.user.id));

  wsA.close();
  wsC.close();
});

test('last member leaving deletes the group chat', async () => {
  const alice = await registerUser(ctx, 'alice', 'Alice', 'password123');
  const bob = await registerUser(ctx, 'bob', 'Bob', 'password123');
  const chatId = await createGroup(alice.token, 'Solo', [bob.user.id]);

  const wsB = await wsConnectAuthed(ctx.port, bob.token);
  const wsA = await wsConnectAuthed(ctx.port, alice.token);

  // Bob leaves (1 left) → still exists; Alice leaves → deleted
  await authed(`/api/chats/${chatId}/leave`, bob.token, { method: 'POST' });
  await waitForMessage(wsA, (m) => m.t === 'chat.member' && m.action === 'left');

  const res = await authed(`/api/chats/${chatId}/leave`, alice.token, { method: 'POST' });
  assert.equal(((await res.json()) as any).chatDeleted, true);

  // chat row + its messages are gone (cascade)
  assert.ok(!ctx.db.prepare('SELECT 1 FROM chats WHERE id = ?').get(chatId), 'chat deleted');
  assert.equal((ctx.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?').get(chatId) as any).n, 0);

  wsA.close();
  wsB.close();
});

test('delete group: admin only; members get chat.deleted; cascade wipes messages', async () => {
  const alice = await registerUser(ctx, 'alice', 'Alice', 'password123');
  const bob = await registerUser(ctx, 'bob', 'Bob', 'password123');
  const carol = await registerUser(ctx, 'carol', 'Carol', 'password123');
  const chatId = await createGroup(alice.token, 'Dev Team', [bob.user.id, carol.user.id]);

  // seed one message so the cascade is observable
  const wsA = await wsConnectAuthed(ctx.port, alice.token);
  wsA.send(JSON.stringify({ t: 'msg.send', cid: chatId, tempId: 't1', kind: 'text', text: 'last words' }));
  await waitForMessage(wsA, (m) => m.t === 'msg.ack');

  // non-admin cannot delete
  const forbidden = await authed(`/api/chats/${chatId}`, bob.token, { method: 'DELETE' });
  assert.equal(forbidden.status, 403);

  // members (bob, carol) receive chat.deleted
  const wsB = await wsConnectAuthed(ctx.port, bob.token);
  const wsC = await wsConnectAuthed(ctx.port, carol.token);
  const delB = waitForMessage(wsB, (m) => m.t === 'chat.deleted' && m.cid === chatId);
  const delC = waitForMessage(wsC, (m) => m.t === 'chat.deleted' && m.cid === chatId);

  const res = await authed(`/api/chats/${chatId}`, alice.token, { method: 'DELETE' });
  assert.equal(res.status, 200);
  await delB;
  await delC;

  // gone for everyone: listChats, detail, messages; cascade wiped rows
  for (const token of [alice.token, bob.token, carol.token]) {
    const chats = (await (await authed('/api/chats', token)).json()) as any;
    assert.ok(!chats.chats.some((c: any) => c.id === chatId), 'chat gone from list');
    const detail = await authed(`/api/chats/${chatId}`, token);
    assert.equal(detail.status, 404);
  }
  assert.equal((ctx.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?').get(chatId) as any).n, 0);
  assert.equal((ctx.db.prepare('SELECT COUNT(*) AS n FROM chat_members WHERE chat_id = ?').get(chatId) as any).n, 0);

  wsA.close();
  wsB.close();
  wsC.close();
});

test('a member who joins a busy group starts with zero unread', async () => {
  // the cursor is seeded at join time; without it the whole history counts as
  // unread for the new member (and the chat list has to count every message)
  const alice = await registerUser(ctx, 'alice', 'Alice', 'password123');
  const bob = await registerUser(ctx, 'bob', 'Bob', 'password123');
  const carol = await registerUser(ctx, 'carol', 'Carol', 'password123');
  const base = `http://127.0.0.1:${ctx.port}`;
  const auth = (t: string) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });

  const created = await fetch(`${base}/api/chats`, {
    method: 'POST',
    headers: auth(alice.token),
    body: JSON.stringify({ type: 'group', name: 'Busy', userIds: [] }),
  });
  const { chatId } = await created.json();
  seedMessages(ctx.db, chatId, carol.user.id, 25, 'history');

  const added = await fetch(`${base}/api/chats/${chatId}/members`, {
    method: 'POST',
    headers: auth(alice.token),
    body: JSON.stringify({ userId: bob.user.id }),
  });
  assert.equal(added.status, 200);

  const bobChats = await (await fetch(`${base}/api/chats`, { headers: auth(bob.token) })).json();
  const row = bobChats.chats.find((c: { id: number }) => c.id === chatId);
  assert.ok(row, 'bob should see the chat');
  assert.equal(row.unread, 0, 'joining must not import the history as unread');

  // the preview still shows the newest message
  assert.equal(row.lastMessage?.text, 'history 25');

  // and the creator, who has not read them either, does see them as unread
  const aliceChats = await (await fetch(`${base}/api/chats`, { headers: auth(alice.token) })).json();
  const aliceRow = aliceChats.chats.find((c: { id: number }) => c.id === chatId);
  assert.ok((aliceRow.unread ?? 0) >= 25, `alice should see the backlog, got ${aliceRow.unread}`);
});
