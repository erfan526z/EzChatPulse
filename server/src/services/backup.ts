import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Db } from '../db.js';
import { BadRequest, NotFound } from '../errors.js';

/**
 * Backups: a single timestamped .tar.gz in `<dataDir>/backups/` holding
 *   chatpulse.db   — snapshot taken with SQLite's online backup API (WAL-safe,
 *                    consistent even while the server keeps writing)
 *   uploads/       — the content-addressed file store (best effort)
 *   manifest.json  — when it was taken, what it contains
 *
 * Restore is deliberately a cold operation: the caller must close the database
 * handle first, then `restoreFrom()` swaps the file atomically (rename) so a
 * crash mid-restore can never leave a half-written database in place.
 */

export interface BackupEntry {
  name: string;
  sizeBytes: number;
  createdAt: number;
}

const NAME_RE = /^backup-[0-9A-Za-z._-]+\.tar\.gz$/;
const SQLITE_MAGIC = 'SQLite format 3\u0000';

export function backupsDir(dataDir: string): string {
  return path.join(dataDir, 'backups');
}

/** Backup filesystem name for a moment in time. */
function backupName(when: Date, label?: string): string {
  const stamp = when.toISOString().replace(/[:.]/g, '-').replace('Z', 'Z');
  return `backup-${stamp}${label ? '-' + label.replace(/[^0-9A-Za-z_-]/g, '') : ''}.tar.gz`;
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function countFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(path.join(dir, entry.name));
    else if (entry.isFile()) n += 1;
  }
  return n;
}

/** Create a backup now. Returns its entry. */
export async function createBackup(db: Db, dataDir: string, label?: string): Promise<BackupEntry> {
  const dir = backupsDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const name = backupName(new Date(), label);
  const finalPath = path.join(dir, name);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'chatpulse-backup-'));

  try {
    // 1. consistent, WAL-safe database snapshot
    const dbSnapshot = path.join(staging, 'chatpulse.db');
    await db.backup(dbSnapshot);

    // 2. uploaded files (best effort — a missing uploads dir must not fail a backup)
    const uploadsSrc = path.join(dataDir, 'uploads');
    if (fs.existsSync(uploadsSrc)) copyDir(uploadsSrc, path.join(staging, 'uploads'));

    // 3. manifest
    const manifest = {
      createdAt: new Date().toISOString(),
      label: label ?? 'scheduled',
      dbBytes: fs.statSync(dbSnapshot).size,
      uploadFiles: countFiles(uploadsSrc),
    };
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));

    // 4. archive
    execFileSync('tar', ['-czf', finalPath, '-C', staging, '.'], { stdio: 'pipe' });
    const st = fs.statSync(finalPath);
    return { name, sizeBytes: st.size, createdAt: Math.round(st.mtimeMs) };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** Newest-first list of available backups. */
export function listBackups(dataDir: string): BackupEntry[] {
  const dir = backupsDir(dataDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => NAME_RE.test(f))
    .map((name) => {
      const st = fs.statSync(path.join(dir, name));
      return { name, sizeBytes: st.size, createdAt: Math.round(st.mtimeMs) };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function backupPath(dataDir: string, name: string): string {
  if (!NAME_RE.test(name)) throw new BadRequest('Invalid backup name');
  const full = path.join(backupsDir(dataDir), name);
  // defence in depth: never escape the backups directory
  if (path.dirname(path.resolve(full)) !== path.resolve(backupsDir(dataDir))) {
    throw new BadRequest('Invalid backup name');
  }
  if (!fs.existsSync(full)) throw new NotFound('Backup not found');
  return full;
}

export function deleteBackup(dataDir: string, name: string): void {
  fs.rmSync(backupPath(dataDir, name), { force: true });
}

/** Keep the newest `keep` backups, delete the rest. Returns how many were removed. */
export function pruneBackups(dataDir: string, keep: number): number {
  if (keep < 1) return 0;
  const all = listBackups(dataDir);
  const doomed = all.slice(keep);
  for (const b of doomed) fs.rmSync(path.join(backupsDir(dataDir), b.name), { force: true });
  return doomed.length;
}

/**
 * Apply a backup. The database handle MUST be closed by the caller first:
 * this replaces the live database file (atomic rename) and copies the backed-up
 * uploads back in (merge — never deletes files that only exist now).
 */
export function restoreFrom(dataDir: string, name: string): void {
  const archive = backupPath(dataDir, name);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'chatpulse-restore-'));

  try {
    execFileSync('tar', ['-xzf', archive, '-C', staging], { stdio: 'pipe' });

    const dbFile = path.join(staging, 'chatpulse.db');
    if (!fs.existsSync(dbFile)) throw new BadRequest('Backup does not contain a database');

    // verify the header before letting it anywhere near the live file
    const head = Buffer.alloc(SQLITE_MAGIC.length);
    const fd = fs.openSync(dbFile, 'r');
    try {
      fs.readSync(fd, head, 0, head.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (head.toString('utf8') !== SQLITE_MAGIC) throw new BadRequest('Backup database is not a valid SQLite file');

    const live = path.join(dataDir, 'chatpulse.db');
    // stale WAL/SHM from the old database must not be replayed onto this one
    for (const suffix of ['-wal', '-shm']) fs.rmSync(live + suffix, { force: true });

    const staged = live + '.restoring';
    fs.copyFileSync(dbFile, staged);
    fs.renameSync(staged, live);

    const uploads = path.join(staging, 'uploads');
    if (fs.existsSync(uploads)) copyDir(uploads, path.join(dataDir, 'uploads'));
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Start the periodic backup schedule. Returns the timer (or null when disabled
 * with an interval <= 0). Also takes a catch-up backup shortly after boot when
 * the newest existing backup is already older than the interval.
 */
export function startBackupSchedule(
  db: Db,
  dataDir: string,
  intervalHours: number,
  keep: number,
): NodeJS.Timeout | null {
  if (!Number.isFinite(intervalHours) || intervalHours <= 0) return null;

  const run = async (): Promise<void> => {
    try {
      const entry = await createBackup(db, dataDir);
      const pruned = pruneBackups(dataDir, keep);
      console.log(`backup: ${entry.name} (${Math.round(entry.sizeBytes / 1024)} KiB)${pruned ? `, pruned ${pruned} old` : ''}`);
    } catch (err) {
      console.error('backup failed:', err);
    }
  };

  const timer = setInterval(() => void run(), intervalHours * 3_600_000);
  timer.unref();

  const catchUp = setTimeout(() => {
    const newest = listBackups(dataDir)[0]?.createdAt ?? 0;
    if (Date.now() - newest > intervalHours * 3_600_000) void run();
  }, 60_000);
  catchUp.unref();

  return timer;
}
