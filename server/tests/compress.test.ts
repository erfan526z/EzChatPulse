import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { createTestContext, destroyTestContext, registerUser, seedMessages, type TestContext } from './helpers.js';

let ctx: TestContext;

beforeEach(async () => {
  ctx = await createTestContext();
});

afterEach(async () => {
  await destroyTestContext(ctx);
});

/**
 * Raw request: fetch() (undici) transparently decodes gzip and drops the
 * content-encoding header, so the wire behaviour has to be observed directly.
 */
function raw(
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: ctx.port, path, method: 'GET', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('API JSON is gzipped on the wire when the client asks, and plain when it does not', async () => {
  const alice = await registerUser(ctx, 'alice', 'Alice', 'password123');
  const base = `http://127.0.0.1:${ctx.port}`;
  const auth = { authorization: `Bearer ${alice.token}`, 'content-type': 'application/json' };

  const created = await fetch(`${base}/api/chats`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ type: 'group', name: 'Big', userIds: [] }),
  });
  const { chatId } = await created.json();
  seedMessages(ctx.db, chatId, alice.user.id, 40, 'a message long enough to compress properly');
  const path = `/api/chats/${chatId}/messages`;

  const plain = await raw(path, { authorization: `Bearer ${alice.token}` });
  assert.equal(plain.status, 200);
  assert.equal(plain.headers['content-encoding'], undefined, 'no compression unless asked for');
  assert.ok(plain.body.length > 1024, `fixture should exceed the threshold (got ${plain.body.length})`);

  const gz = await raw(path, { authorization: `Bearer ${alice.token}`, 'accept-encoding': 'gzip' });
  assert.equal(gz.status, 200);
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.match(String(gz.headers['vary'] ?? ''), /accept-encoding/i);
  assert.ok(gz.body.length < plain.body.length / 3, `expected a real win: ${gz.body.length} vs ${plain.body.length}`);

  // the contract is unchanged once decoded
  const decoded = JSON.parse(zlib.gunzipSync(gz.body).toString('utf8'));
  assert.ok(Array.isArray(decoded.messages));
  assert.ok(decoded.messages.length > 0);
  assert.deepEqual(JSON.parse(plain.body.toString('utf8')).messages.length, decoded.messages.length);
});

test('small JSON responses stay uncompressed', async () => {
  const alice = await registerUser(ctx, 'alice2', 'Alice', 'password123');
  const res = await raw('/api/me', { authorization: `Bearer ${alice.token}`, 'accept-encoding': 'gzip' });
  assert.equal(res.headers['content-encoding'], undefined);
});
