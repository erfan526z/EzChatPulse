import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

export type Db = Database.Database;

const schemaSql = fs.readFileSync(path.join(import.meta.dirname, 'schema.sql'), 'utf8');

const migrations: Array<{ version: number; up: (db: Db) => void }> = [
  {
    // v2 — message edit/delete: edited_at + deleted_at on messages, per-user hiding
    version: 2,
    up(db) {
      const cols = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>;
      const has = (n: string) => cols.some((c) => c.name === n);
      if (!has('edited_at')) db.exec('ALTER TABLE messages ADD COLUMN edited_at INTEGER');
      if (!has('deleted_at')) db.exec('ALTER TABLE messages ADD COLUMN deleted_at INTEGER');
      db.exec(`CREATE TABLE IF NOT EXISTS message_hidden (
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        hidden_at  INTEGER NOT NULL,
        PRIMARY KEY (user_id, message_id)
      )`);
    },
  },
  {
    // v3 — admin panel: key/value app settings (e.g. registration kill-switch)
    version: 3,
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS app_settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`);
    },
  },
  {
    // v4 — email capture: optional user email (set once), verified flag
    version: 4,
    up(db) {
      const cols = db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
      const has = (n: string) => cols.some((c) => c.name === n);
      if (!has('email')) db.exec('ALTER TABLE users ADD COLUMN email TEXT');
      if (!has('email_verified')) db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0');
    },
  },
  {
    // v5 — captcha replay protection: record solved challenge tokens (single use)
    version: 5,
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS captcha_used (
        token_hash TEXT PRIMARY KEY,
        used_at INTEGER NOT NULL
      )`);
    },
  },
];

function runMigrations(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as {
    v: number | null;
  };
  if (row.v === null) {
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(1, Date.now());
  }
  const current = (db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null }).v ?? 0;
  for (const m of migrations) {
    if (m.version > current) {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(m.version, Date.now());
    }
  }
}

/** Open a fresh database connection (file path or ':memory:'). */
export function openDb(dbPath: string): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(schemaSql);
  runMigrations(db);
  return db;
}

let defaultDb: Db | null = null;
let testDb: Db | null = null;

/** Override for tests: call `setTestDb(openDb(':memory:'))` before running routes. */
export function setTestDb(db: Db | null): void {
  testDb = db;
}

/** App-wide default connection (config.dbPath), or the test override if set. */
export function getDb(): Db {
  if (testDb) return testDb;
  if (!defaultDb) defaultDb = openDb(config.dbPath);
  return defaultDb;
}

// ── Key/value app settings (admin kill-switches etc.) ──────────────────
export function getSetting(db: Db, key: string, fallback: string): string {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? fallback;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}
