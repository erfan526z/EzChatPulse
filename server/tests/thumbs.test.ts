import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { createTestContext, registerUser } from './helpers.js';
import { config } from '../src/config.js';
import { isAnimatedPng } from '../src/services/thumbs.js';

/** True noise: incompressible, so the thumbnail win is measurable (a gradient or
 *  repeating pattern compresses to almost nothing and would flatter the test). */
async function bigPng(width = 900, height = 700): Promise<Buffer> {
  const raw = crypto.randomBytes(width * height * 3);
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

function uploadForm(token: string, filename: string, contentType: string, content: Buffer) {
  const boundary = `----thumbtest${Date.now()}`;
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

async function upload(ctx: { port: number }, token: string, name: string, mime: string, bytes: Buffer) {
  const form = uploadForm(token, name, mime, bytes);
  const res = await fetch(`http://127.0.0.1:${ctx.port}/api/upload`, {
    method: 'POST',
    headers: form.headers,
    body: form.body,
  });
  return { status: res.status, body: (await res.json()) as any };
}


// ── APNG fixtures ───────────────────────────────────────────────────────
// sharp cannot emit animated PNGs, so build a chunk-valid one by hand: take a
// real PNG and insert the acTL chunk that marks it animated.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Turn a normal PNG into an APNG by declaring an animation after IHDR. */
function makeApng(png: Buffer, frames = 2): Buffer {
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(frames, 0); // num_frames
  actl.writeUInt32BE(0, 4); // num_plays: forever
  const afterIhdr = 8 + 25; // signature + IHDR chunk
  return Buffer.concat([png.subarray(0, afterIhdr), pngChunk('acTL', actl), png.subarray(afterIhdr)]);
}

/** Point uploads at a scratch dir so thumbnails never touch the repo's data/. */
function withTempUploads(): { restore: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-thumbs-'));
  const original = config.uploadsDir;
  (config as { uploadsDir: string }).uploadsDir = dir;
  return {
    restore: () => {
      (config as { uploadsDir: string }).uploadsDir = original;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('image upload gets a webp thumbnail; original is untouched', async () => {
  const tmp = withTempUploads();
  const ctx = await createTestContext();
  try {
    const alice = await registerUser(ctx, 'alice', 'Alice', 'password123');
    const png = await bigPng();
    const { status, body } = await upload(ctx, alice.token, 'photo.png', 'image/png', png);
    assert.equal(status, 201);
    const file = body.file;
    assert.equal(file.mime, 'image/png');
    assert.equal(file.thumbUrl, `/api/files/${file.id}?thumb=1`, 'DTO advertises the thumbnail');

    const thumb = await fetch(`http://127.0.0.1:${ctx.port}${file.thumbUrl}`, {
      headers: { authorization: `Bearer ${alice.token}` },
    });
    assert.equal(thumb.status, 200);
    assert.equal(thumb.headers.get('content-type'), 'image/webp');
    assert.match(thumb.headers.get('etag') ?? '', /-thumb"$/, 'thumbnail has its own validator');
    assert.match(thumb.headers.get('cache-control') ?? '', /immutable/);
    const thumbBytes = Buffer.from(await thumb.arrayBuffer());
    assert.ok(thumbBytes.length < png.length / 4, `thumb ${thumbBytes.length}B should be far smaller than ${png.length}B`);
    assert.equal(thumbBytes.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(thumbBytes.subarray(8, 12).toString('ascii'), 'WEBP');

    const meta = await sharp(thumbBytes).metadata();
    assert.ok((meta.width ?? 9999) <= 512 && (meta.height ?? 9999) <= 512, 'longest edge capped at 512');

    const orig = await fetch(`http://127.0.0.1:${ctx.port}${file.url}`, {
      headers: { authorization: `Bearer ${alice.token}` },
    });
    assert.equal(orig.status, 200);
    assert.equal(orig.headers.get('content-type'), 'image/png');
    assert.equal(Buffer.from(await orig.arrayBuffer()).length, png.length);
  } finally {
    await ctx.close();
    tmp.restore();
  }
});

test('thumbnail is generated lazily for files uploaded before the feature', async () => {
  const tmp = withTempUploads();
  const ctx = await createTestContext();
  try {
    const alice = await registerUser(ctx, 'alice', 'Alice', 'password123');
    const png = await bigPng(800, 600);
    const { body } = await upload(ctx, alice.token, 'old.png', 'image/png', png);
    const id = body.file.id;

    // simulate a pre-thumbnail row: forget the cached thumbnail and delete the blob
    const row = ctx.db.prepare('SELECT thumb_path FROM files WHERE id = ?').get(id) as { thumb_path: string };
    fs.rmSync(path.join(config.uploadsDir, row.thumb_path), { force: true });
    ctx.db.prepare('UPDATE files SET thumb_path = NULL, thumb_size = NULL WHERE id = ?').run(id);

    const thumb = await fetch(`http://127.0.0.1:${ctx.port}/api/files/${id}?thumb=1`, {
      headers: { authorization: `Bearer ${alice.token}` },
    });
    assert.equal(thumb.status, 200);
    assert.equal(thumb.headers.get('content-type'), 'image/webp');

    const after = ctx.db.prepare('SELECT thumb_path, thumb_size FROM files WHERE id = ?').get(id) as {
      thumb_path: string | null;
      thumb_size: number | null;
    };
    assert.ok(after.thumb_path, 'row is healed so the work happens only once');
    assert.ok((after.thumb_size ?? 0) > 0);
  } finally {
    await ctx.close();
    tmp.restore();
  }
});

test('non-image files expose no thumbUrl and fall back to the original bytes', async () => {
  const tmp = withTempUploads();
  const ctx = await createTestContext();
  try {
    const alice = await registerUser(ctx, 'alice', 'Alice', 'password123');
    const text = Buffer.from('a plain text attachment');
    const { body } = await upload(ctx, alice.token, 'note.txt', 'text/plain', text);
    assert.equal(body.file.thumbUrl, undefined);

    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/files/${body.file.id}?thumb=1`, {
      headers: { authorization: `Bearer ${alice.token}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/plain');
    assert.equal(await res.text(), text.toString());
  } finally {
    await ctx.close();
    tmp.restore();
  }
});

test('animated GIF is served as-is (no still thumbnail)', async () => {
  const tmp = withTempUploads();
  const ctx = await createTestContext();
  try {
    const alice = await registerUser(ctx, 'alice', 'Alice', 'password123');
    // minimal 1×1 GIF89a
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
    const { body } = await upload(ctx, alice.token, 'anim.gif', 'image/gif', gif);
    assert.equal(body.file.thumbUrl, undefined, 'GIF keeps its animation');

    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/files/${body.file.id}?thumb=1`, {
      headers: { authorization: `Bearer ${alice.token}` },
    });
    assert.equal(res.headers.get('content-type'), 'image/gif');
  } finally {
    await ctx.close();
    tmp.restore();
  }
});

test('thumbnail keeps the aspect ratio of the original', async () => {
  const tmp = withTempUploads();
  const ctx = await createTestContext();
  try {
    const alice = await registerUser(ctx, 'alice', 'Alice', 'password123');
    const png = await bigPng(1600, 400); // 4:1
    const { body } = await upload(ctx, alice.token, 'wide.png', 'image/png', png);
    const thumb = await fetch(`http://127.0.0.1:${ctx.port}${body.file.thumbUrl}`, {
      headers: { authorization: `Bearer ${alice.token}` },
    });
    const meta = await sharp(Buffer.from(await thumb.arrayBuffer())).metadata();
    assert.equal(meta.width, 512);
    assert.equal(meta.height, 128);
  } finally {
    await ctx.close();
    tmp.restore();
  }
});

test('APNG is detected and never flattened into a still thumbnail', async () => {
  const tmp = withTempUploads();
  const ctx = await createTestContext();
  try {
    const alice = await registerUser(ctx, 'alice', 'Alice', 'password123');
    const plain = await bigPng(300, 200);
    const apng = makeApng(plain);

    // detection itself
    assert.equal(isAnimatedPng(apng), true, 'acTL marks the file animated');
    assert.equal(isAnimatedPng(plain), false, 'a plain PNG is not animated');
    assert.equal(isAnimatedPng(Buffer.from('GIF89a....')), false, 'non-PNG is rejected');
    assert.equal(isAnimatedPng(Buffer.alloc(0)), false, 'empty buffer is rejected');

    const { status, body } = await upload(ctx, alice.token, 'sticker.png', 'image/png', apng);
    assert.equal(status, 201);
    const file = body.file;
    assert.equal(file.thumbUrl, undefined, 'no thumbnail advertised for an animated PNG');

    // ?thumb=1 must hand back the original bytes, not a flattened webp
    const resp = await fetch(`http://127.0.0.1:${ctx.port}/api/files/${file.id}?thumb=1`, {
      headers: { authorization: `Bearer ${alice.token}` },
    });
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get('content-type'), 'image/png', 'served as the original PNG');
    const bytes = Buffer.from(await resp.arrayBuffer());
    assert.equal(bytes.length, apng.length, 'byte-identical to the upload');
    assert.equal(bytes.subarray(0, 4).toString('hex'), '89504e47', 'still a PNG');
    assert.equal(isAnimatedPng(bytes), true, 'animation survived the round-trip');
  } finally {
    await ctx.close();
    tmp.restore();
  }
});

test('a plain PNG uploaded next to an APNG still gets its thumbnail', async () => {
  const tmp = withTempUploads();
  const ctx = await createTestContext();
  try {
    const alice = await registerUser(ctx, 'alice', 'Alice', 'password123');
    const plain = await bigPng(400, 300);
    const { body } = await upload(ctx, alice.token, 'photo.png', 'image/png', plain);
    assert.equal(body.file.thumbUrl, `/api/files/${body.file.id}?thumb=1`, 'static PNG keeps its thumbnail');
  } finally {
    await ctx.close();
    tmp.restore();
  }
});
