import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, registerUser } from './helpers.js';

/**
 * S4 — strict user search.
 *
 * Default (secure): a non-admin only finds an account by its FULL username or
 * FULL display name, so the userbase cannot be enumerated letter by letter.
 * Admins keep substring search; the admin panel can relax it for everyone.
 */

function makeAuthed(ctx: { port: number }) {
  return async (path: string, token: string, options: RequestInit = {}) => {
    const res = await fetch(`http://127.0.0.1:${ctx.port}${path}`, {
      ...options,
      headers: { authorization: `Bearer ${token}`, ...(options.headers ?? {}) },
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  };
}

async function search(authed: ReturnType<typeof makeAuthed>, token: string, q: string) {
  const res = await authed(`/api/users?q=${encodeURIComponent(q)}`, token);
  assert.equal(res.status, 200, `search failed: ${JSON.stringify(res.body)}`);
  return res.body.users as Array<{ username: string; displayName: string }>;
}

async function withAdmin<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.ADMIN_USERNAMES;
  process.env.ADMIN_USERNAMES = 'admin';
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.ADMIN_USERNAMES;
    else process.env.ADMIN_USERNAMES = previous;
  }
}

test('strict (default): partial names find nothing, full username/display name match', async () => {
  const ctx = await createTestContext();
  const authed = makeAuthed(ctx);
  try {
    await registerUser(ctx, 'alice', 'Alice Anderson', 'password123');
    await registerUser(ctx, 'bob', 'Bob', 'password123');
    const { token } = await registerUser(ctx, 'carol', 'Carol', 'password123');

    assert.deepEqual(await search(authed, token, 'al'), [], 'partial username');
    assert.deepEqual(await search(authed, token, 'ali'), [], 'partial username');
    assert.deepEqual(await search(authed, token, 'lice'), [], 'substring');
    assert.deepEqual(await search(authed, token, 'Anderson'), [], 'partial display name');

    assert.deepEqual((await search(authed, token, 'alice')).map((u) => u.username), ['alice']);
    assert.deepEqual((await search(authed, token, 'ALICE')).map((u) => u.username), ['alice'], 'case-insensitive');
    assert.deepEqual((await search(authed, token, '  alice  ')).map((u) => u.username), ['alice'], 'whitespace trimmed');
    assert.deepEqual(
      (await search(authed, token, 'Alice Anderson')).map((u) => u.username),
      ['alice'],
      'full display name',
    );
    assert.deepEqual((await search(authed, token, 'alice anderson')).map((u) => u.username), ['alice'], 'display name is case-insensitive');
    assert.deepEqual(await search(authed, token, ''), [], 'empty query returns nothing');
  } finally {
    await ctx.close();
  }
});

test('admins keep substring search', async () => {
  await withAdmin(async () => {
    const ctx = await createTestContext();
    const authed = makeAuthed(ctx);
    try {
      await registerUser(ctx, 'alice', 'Alice', 'password123');
      await registerUser(ctx, 'malice', 'Malice', 'password123');
      const admin = await registerUser(ctx, 'admin', 'Admin', 'password123');

      const users = await search(authed, admin.token, 'alice');
      assert.deepEqual(users.map((u) => u.username).sort(), ['alice', 'malice'], 'admin sees substrings');
    } finally {
      await ctx.close();
    }
  });
});

test('admin can relax strict search for everyone, and restore it', async () => {
  await withAdmin(async () => {
    const ctx = await createTestContext();
    const authed = makeAuthed(ctx);
    try {
      await registerUser(ctx, 'alice', 'Alice', 'password123');
      await registerUser(ctx, 'malice', 'Malice', 'password123');
      const admin = await registerUser(ctx, 'admin', 'Admin', 'password123');
      const carol = await registerUser(ctx, 'carol', 'Carol', 'password123');

      // strict by default: a partial name finds nothing
      assert.deepEqual(await search(authed, carol.token, 'alic'), []);

      // relax it
      const off = await authed('/api/admin/search-mode', admin.token, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ strict: false }),
      });
      assert.equal(off.status, 200);
      assert.equal(off.body.strictSearch, false);
      assert.deepEqual(
        (await search(authed, carol.token, 'alic')).map((u) => u.username).sort(),
        ['alice', 'malice'],
        'loose mode allows substring enumeration',
      );

      // stats reflect it
      const stats = await authed('/api/admin/stats', admin.token);
      assert.equal(stats.body.strictSearch, false);

      // turn it back on
      await authed('/api/admin/search-mode', admin.token, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ strict: true }),
      });
      assert.deepEqual(await search(authed, carol.token, 'alic'), [], 'strict again');
    } finally {
      await ctx.close();
    }
  });
});

test('LIKE wildcards in the query are matched literally, not as wildcards', async () => {
  await withAdmin(async () => {
    const ctx = await createTestContext();
    const authed = makeAuthed(ctx);
    try {
      await registerUser(ctx, 'alice', 'Alice', 'password123');
      await registerUser(ctx, 'bob', 'Bob', 'password123');
      await registerUser(ctx, 'under_score', 'Under Score', 'password123');
      const admin = await registerUser(ctx, 'admin', 'Admin', 'password123');

      // "%" matches no one (nobody has a literal percent sign) — a wildcard would return everyone
      assert.deepEqual(await search(authed, admin.token, '%'), []);

      // "_" must match only the account whose name literally contains an underscore,
      // not "any single character" (which would return every user)
      assert.deepEqual((await search(authed, admin.token, '_')).map((u) => u.username), ['under_score']);
      assert.deepEqual((await search(authed, admin.token, 'under_score')).map((u) => u.username), ['under_score']);
    } finally {
      await ctx.close();
    }
  });
});

test('non-admins cannot change the search mode', async () => {
  const ctx = await createTestContext();
  const authed = makeAuthed(ctx);
  try {
    const carol = await registerUser(ctx, 'carol', 'Carol', 'password123');
    const res = await authed('/api/admin/search-mode', carol.token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ strict: false }),
    });
    assert.equal(res.status, 403);
  } finally {
    await ctx.close();
  }
});
