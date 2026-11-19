#!/usr/bin/env node
/**
 * Build a scaled synthetic database for performance work.
 *
 *   node scripts/seed-scale.mjs --out /tmp/scale --users 200 --chats 100 --messages 50000
 *
 * Uses the real migrations and schema, so query plans and index usage are the
 * ones production will use. Message text is filler, never real content.
 */
import { createRequire } from 'node:module';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const require = createRequire(ROOT + 'package.json');
const { openDb } = await import(ROOT + 'server/dist/db.js');
const bcrypt = require('bcryptjs');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};
const out = (() => {
  const i = process.argv.indexOf('--out');
  return i === -1 ? '/tmp/chatpulse-scale' : process.argv[i + 1];
})();
const USERS = arg('users', 200);
const CHATS = arg('chats', 100);
const MESSAGES = arg('messages', 50000);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const dbPath = path.join(out, 'chatpulse.db');
const db = openDb(dbPath);

const now = Date.now();
const DAY = 86_400_000;
const t0 = Date.now();

const PROBE_HASH = bcrypt.hashSync('probepass123', 4); // low cost: throwaway db

db.transaction(() => {
  const insUser = db.prepare(
    'INSERT INTO users (username, display_name, password_hash, created_at, email, email_verified, bio) VALUES (?,?,?,?,?,?,?)',
  );
  const users = [];
  for (let i = 1; i <= USERS; i++) {
    const info = insUser.run(
      `scale_${i}`,
      `Scale User ${i}`,
      'x'.repeat(60), // bcrypt-shaped filler; these accounts are never logged into
      now - Math.floor(Math.random() * 365) * DAY,
      i % 3 === 0 ? `scale${i}@example.com` : null,
      i % 3 === 0 ? 1 : 0,
      i % 5 === 0 ? 'just here for the load test' : null,
    );
    users.push(Number(info.lastInsertRowid));
  }

  // the account the perf probe logs in as — a member of every group, so its
  // chat list and unread counts are the worst case
  const probeInfo = insUser.run('probe', 'Probe User', PROBE_HASH, now, null, 0, null);
  const probeId = Number(probeInfo.lastInsertRowid);

  const insChat = db.prepare('INSERT INTO chats (type, name, description, created_at) VALUES (?,?,?,?)');
  const insMember = db.prepare('INSERT INTO chat_members (chat_id, user_id, role, joined_at) VALUES (?,?,?,?)');
  const insRead = db.prepare(
    'INSERT INTO read_state (chat_id, user_id, last_read_message_id, updated_at) VALUES (?,?,?,?)',
  );
  const chats = [];
  for (let c = 0; c < CHATS; c++) {
    const isGroup = c % 3 !== 0;
    const info = insChat.run(
      isGroup ? 'group' : 'private',
      isGroup ? `Load Group ${c}` : null,
      isGroup && c % 6 === 0 ? 'A group created for scale testing.' : null,
      now - Math.floor(Math.random() * 300) * DAY,
    );
    const chatId = Number(info.lastInsertRowid);
    const size = isGroup ? 3 + Math.floor(Math.random() * 20) : 2;
    const picked = new Set();
    while (picked.size < size) picked.add(users[Math.floor(Math.random() * users.length)]);
    picked.add(probeId); // every chat includes the probe
    let first = true;
    for (const uid of picked) {
      insMember.run(chatId, uid, first ? 'admin' : 'member', now - DAY);
      insRead.run(chatId, uid, 0, now);
      first = false;
    }
    chats.push({ id: chatId, members: [...picked] });
  }

  const insMsg = db.prepare(
    'INSERT INTO messages (chat_id, sender_id, kind, text, file_id, reply_to, created_at, edited_at, deleted_at) VALUES (?,?,?,?,?,?,?,?,?)',
  );
  const perChat = Math.ceil(MESSAGES / chats.length);
  let made = 0;
  for (const chat of chats) {
    for (let i = 0; i < perChat && made < MESSAGES; i++) {
      const sender = chat.members[Math.floor(Math.random() * chat.members.length)];
      const at = now - Math.floor(Math.random() * 90) * DAY - i * 60_000;
      insMsg.run(chat.id, sender, 'text', `load test message ${made} — ${'lorem ipsum '.repeat(2 + (made % 12))}`, null, null, at, null, null);
      made++;
    }
  }
  // mirror the join-time behaviour: a member starts reading from the newest
  // message, so "unread" reflects new activity rather than the whole history
  db.exec(`UPDATE read_state
              SET last_read_message_id = COALESCE(
                (SELECT MAX(id) FROM messages m WHERE m.chat_id = read_state.chat_id AND m.deleted_at IS NULL), 0)`);
})();

const counts = {
  users: db.prepare('SELECT COUNT(*) n FROM users').get().n,
  chats: db.prepare('SELECT COUNT(*) n FROM chats').get().n,
  messages: db.prepare('SELECT COUNT(*) n FROM messages').get().n,
};
db.pragma('wal_checkpoint(TRUNCATE)');
db.close();
console.log(`seeded ${dbPath} in ${Date.now() - t0}ms`, counts);
