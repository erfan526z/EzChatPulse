import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { getDb } from '../db.js';
import { requireAuth } from '../auth.js';
import { storeUpload, getFileRow } from '../services/files.js';
import { ensureThumb, thumbMime } from '../services/thumbs.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes },
});

const wrap = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

/** Upload a file. Returns file metadata; attach it to a message via msg.send. */
router.post('/upload', requireAuth, upload.single('file'), wrap(async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded (multipart field name must be "file")' });
    return;
  }
  const db = getDb();
  const file = storeUpload(db, req.userId, req.file);
  // Build the bubble-sized version now so the first render is instant; failure
  // is harmless (the download route regenerates lazily).
  const row = getFileRow(db, file.id);
  if (row) await ensureThumb(db, row);
  res.status(201).json({ file });
}));

/**
 * Download a file. Access rule:
 * - the owner may always fetch their own upload (enables instant preview),
 * - otherwise the file must be attached to a message in a chat the user belongs to.
 */
router.get('/files/:id', requireAuth, wrap(async (req, res) => {
  const fileId = Number(req.params.id);
  if (!Number.isInteger(fileId)) {
    res.status(400).json({ error: 'Invalid file id' });
    return;
  }
  const db = getDb();
  const file = getFileRow(db, fileId);
  if (!file) {
    res.status(404).json({ error: 'File not found' });
    return;
  }

  const isOwner = file.owner_id === req.userId;
  const ref = db
    .prepare(
      `SELECT m.chat_id FROM messages m
       JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = ?
       WHERE m.file_id = ? LIMIT 1`,
    )
    .get(req.userId, fileId);
  // A profile picture is not attached to a message, so it needs its own rule:
  // visible to anyone who shares a chat with its owner (the same people who are
  // allowed to open that profile).
  const avatarOf = db
    .prepare(
      `SELECT u.id FROM users u
       JOIN chat_members mine ON mine.user_id = ?
       JOIN chat_members theirs ON theirs.chat_id = mine.chat_id AND theirs.user_id = u.id
       WHERE u.avatar_file_id = ? LIMIT 1`,
    )
    .get(req.userId, fileId);
  if (!isOwner && !ref && !avatarOf) {
    res.status(403).json({ error: 'You do not have access to this file' });
    return;
  }

  const abs = path.join(config.uploadsDir, file.stored_path);
  if (!fs.existsSync(abs)) {
    res.status(404).json({ error: 'File missing on disk' });
    return;
  }

  // `?thumb=1` → bubble-sized webp (generated on first use, so older uploads
  // heal automatically). Falls back to the original when there is no thumbnail.
  const wantThumb = req.query.thumb === '1';
  const thumb = wantThumb ? await ensureThumb(db, file) : null;
  const servePath = thumb?.absPath ?? abs;
  const serveSize = thumb?.size ?? file.size;
  const contentType = thumb ? thumbMime() : file.mime;
  const isImage = contentType.startsWith('image/');

  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', String(serveSize));
  res.setHeader(
    'Content-Disposition',
    `${isImage ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
  );
  // A file row is one immutable upload (content-addressed by sha256), so the
  // bytes behind this URL never change: let the browser keep them forever and
  // skip re-downloading images on every chat open. `private` because access is
  // per-account. The thumbnail variant gets its own validator.
  const etag = `"${file.sha256}${thumb ? '-thumb' : ''}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  if (req.headers['if-none-match'] === etag) {
    res.removeHeader('Content-Length');
    res.status(304).end();
    return;
  }
  fs.createReadStream(servePath).pipe(res);
}));

export default router;
