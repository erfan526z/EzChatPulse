import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { openDb } from '../src/db.js';
import {
  createBackup,
  listBackups,
  pruneBackups,
  backupPath,
  deleteBackup,
  restoreFrom,
  backupsDir,
} from '../src/services/backup.js';
import { createTestContext, registerUser } from './helpers.js';

/** authenticating fetch against a running test context */
function makeAuthed(ctx: { port: number }) {
  return (path: string, token: string, options: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${ctx.port}${path}`, {
      ...options,
      headers: { authorization: `Bearer ${token}`, ...(options.headers ?? {}) },
    });
}

// NOTE: never call POST /api/admin/restore with a valid backup name from a test —
// the route intentionally exits the process after swapping files.

interface Workspace {
  dir: string;
  dbPath: string;
  db: ReturnType<typeof openDb>;
  cleanup: () => void;
}

function workspace(): Workspace {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatpulse-backup-test-'));
  const dbPath = path.join(dir, 'chatpulse.db');
  const db = openDb(dbPath);
  return {
    dir,
    dbPath,
    db,
    cleanup: () => {
      try {
        db.close();
      } catch {
        /* already closed */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function seedUser(db: Workspace['db'], username: string): void {
  db.prepare(
    'INSERT INTO users (username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?)',
  ).run(username, username, 'x', Date.now());
}

function usernames(dbPath: string): string[] {
  const probe = new Database(dbPath, { readonly: true });
  try {
    return (probe.prepare('SELECT username FROM users ORDER BY id').all() as Array<{ username: string }>).map(
      (r) => r.username,
    );
  } finally {
    probe.close();
  }
}

test('createBackup: writes an archive containing a usable database snapshot', async () => {
  const ws = workspace();
  try {
    seedUser(ws.db, 'alice');
    fs.mkdirSync(path.join(ws.dir, 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(ws.dir, 'uploads', 'note.txt'), 'hello');

    const entry = await createBackup(ws.db, ws.dir);
    assert.match(entry.name, /^backup-.*\.tar\.gz$/);
    assert.ok(entry.sizeBytes > 0);

    const archive = path.join(backupsDir(ws.dir), entry.name);
    assert.ok(fs.existsSync(archive));

    // inspect the archive contents
    const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
    assert.ok(listing.includes('./chatpulse.db'), 'contains the database');
    assert.ok(listing.includes('./manifest.json'), 'contains the manifest');
    assert.ok(listing.includes('uploads/note.txt'), 'contains uploaded files');

    // the snapshot itself must be a readable database with the seeded row
    const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatpulse-backup-extract-'));
    try {
      execFileSync('tar', ['-xzf', archive, '-C', extractDir]);
      assert.deepEqual(usernames(path.join(extractDir, 'chatpulse.db')), ['alice']);
    } finally {
      fs.rmSync(extractDir, { recursive: true, force: true });
    }
  } finally {
    ws.cleanup();
  }
});

test('createBackup: WAL content is captured (snapshot taken online, not by copying the file)', async () => {
  const ws = workspace();
  try {
    // writes land in the WAL; a naive file copy would miss them
    seedUser(ws.db, 'in_wal_user');
    const entry = await createBackup(ws.db, ws.dir);

    const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatpulse-backup-wal-'));
    try {
      execFileSync('tar', ['-xzf', path.join(backupsDir(ws.dir), entry.name), '-C', extractDir]);
      assert.ok(
        usernames(path.join(extractDir, 'chatpulse.db')).includes('in_wal_user'),
        'row written before the backup must be in the snapshot',
      );
    } finally {
      fs.rmSync(extractDir, { recursive: true, force: true });
    }
  } finally {
    ws.cleanup();
  }
});

test('listBackups: newest first; pruneBackups keeps the newest N', async () => {
  const ws = workspace();
  try {
    const made: string[] = [];
    for (let i = 0; i < 3; i++) {
      const entry = await createBackup(ws.db, ws.dir);
      made.push(entry.name);
      await new Promise((r) => setTimeout(r, 1100)); // distinct mtimes → distinct names
    }
    const list = listBackups(ws.dir);
    assert.equal(list.length, 3);
    assert.equal(list[0].name, made[2], 'newest first');

    const pruned = pruneBackups(ws.dir, 2);
    assert.equal(pruned, 1);
    assert.equal(listBackups(ws.dir).length, 2);
    assert.ok(!fs.existsSync(path.join(backupsDir(ws.dir), made[0])), 'oldest removed');
  } finally {
    ws.cleanup();
  }
});

test('backupPath: rejects traversal and absolute paths, 404s unknown names', () => {
  const ws = workspace();
  try {
    assert.throws(() => backupPath(ws.dir, '../chatpulse.db'), /Invalid backup name/);
    assert.throws(() => backupPath(ws.dir, '/etc/passwd'), /Invalid backup name/);
    assert.throws(() => backupPath(ws.dir, 'backup-x.tar.gz/../../x'), /Invalid backup name/);
    assert.throws(() => backupPath(ws.dir, 'backup-missing.tar.gz'), /Backup not found/);
  } finally {
    ws.cleanup();
  }
});

test('deleteBackup: removes the archive', async () => {
  const ws = workspace();
  try {
    const entry = await createBackup(ws.db, ws.dir);
    const file = path.join(backupsDir(ws.dir), entry.name);
    assert.ok(fs.existsSync(file));
    deleteBackup(ws.dir, entry.name);
    assert.ok(!fs.existsSync(file));
    assert.equal(listBackups(ws.dir).length, 0);
  } finally {
    ws.cleanup();
  }
});

test('restoreFrom: brings the database back to the backed-up state', async () => {
  const ws = workspace();
  try {
    seedUser(ws.db, 'before_backup');
    const entry = await createBackup(ws.db, ws.dir);

    // drift: add a row AFTER the backup
    seedUser(ws.db, 'after_backup');
    assert.deepEqual(usernames(ws.dbPath).sort(), ['after_backup', 'before_backup']);

    ws.db.close();
    restoreFrom(ws.dir, entry.name);

    // stale WAL/SHM must be gone immediately after the swap (checked before
    // opening the file again — reading it would create a fresh WAL)
    assert.ok(!fs.existsSync(ws.dbPath + '-wal'), 'stale WAL removed');
    assert.ok(!fs.existsSync(ws.dbPath + '-shm'), 'stale SHM removed');

    assert.deepEqual(usernames(ws.dbPath), ['before_backup'], 'post-backup row is gone');
  } finally {
    ws.cleanup();
  }
});

test('restoreFrom: refuses an archive whose database is not SQLite', () => {
  const ws = workspace();
  try {
    // hand-crafted archive with a bogus "database"
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'chatpulse-bad-backup-'));
    fs.writeFileSync(path.join(staging, 'chatpulse.db'), 'this is not a sqlite file');
    const dir = backupsDir(ws.dir);
    fs.mkdirSync(dir, { recursive: true });
    const name = 'backup-bogus.tar.gz';
    execFileSync('tar', ['-czf', path.join(dir, name), '-C', staging, '.']);

    assert.throws(() => restoreFrom(ws.dir, name), /not a valid SQLite file/);
    fs.rmSync(staging, { recursive: true, force: true });
  } finally {
    ws.cleanup();
  }
});

test('restoreFrom: refuses an archive with no database at all', () => {
  const ws = workspace();
  try {
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'chatpulse-empty-backup-'));
    fs.writeFileSync(path.join(staging, 'manifest.json'), '{}');
    const dir = backupsDir(ws.dir);
    fs.mkdirSync(dir, { recursive: true });
    const name = 'backup-nodb.tar.gz';
    execFileSync('tar', ['-czf', path.join(dir, name), '-C', staging, '.']);

    assert.throws(() => restoreFrom(ws.dir, name), /does not contain a database/);
    fs.rmSync(staging, { recursive: true, force: true });
  } finally {
    ws.cleanup();
  }
});

// ── route guards (safe calls only: no valid backup name is ever passed) ──

test('backup routes: non-admin gets 403', async () => {
  const ctx = await createTestContext();
  const authed = makeAuthed(ctx);
  try {
    const alice = await registerUser(ctx, 'alice', 'Alice', 'password123');
    const list = await authed('/api/admin/backups', alice.token);
    assert.equal(list.status, 403);
    const create = await authed('/api/admin/backups', alice.token, { method: 'POST' });
    assert.equal(create.status, 403);
    const restore = await authed('/api/admin/restore', alice.token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'backup-x.tar.gz', confirm: 'RESTORE' }),
    });
    assert.equal(restore.status, 403);
  } finally {
    await ctx.close();
  }
});

test('restore route: requires the explicit confirm token and a valid name', async () => {
  const ctx = await createTestContext();
  const authed = makeAuthed(ctx);
  const previous = process.env.ADMIN_USERNAMES;
  process.env.ADMIN_USERNAMES = 'admin';
  try {
    const admin = await registerUser(ctx, 'admin', 'Admin', 'password123');

    // no token → 400 (never reaches any file operation)
    const noToken = await authed('/api/admin/restore', admin.token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'backup-x.tar.gz' }),
    });
    assert.equal(noToken.status, 400);

    // token but traversal name → 400
    const traversal = await authed('/api/admin/restore', admin.token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '../../chatpulse.db', confirm: 'RESTORE' }),
    });
    assert.equal(traversal.status, 400);

    // token but unknown backup → 404-ish error (Backup not found)
    const missing = await authed('/api/admin/restore', admin.token, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'backup-does-not-exist.tar.gz', confirm: 'RESTORE' }),
    });
    assert.ok([400, 404].includes(missing.status), `unexpected status ${missing.status}`);
  } finally {
    if (previous === undefined) delete process.env.ADMIN_USERNAMES;
    else process.env.ADMIN_USERNAMES = previous;
    await ctx.close();
  }
});
