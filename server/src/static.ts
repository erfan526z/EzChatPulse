import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Serve the built web client.
 *
 * Vite emits content-hashed filenames under `assets/`, so those are safe to cache
 * forever (`immutable`) — a new deploy produces new names. `index.html` must stay
 * revalidatable so a deploy is picked up on the next load, and every unknown path
 * falls back to it for client-side routing (but never for `/api/*`).
 *
 * Returns false when there is no build on disk (dev mode serves via Vite).
 */
export function mountWebClient(app: express.Express, webDist: string): boolean {
  if (!fs.existsSync(webDist)) return false;

  // hashed bundles + images from the build: cache for a year, never revalidate
  app.use(
    '/assets',
    express.static(path.join(webDist, 'assets'), {
      immutable: true,
      maxAge: '1y',
      index: false,
      fallthrough: true,
    }),
  );

  // everything else in the build (favicon, manifest…): revalidate each load
  app.use(express.static(webDist, { index: false, maxAge: 0 }));

  // SPA fallback
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(webDist, 'index.html'));
  });

  return true;
}
