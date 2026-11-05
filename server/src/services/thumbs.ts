import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { Db } from '../db.js';
import { config } from '../config.js';
import type { StoredFile } from './files.js';

/** Longest edge of a chat-bubble thumbnail. Big enough for a 2× retina bubble. */
export const THUMB_MAX = 512;
const THUMB_QUALITY = 78;
const THUMB_MIME = 'image/webp';

export interface Thumb {
  absPath: string;
  size: number;
}

/** Requests already generating a thumb for this file (avoid duplicate work). */
const inFlight = new Map<number, Promise<Thumb | null>>();

/**
 * Types we can shrink usefully. SVG stays as-is (vector, already tiny) and GIF
 * too (rasterising would drop the animation — a still thumbnail in the bubble
 * would be worse than a slightly bigger animated file).
 */
export function isThumbnailable(mime: string): boolean {
  return mime.startsWith('image/') && !['image/svg+xml', 'image/gif'].includes(mime);
}

export function thumbMime(): string {
  return THUMB_MIME;
}

/**
 * Return the cached thumbnail for a file, generating it on first use.
 *
 * Generation is lazy so that files uploaded before thumbnails existed (and any
 * upload where generation failed) heal on their first request. Never throws:
 * a broken image simply falls back to the original.
 */
export function ensureThumb(db: Db, file: StoredFile): Promise<Thumb | null> {
  if (!isThumbnailable(file.mime)) return Promise.resolve(null);

  if (file.thumb_path) {
    const abs = path.join(config.uploadsDir, file.thumb_path);
    if (fs.existsSync(abs)) {
      return Promise.resolve({ absPath: abs, size: file.thumb_size ?? fs.statSync(abs).size });
    }
  }

  const running = inFlight.get(file.id);
  if (running) return running;

  const job = generate(db, file).finally(() => inFlight.delete(file.id));
  inFlight.set(file.id, job);
  return job;
}

async function generate(db: Db, file: StoredFile): Promise<Thumb | null> {
  const src = path.join(config.uploadsDir, file.stored_path);
  if (!fs.existsSync(src)) return null;

  try {
    const buf = await sharp(src, { failOn: 'none' })
      .rotate() // honour EXIF orientation, otherwise phone photos come out sideways
      .resize(THUMB_MAX, THUMB_MAX, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: THUMB_QUALITY })
      .toBuffer();

    // same sharded folder as the original, addressed by content hash
    const rel = path.join(path.dirname(file.stored_path), `${file.sha256}.thumb.webp`);
    const abs = path.join(config.uploadsDir, rel);
    const tmp = `${abs}.tmp`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, abs);

    db.prepare('UPDATE files SET thumb_path = ?, thumb_size = ? WHERE id = ?').run(rel, buf.length, file.id);
    return { absPath: abs, size: buf.length };
  } catch (err) {
    console.warn(`thumbnail failed for file #${file.id}:`, (err as Error).message);
    return null;
  }
}
