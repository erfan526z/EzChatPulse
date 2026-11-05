import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { createTestContext, registerUser } from './helpers.js';
import { mountWebClient } from '../src/static.js';

/** multipart body for /api/upload (same shape the real client sends) */
function uploadForm(token: string, filename: string, contentType: string, content: Buffer) {
  const boundary = `----cptest${Date.now()}`;
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

// ── 1. uploaded files are immutable + revalidate cheaply ─────────────────

test('file download: immutable, private caching + working ETag/304', async () => {
  const ctx = await createTestContext();
  try {
    const alice = await registerUser(ctx, 'alice', 'Alice', 'password123');
    const content = Buffer.from('immutable image bytes');

    const form = uploadForm(alice.token, 'pic.png', 'image/png', content);
    const up = await fetch(`http://127.0.0.1:${ctx.port}/api/upload`, {
      method: 'POST',
      headers: form.headers,
      body: form.body,
    });
    assert.equal(up.status, 201);
    const { file } = (await up.json()) as any;

    const dl = await fetch(`http://127.0.0.1:${ctx.port}${file.url}`, {
      headers: { authorization: `Bearer ${alice.token}` },
    });
    assert.equal(dl.status, 200);
    const cc = dl.headers.get('cache-control') ?? '';
    assert.match(cc, /immutable/, 'must be cacheable as immutable');
    assert.match(cc, /max-age=31536000/, 'one year');
    assert.match(cc, /private/, 'per-account content must not be stored by shared caches');
    const etag = dl.headers.get('etag');
    assert.ok(etag && /^"[0-9a-f]{64}"$/.test(etag), `etag should be the sha256, got ${etag}`);
    assert.deepEqual(Buffer.from(await dl.arrayBuffer()), content);

    // a conditional request costs a 304, not the bytes
    const revalidated = await fetch(`http://127.0.0.1:${ctx.port}${file.url}`, {
      headers: { authorization: `Bearer ${alice.token}`, 'if-none-match': etag! },
    });
    assert.equal(revalidated.status, 304);
    assert.equal((await revalidated.arrayBuffer()).byteLength, 0);
  } finally {
    await ctx.close();
  }
});

test('file download: a different ETag still returns the body', async () => {
  const ctx = await createTestContext();
  try {
    const alice = await registerUser(ctx, 'alice', 'Alice', 'password123');
    const form = uploadForm(alice.token, 'x.txt', 'text/plain', Buffer.from('abc'));
    const up = await fetch(`http://127.0.0.1:${ctx.port}/api/upload`, {
      method: 'POST',
      headers: form.headers,
      body: form.body,
    });
    const { file } = (await up.json()) as any;
    const res = await fetch(`http://127.0.0.1:${ctx.port}${file.url}`, {
      headers: { authorization: `Bearer ${alice.token}`, 'if-none-match': '"stale"' },
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'abc');
  } finally {
    await ctx.close();
  }
});

// ── 2. hashed build assets are immutable, index.html is not ──────────────

test('static: /assets/* immutable, index.html revalidates, SPA fallback, /api not swallowed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-webdist-'));
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>app</title>');
  fs.writeFileSync(path.join(dir, 'favicon.ico'), 'icon');

  const app = express();
  app.get('/api/known', (_req, res) => res.json({ ok: true }));
  assert.equal(mountWebClient(app, dir), true);

  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const asset = await fetch(`${base}/assets/index-abc123.js`);
    assert.equal(asset.status, 200);
    const assetCc = asset.headers.get('cache-control') ?? '';
    assert.match(assetCc, /immutable/);
    assert.match(assetCc, /max-age=31536000/);
    assert.equal(await asset.text(), 'console.log(1)');

    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    const indexCc = index.headers.get('cache-control') ?? '';
    assert.doesNotMatch(indexCc, /immutable/, 'index.html must never be immutable');
    assert.match(await index.text(), /<title>app<\/title>/);

    // client-side route → index.html
    const spa = await fetch(`${base}/chats/42`);
    assert.equal(spa.status, 200);
    assert.match(await spa.text(), /<title>app<\/title>/);

    // API paths are never swallowed by the SPA fallback
    const api = await fetch(`${base}/api/known`);
    assert.equal(api.status, 200);
    const apiMiss = await fetch(`${base}/api/nope`);
    assert.equal(apiMiss.status, 404);

    // other build files revalidate rather than being immutable
    const favicon = await fetch(`${base}/favicon.ico`);
    assert.equal(favicon.status, 200);
    assert.doesNotMatch(favicon.headers.get('cache-control') ?? '', /immutable/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('static: no build on disk → mount reports false (dev mode)', () => {
  const app = express();
  assert.equal(mountWebClient(app, path.join(os.tmpdir(), 'does-not-exist-' + Date.now())), false);
});

// ── 3. JSON API responses are never cached; file streaming overrides that ──

test('API responses are no-store, but immutable files keep their own policy', async () => {
  const ctx = await createTestContext();
  try {
    const alice = await registerUser(ctx, 'alice', 'Alice', 'password123');
    const base = `http://127.0.0.1:${ctx.port}`;

    const chats = await fetch(`${base}/api/chats`, { headers: { authorization: `Bearer ${alice.token}` } });
    assert.equal(chats.status, 200);
    assert.equal(chats.headers.get('cache-control'), 'no-store', 'live user data must not be cached');

    const form = uploadForm(alice.token, 'pic.png', 'image/png', Buffer.from('bytes'));
    const up = await fetch(`${base}/api/upload`, { method: 'POST', headers: form.headers, body: form.body });
    const { file } = (await up.json()) as any;
    const dl = await fetch(`${base}${file.url}`, { headers: { authorization: `Bearer ${alice.token}` } });
    assert.match(dl.headers.get('cache-control') ?? '', /immutable/, 'file route must override no-store');
  } finally {
    await ctx.close();
  }
});
