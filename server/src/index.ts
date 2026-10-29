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
import { handleConnection } from './ws/handler.js';
import { flushAll } from './presence.js';
import { startBackupSchedule } from './services/backup.js';

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
app.use('/api/admin', adminRoutes);

// Admin console (hidden from normal users; only admins can authenticate)
const adminPage = path.resolve(import.meta.dirname, '../admin-page.html');
app.get('/admin', (_req, res) => {
  res.sendFile(adminPage);
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
