import type { Request, Response, NextFunction } from 'express';
import zlib from 'node:zlib';

/**
 * gzip JSON responses when the client asks for it.
 *
 * The chat list is the big one: ~194 KB of JSON at 100 chats, and it is almost
 * entirely repetitive keys and short strings, so it compresses ~10:1. Static
 * assets were already brotli'd but every API response went out raw.
 *
 * Only JSON, only above 1 KB (below that the framing costs more than it saves).
 */
const MIN_BYTES = 1024;

export function gzipJson(req: Request, res: Response, next: NextFunction): void {
  const accept = String(req.headers['accept-encoding'] ?? '');
  if (!/\bgzip\b/.test(accept)) {
    next();
    return;
  }

  const sendJson = res.json.bind(res);
  res.json = (body: unknown): Response => {
    const text = JSON.stringify(body);
    const raw = Buffer.byteLength(text);
    if (raw < MIN_BYTES) return sendJson(body);

    res.setHeader('vary', 'Accept-Encoding');
    zlib.gzip(text, (err, buf) => {
      if (err) {
        // never fail a response over compression
        sendJson(body);
        return;
      }
      res.setHeader('content-encoding', 'gzip');
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('content-length', String(buf.length));
      res.end(buf);
    });
    return res;
  };

  next();
}
