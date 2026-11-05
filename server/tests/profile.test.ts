import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, registerUser } from './helpers.js';

function uploadForm(token: string, filename: string, contentType: string, content: Buffer) {
  const boundary = `----proftest${Date.now()}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([head, content, tail]),
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
  };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

test('profile: name, username, bio, avatar and common groups', async () => {
  const ctx = await createTestContext();
  try {
    const alice = await registerUser(ctx, 'alice', 'Alice', 'password123');
    const bob = await registerUser(ctx, 'bob', 'Bob', 'password123');
    const eve = await registerUser(ctx, 'eve', 'Eve', 'password123');
    const base = `http://127.0.0.1:${ctx.port}`;

    // Alice and Bob share one group; Eve is not in it
    const created = await fetch(`${base}/api/chats`, {
      method: 'POST',
      headers: auth(alice.token),
      body: JSON.stringify({ type: 'group', name: 'Study', userIds: [bob.user.id] }),
    });
    assert.equal(created.status, 201);

    // Bob fills in his profile
    const patched = await fetch(`${base}/api/me`, {
      method: 'PATCH',
      headers: auth(bob.token),
      body: JSON.stringify({ bio: '  builds things  ' }),
    });
    assert.equal(patched.status, 200);
    const me = (await patched.json()) as any;
    assert.equal(me.user.bio, 'builds things', 'bio is trimmed');

    const prof = await fetch(`${base}/api/users/${bob.user.id}/profile`, { headers: auth(alice.token) });
    assert.equal(prof.status, 200);
    const body = (await prof.json()) as any;
    assert.equal(body.user.username, 'bob');
    assert.equal(body.user.displayName, 'Bob');
    assert.equal(body.user.bio, 'builds things');
    assert.equal(body.user.avatarUrl, null);
    assert.equal(body.commonGroups.length, 1);
    assert.equal(body.commonGroups[0].name, 'Study');
    assert.equal(body.sharedPrivateChat, false);
    assert.equal(body.user.email, undefined, 'email must never leak into a profile');

    // a stranger cannot look at Bob (alice is not an admin here)
    const blocked = await fetch(`${base}/api/users/${bob.user.id}/profile`, { headers: auth(eve.token) });
    assert.equal(blocked.status, 403);
  } finally {
    await ctx.close();
  }
});

test('profile: self and admin are always allowed', async () => {
  const ctx = await createTestContext();
  const previousAdmins = process.env.ADMIN_USERNAMES;
  process.env.ADMIN_USERNAMES = 'alice'; // isAdminUsername reads this at call time
  try {
    const alice = await registerUser(ctx, 'alice', 'Alice', 'password123');
    const bob = await registerUser(ctx, 'bob', 'Bob', 'password123');
    const base = `http://127.0.0.1:${ctx.port}`;

    const self = await fetch(`${base}/api/users/${alice.user.id}/profile`, { headers: auth(alice.token) });
    assert.equal(self.status, 200);

    // alice is an admin in the test config → can view an unrelated account
    const asAdmin = await fetch(`${base}/api/users/${bob.user.id}/profile`, { headers: auth(alice.token) });
    assert.equal(asAdmin.status, 200);

    const missing = await fetch(`${base}/api/users/999999/profile`, { headers: auth(alice.token) });
    assert.equal(missing.status, 404);
    const bad = await fetch(`${base}/api/users/not-a-number/profile`, { headers: auth(alice.token) });
    assert.equal(bad.status, 400);
  } finally {
    if (previousAdmins === undefined) delete process.env.ADMIN_USERNAMES;
    else process.env.ADMIN_USERNAMES = previousAdmins;
    await ctx.close();
  }
});

test('bio: capped at 200 characters, empty clears it', async () => {
  const ctx = await createTestContext();
  try {
    const alice = await registerUser(ctx, 'alice', 'Alice', 'password123');
    const base = `http://127.0.0.1:${ctx.port}`;
    const patch = (bio: unknown) =>
      fetch(`${base}/api/me`, { method: 'PATCH', headers: auth(alice.token), body: JSON.stringify({ bio }) });

    assert.equal((await patch('x'.repeat(200))).status, 200);
    assert.equal((await patch('x'.repeat(201))).status, 400);
    assert.equal((await patch(42)).status, 400);

    const cleared = await patch('   ');
    assert.equal(cleared.status, 200);
    assert.equal(((await cleared.json()) as any).user.bio, null);
  } finally {
    await ctx.close();
  }
});

test('avatar: own image only, exposed in /api/me and chat member lists', async () => {
  const ctx = await createTestContext();
  try {
    const alice = await registerUser(ctx, 'alice', 'Alice', 'password123');
    const bob = await registerUser(ctx, 'bob', 'Bob', 'password123');
    const base = `http://127.0.0.1:${ctx.port}`;

    const img = uploadForm(bob.token, 'me.png', 'image/png', Buffer.from('fake png bytes'));
    const up = await fetch(`${base}/api/upload`, { method: 'POST', headers: img.headers, body: img.body });
    const { file } = (await up.json()) as any;

    // bob sets his own picture
    const set = await fetch(`${base}/api/me`, {
      method: 'PATCH',
      headers: auth(bob.token),
      body: JSON.stringify({ avatarFileId: file.id }),
    });
    assert.equal(set.status, 200);
    const avatarUrl = ((await set.json()) as any).user.avatarUrl;
    assert.equal(avatarUrl, `/api/files/${file.id}?thumb=1`);

    // alice cannot claim bob's upload
    const theft = await fetch(`${base}/api/me`, {
      method: 'PATCH',
      headers: auth(alice.token),
      body: JSON.stringify({ avatarFileId: file.id }),
    });
    assert.equal(theft.status, 400);

    // a non-image upload is refused
    const txt = uploadForm(bob.token, 'notes.txt', 'text/plain', Buffer.from('hello'));
    const upTxt = await fetch(`${base}/api/upload`, { method: 'POST', headers: txt.headers, body: txt.body });
    const txtFile = ((await upTxt.json()) as any).file;
    const notImage = await fetch(`${base}/api/me`, {
      method: 'PATCH',
      headers: auth(bob.token),
      body: JSON.stringify({ avatarFileId: txtFile.id }),
    });
    assert.equal(notImage.status, 400);

    // the avatar shows up for people who share a chat
    const chat = await fetch(`${base}/api/chats`, {
      method: 'POST',
      headers: auth(alice.token),
      body: JSON.stringify({ type: 'private', userId: bob.user.id }),
    });
    const chatId = ((await chat.json()) as any).chatId;
    const detail = await fetch(`${base}/api/chats/${chatId}`, { headers: auth(alice.token) });
    const members = ((await detail.json()) as any).chat.members as Array<any>;
    const bobMember = members.find((m) => m.username === 'bob');
    assert.equal(bobMember.avatarUrl, `/api/files/${file.id}?thumb=1`);

    // clearing it
    const cleared = await fetch(`${base}/api/me`, {
      method: 'PATCH',
      headers: auth(bob.token),
      body: JSON.stringify({ avatarFileId: null }),
    });
    assert.equal(cleared.status, 200);
    assert.equal(((await cleared.json()) as any).user.avatarUrl, null);
  } finally {
    await ctx.close();
  }
});

test('avatar file is readable by people who share a chat, never by strangers', async () => {
  const ctx = await createTestContext();
  try {
    const alice = await registerUser(ctx, 'alice', 'Alice', 'password123');
    const bob = await registerUser(ctx, 'bob', 'Bob', 'password123');
    const eve = await registerUser(ctx, 'eve', 'Eve', 'password123');
    const base = `http://127.0.0.1:${ctx.port}`;

    const img = uploadForm(bob.token, 'me.png', 'image/png', Buffer.from('avatar bytes'));
    const up = await fetch(`${base}/api/upload`, { method: 'POST', headers: img.headers, body: img.body });
    const { file } = (await up.json()) as any;
    await fetch(`${base}/api/me`, {
      method: 'PATCH',
      headers: auth(bob.token),
      body: JSON.stringify({ avatarFileId: file.id }),
    });

    // nobody shares a chat yet → even the avatar is private
    const stranger = await fetch(`${base}${file.url}`, { headers: { authorization: `Bearer ${alice.token}` } });
    assert.equal(stranger.status, 403, 'an unshared avatar must not be readable');

    // after they share a chat, alice can render bob's avatar
    await fetch(`${base}/api/chats`, {
      method: 'POST',
      headers: auth(alice.token),
      body: JSON.stringify({ type: 'private', userId: bob.user.id }),
    });
    const allowed = await fetch(`${base}${file.url}`, { headers: { authorization: `Bearer ${alice.token}` } });
    assert.equal(allowed.status, 200);

    // eve still cannot
    const eveTry = await fetch(`${base}${file.url}`, { headers: { authorization: `Bearer ${eve.token}` } });
    assert.equal(eveTry.status, 403);
  } finally {
    await ctx.close();
  }
});
