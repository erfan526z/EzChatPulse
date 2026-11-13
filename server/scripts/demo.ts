// Demo dataset for UI work: a handful of believable chats with avatars, images,
// groups and unread states. Idempotent-ish: refuses to run on a DB that already
// has accounts unless DEMO_FORCE=1.
//
//   DATA_DIR=/tmp/cp-ui npm run demo -w server
//
// Login afterwards: demo / demopass123
import fs from 'node:fs';
import bcrypt from 'bcryptjs';
import sharp from 'sharp';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { storeUpload } from '../src/services/files.js';
import { ensureThumb } from '../src/services/thumbs.js';

const PASSWORD = 'demopass123';
const now = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A round avatar: gradient disc + initial, rendered by sharp from SVG. */
async function avatarPng(letter: string, hue: number): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue},68%,58%)"/>
      <stop offset="1" stop-color="hsl(${(hue + 40) % 360},72%,38%)"/>
    </linearGradient></defs>
    <rect width="512" height="512" fill="url(#g)"/>
    <text x="256" y="256" text-anchor="middle" dominant-baseline="central"
          font-family="Helvetica,Arial,sans-serif" font-size="230" font-weight="700"
          fill="rgba(255,255,255,0.92)">${letter}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** A photo-ish image with some structure, so bubbles don't look like flat blocks. */
async function photoPng(seedHue: number): Promise<Buffer> {
  const blocks = Array.from({ length: 40 }, (_, i) => {
    const x = (i * 97) % 900;
    const y = (i * 151) % 600;
    const w = 60 + ((i * 37) % 180);
    const h = 40 + ((i * 53) % 120);
    const hue = (seedHue + i * 9) % 360;
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="18" fill="hsl(${hue},60%,${30 + (i % 5) * 9}%)" opacity="0.85"/>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600">
    <rect width="900" height="600" fill="hsl(${seedHue},35%,14%)"/>${blocks}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function main(): void {
  const db = openDb(config.dbPath);
  const existing = (db.prepare('SELECT COUNT(*) n FROM users').get() as { n: number }).n;
  if (existing > 0 && process.env.DEMO_FORCE !== '1') {
    console.error(`DB already has ${existing} accounts. Set DEMO_FORCE=1 to wipe and reseed.`);
    process.exit(1);
  }
  if (existing > 0 && process.env.DEMO_FORCE === '1') {
    // users.avatar_file_id → files: break that edge before touching files
    db.prepare('UPDATE users SET avatar_file_id = NULL').run();
    for (const t of ['message_hidden', 'read_state', 'messages', 'chat_members', 'chats', 'files']) {
      db.prepare(`DELETE FROM ${t}`).run();
    }
    db.prepare('DELETE FROM users').run();
  }

  const hash = bcrypt.hashSync(PASSWORD, 10);
  const insUser = db.prepare(
    'INSERT INTO users (username, display_name, password_hash, created_at, last_seen_at, bio) VALUES (?,?,?,?,?,?)',
  );
  const mkUser = (username: string, display: string, bio: string | null, lastSeen: number | null): number =>
    Number(insUser.run(username, display, hash, now - 40 * DAY, lastSeen, bio).lastInsertRowid);

  const me = mkUser('demo', 'Erfan', 'Hello :)', null); // online
  const buddy = mkUser('buddy', 'Buddy', 'Usually around', now - 3 * MIN);
  const jack = mkUser('jack', 'Jack', 'Designer · coffee first', now - 12 * MIN);
  const green = mkUser('drgreen', 'Dr. Green', 'Plants and long walks', now - 6 * HOUR);
  const someone = mkUser('someone', 'Someone', "I'm just… someone", now - 2 * DAY);
  const sina = mkUser('sina', 'Sina', 'builds things', now - 40 * MIN);

  /** Upload a buffer as this user's avatar (goes through the real file pipeline). */
  async function setAvatar(userId: number, png: Buffer, name: string): Promise<void> {
    const dto = storeUpload(db, userId, {
      originalname: name,
      mimetype: 'image/png',
      size: png.length,
      buffer: png,
    });
    const row = db.prepare('SELECT * FROM files WHERE id = ?').get(dto.id) as Parameters<typeof ensureThumb>[1];
    await ensureThumb(db, row);
    db.prepare('UPDATE users SET avatar_file_id = ? WHERE id = ?').run(dto.id, userId);
  }

  const insChat = db.prepare('INSERT INTO chats (type, name, created_by, created_at) VALUES (?,?,?,?)');
  const insMember = db.prepare('INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?,?,?,?)');
  const insMsg = db.prepare(
    'INSERT INTO messages (chat_id, sender_id, kind, text, file_id, created_at) VALUES (?,?,?,?,?,?)',
  );
  const insRead = db.prepare(
    'INSERT INTO read_state (chat_id, user_id, last_read_message_id, updated_at) VALUES (?,?,?,?)',
  );

  const privateChat = (a: number, b: number, createdAt: number): number => {
    const id = Number(insChat.run('private', null, a, createdAt).lastInsertRowid);
    insMember.run(id, a, 'member', createdAt);
    insMember.run(id, b, 'member', createdAt);
    return id;
  };

  (async () => {
    // avatars
    await setAvatar(me, await avatarPng('E', 265), 'erfan.png');
    await setAvatar(jack, await avatarPng('J', 20), 'jack.png');
    await setAvatar(green, await avatarPng('G', 145), 'green.png');
    await setAvatar(someone, await avatarPng('S', 300), 'someone.png');
    await setAvatar(sina, await avatarPng('S', 210), 'sina.png');

    // ── chat 1: Jack, one unread, message a few minutes ago ─────────────
    const cJack = privateChat(me, jack, now - 9 * DAY);
    insMsg.run(cJack, me, 'text', 'Hey, did you see the sketch?', null, now - 26 * MIN);
    insMsg.run(cJack, jack, 'text', 'Yes! The bubbles look great', null, now - 25 * MIN);
    insMsg.run(cJack, jack, 'text', 'Hey!', null, now - 3 * MIN);

    // ── chat 2: Dr. Green, read, yesterday ──────────────────────────────
    const cGreen = privateChat(me, green, now - 30 * DAY);
    insMsg.run(cGreen, green, 'text', 'Sent you the photos from the trip', null, now - DAY - 4 * HOUR);
    insMsg.run(cGreen, me, 'text', 'These are lovely, thank you', null, now - DAY - 3 * HOUR);
    insMsg.run(cGreen, green, 'text', 'Thanks!', null, now - DAY - 2 * HOUR);

    // ── chat 3: Buddy, with an image ────────────────────────────────────
    const cBuddy = privateChat(me, buddy, now - 4 * DAY);
    insMsg.run(cBuddy, buddy, 'text', 'Morning', null, now - 5 * HOUR);
    const photo = await photoPng(190);
    const photoFile = storeUpload(db, buddy, {
      originalname: 'window.png',
      mimetype: 'image/png',
      size: photo.length,
      buffer: photo,
    });
    await ensureThumb(db, db.prepare('SELECT * FROM files WHERE id = ?').get(photoFile.id) as Parameters<typeof ensureThumb>[1]);
    insMsg.run(cBuddy, buddy, 'image', 'the view from here', photoFile.id, now - 4 * HOUR);
    insMsg.run(cBuddy, me, 'text', 'That is a very good window', null, now - 3 * HOUR);

    // ── chat 4: group, several senders (bubble sender names) ────────────
    const gCreated = now - 20 * DAY;
    const group = Number(insChat.run('group', 'Our Group', me, gCreated).lastInsertRowid);
    for (const u of [me, jack, someone, sina]) insMember.run(group, u, u === me ? 'admin' : 'member', gCreated);
    insMsg.run(group, jack, 'text', 'Should we meet on Friday?', null, now - 2 * DAY);
    insMsg.run(group, someone, 'text', 'Friday works for me', null, now - 2 * DAY + 8 * MIN);
    insMsg.run(group, sina, 'text', 'Same here — 6pm?', null, now - 2 * DAY + 15 * MIN);
    insMsg.run(group, me, 'text', '6pm it is.', null, now - 2 * DAY + 22 * MIN);

    // ── chat 5: Someone, quiet ──────────────────────────────────────────
    const cSomeone = privateChat(me, someone, now - 12 * DAY);
    insMsg.run(cSomeone, someone, 'text', 'Hi! We met at the meetup', null, now - 2 * DAY);
    insMsg.run(cSomeone, me, 'text', 'Ah yes, good to see you here', null, now - 2 * DAY + 5 * MIN);

    // ── chat 6: Sina, unread 2 ──────────────────────────────────────────
    const cSina = privateChat(me, sina, now - 3 * DAY);
    insMsg.run(cSina, sina, 'text', 'the new build is up', null, now - 50 * MIN);
    insMsg.run(cSina, sina, 'text', 'tell me what you think', null, now - 48 * MIN);

    /** Mark a chat read up to N messages from the end (real ids, not guesses). */
    const markRead = (chatId: number, unread = 0): void => {
      const ids = db
        .prepare('SELECT id FROM messages WHERE chat_id = ? ORDER BY id')
        .all(chatId)
        .map((r) => (r as { id: number }).id);
      const idx = Math.max(0, ids.length - 1 - unread);
      insRead.run(chatId, me, ids[idx] ?? 0, now);
    };

    markRead(cJack, 1);
    markRead(cGreen, 0);
    markRead(cBuddy, 0);
    markRead(group, 0);
    markRead(cSomeone, 0);
    markRead(cSina, 2);

    const counts = {
      users: (db.prepare('SELECT COUNT(*) n FROM users').get() as { n: number }).n,
      chats: (db.prepare('SELECT COUNT(*) n FROM chats').get() as { n: number }).n,
      messages: (db.prepare('SELECT COUNT(*) n FROM messages').get() as { n: number }).n,
      avatars: (db.prepare('SELECT COUNT(*) n FROM users WHERE avatar_file_id IS NOT NULL').get() as { n: number }).n,
    };
    console.log('demo data ready:', JSON.stringify(counts));
    console.log(`login: demo / ${PASSWORD}`);
    console.log(`db: ${config.dbPath}`);
    db.close();
  })().catch((err) => {
    console.error('demo seed failed:', err);
    process.exit(1);
  });
}

main();
