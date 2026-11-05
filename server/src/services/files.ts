import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Db } from '../db.js';
import { config } from '../config.js';
import { BadRequest } from '../errors.js';
import { isThumbnailable } from './thumbs.js';

export interface FileDTO {
  id: number;
  name: string;
  mime: string;
  size: number;
  url: string;
  /** smaller version for chat bubbles (absent for non-shinkable types) */
  thumbUrl?: string;
}

export interface StoredFile {
  id: number;
  owner_id: number;
  name: string;
  mime: string;
  size: number;
  sha256: string;
  stored_path: string;
  thumb_path: string | null;
  thumb_size: number | null;
}

/** The one place a file is turned into its wire shape. */
export function fileDTO(file: { id: number; name: string; mime: string; size: number }): FileDTO {
  const dto: FileDTO = {
    id: file.id,
    name: file.name,
    mime: file.mime,
    size: file.size,
    url: `/api/files/${file.id}`,
  };
  if (isThumbnailable(file.mime)) dto.thumbUrl = `/api/files/${file.id}?thumb=1`;
  return dto;
}

/**
 * multer/busboy decodes Content-Disposition filenames as latin1, so UTF-8
 * filenames (Persian, Cyrillic, …) arrive mojibaked ("ØªÙ…"). Repair them:
 * re-encode latin1 → bytes → UTF-8. Safe for ASCII (identity), and the
 * U+FFFD check keeps already-correct names untouched.
 */
function decodeFilename(name: string): string {
  if (!/[^\x00-\x7F]/.test(name)) return name; // pure ASCII — nothing to do
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  return decoded.includes('\uFFFD') ? name : decoded;
}

/**
 * Persist an uploaded file to disk (content-addressed by sha256) and record it.
 * Duplicate content is deduplicated to a single row + blob.
 */
export function storeUpload(
  db: Db,
  ownerId: number,
  file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
): FileDTO {
  if (file.size === 0) throw new BadRequest('Empty files are not allowed');
  if (file.size > config.maxUploadBytes) {
    throw new BadRequest(`File too large (max ${Math.floor(config.maxUploadBytes / 1024 / 1024)} MB)`);
  }

  const name = decodeFilename(file.originalname);
  const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');

  const existing = db.prepare('SELECT id, name, mime, size FROM files WHERE sha256 = ?').get(sha256) as
    | { id: number; name: string; mime: string; size: number }
    | undefined;
  if (existing) return fileDTO(existing);

  const subdir = sha256.slice(0, 2);
  const dir = path.join(config.uploadsDir, subdir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(config.uploadsDir, subdir, sha256), file.buffer);

  const info = db
    .prepare('INSERT INTO files (owner_id, name, mime, size, sha256, stored_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(ownerId, name, file.mimetype, file.size, sha256, path.join(subdir, sha256), Date.now());

  return fileDTO({
    id: Number(info.lastInsertRowid),
    name,
    mime: file.mimetype,
    size: file.size,
  });
}

export function getFileRow(db: Db, id: number): StoredFile | undefined {
  return db
    .prepare('SELECT id, owner_id, name, mime, size, sha256, stored_path, thumb_path, thumb_size FROM files WHERE id = ?')
    .get(id) as StoredFile | undefined;
}
