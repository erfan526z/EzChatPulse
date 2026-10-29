import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { config } from './config.js';
import { getDb } from './db.js';
import { errorHandler } from './error-handler.js';
import authRoutes from './api/auth_routes.js';
import userRoutes from './api/user_routes.js';
import chatRoutes from './api/chat_routes.js';
import fileRoutes from './api/file_routes.js';
import adminRoutes from './api/admin_routes.js';
import captchaRoutes from './api/captcha_routes.js';
import { handleConnection } from './ws/handler.js';
import { flushAll } from './presence.js';
import { startBackupSchedule } from './services/backup.js';
import { verifyEmailToken } from './services/verification.js';

const app = express();
app.use(express.json({ limit: '100kb' }));

// Health (no auth)
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// Routes
app.use('/api', authRoutes);
app.use('/api', chatRoutes);
app.use('/api', fileRoutes);
app.use('/api/users', userRoutes);
app.use('/api/captcha', captchaRoutes);
app.use('/api/admin', adminRoutes);

// Admin console (hidden from normal users; only admins can authenticate)
const adminPage = path.resolve(import.meta.dirname, '../admin-page.html');
app.get('/admin', (_req, res) => {
  res.sendFile(adminPage);
});

/**
 * Email verification landing page (S1). Email clients open this directly, so it
 * must work without JS and without a session — the signed token IS the credential.
 */
app.get('/verify', (req, res) => {
  const token = String(req.query.token ?? '');
  let ok = false;
  let message = 'This verification link is not valid.';
  try {
    const target = verifyEmailToken(getDb(), token);
    ok = true;
    message = `${target.email} is now confirmed. You can go back to the app.`;
  } catch (err) {
    message = err instanceof Error ? err.message : 'Verification failed.';
  }
  res.set('cache-control', 'no-store');
  res.status(ok ? 200 : 400).type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${ok ? 'Email verified' : 'Verification failed'} — EzChatPulse</title>
<style>
  :root { color-scheme: light dark }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#0f1115;
         font-family:system-ui,-apple-system,Segoe UI,sans-serif; color:#e7e9ee }
  .card { max-width:420px; padding:32px 28px; background:#171a21; border:1px solid #262b35;
          border-radius:16px; text-align:center }
  .badge { width:56px; height:56px; margin:0 auto 18px; border-radius:50%; display:grid;
           place-items:center; font-size:28px; background:${ok ? '#173b2b' : '#3b1a1a'};
           color:${ok ? '#4ade80' : '#f87171'} }
  h1 { font-size:19px; margin:0 0 10px }
  p { color:#9aa3b2; font-size:14px; line-height:1.55; margin:0 0 22px }
  a { display:inline-block; padding:11px 18px; border-radius:10px; background:#4f46e5;
      color:#fff; text-decoration:none; font-weight:600; font-size:14px }
</style></head>
<body><div class="card">
  <div class="badge">${ok ? '✓' : '!'}</div>
  <h1>${ok ? 'Email verified' : 'Could not verify'}</h1>
  <p>${message.replace(/[<>&]/g, '')}</p>
  <a href="${config.appUrl}">Open EzChatPulse</a>
</div></body></html>`);
});

// Serve the built web client (single deployment: `npm run build && npm start`)
const webDist = path.resolve(import.meta.dirname, '../../web/dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(webDist, 'index.html'));
  });
}

// Central error handler: AppError → its status, client faults → 400, else 500
app.use(errorHandler);

const server = https.createServer(
  {
    cert: fs.readFileSync(config.certPath),
    key: fs.readFileSync(config.keyPath),
  },
  app,
);

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws: WebSocket) => handleConnection(ws));

server.listen(config.port, config.host, () => {
  const db = getDb(); // open the database at startup so failures surface immediately
  console.log(`ezchatpulse server listening on https://${config.host}:${config.port}`);
  console.log(`  ws endpoint:   wss://localhost:${config.port}/ws`);
  console.log(`  health check:  https://localhost:${config.port}/api/health`);

  // Periodic backups (WAL-safe snapshots + uploads, pruned to BACKUP_KEEP)
  if (config.dbPath !== ':memory:') {
    startBackupSchedule(db, config.dataDir, config.backupIntervalHours, config.backupKeep);
    if (config.backupIntervalHours > 0) {
      console.log(`  backups:       every ${config.backupIntervalHours}h, keeping ${config.backupKeep} in data/backups/`);
    }
  }
});

// Graceful shutdown: flush pending last_seen writes
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  flushAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
});
