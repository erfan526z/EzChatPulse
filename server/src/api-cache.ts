import type { Request, Response, NextFunction } from 'express';

/**
 * API answers are live, per-user data — a browser must never serve them from
 * cache. Without this, express leaves JSON responses cacheable-by-heuristic and
 * the browser revalidates every one of them (a full round trip for a 304).
 *
 * Routes that stream immutable content (uploaded files) set their own
 * Cache-Control afterwards and override this.
 */
export function noStoreApi(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store');
  next();
}
