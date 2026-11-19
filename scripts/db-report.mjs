#!/usr/bin/env node
/**
 * Database growth + shape report (metadata only — row counts and bytes, never
 * message content).
 *
 *   node scripts/db-report.mjs <path-to.sqlite> [--json]
 *
 * Reads with better-sqlite3 in readonly mode; works on a copy or a live WAL db.
 */
import { createRequire } from 'node:module';
import { statSync } from 'node:fs';

// allow running from anywhere (e.g. copied to a server): point at a project root
const ROOT = process.env.DB_PROJECT_ROOT ?? new URL('..', import.meta.url).pathname;
const require = createRequire(ROOT + 'package.json');
const Database = require('better-sqlite3');

const target = process.argv[2];
const asJson = process.argv.includes('--json');
if (!target) {
  console.error('usage: node scripts/db-report.mjs <path.sqlite> [--json]');
  process.exit(2);
}

const db = new Database(target, { readonly: true, fileMustExist: true });
const q = (sql, ...args) => db.prepare(sql).all(...args);
const one = (sql, ...args) => db.prepare(sql).get(...args);

const pageSize = one('PRAGMA page_size').page_size;
const pageCount = one('PRAGMA page_count').page_count;
const freeList = one('PRAGMA freelist_count').freelist_count;

// per-table / per-index bytes from the dbstat virtual table (if available)
let tables = [];
try {
  tables = q(
    `SELECT name, SUM(pgsize) AS bytes, COUNT(*) AS pages
       FROM dbstat GROUP BY name ORDER BY bytes DESC`,
  );
} catch {
  tables = [];
}

const counts = {};
for (const t of ['users', 'chats', 'chat_members', 'messages', 'files', 'read_state', 'schema_migrations']) {
  try {
    counts[t] = one(`SELECT COUNT(*) AS n FROM ${t}`).n;
  } catch {
    counts[t] = null;
  }
}

// growth signals: messages per day (bucketed by day, no content)
let perDay = [];
try {
  perDay = q(
    `SELECT date(created_at/1000, 'unixepoch') AS day, COUNT(*) AS n
       FROM messages GROUP BY day ORDER BY day DESC LIMIT 14`,
  );
} catch {}

// biggest conversations, by count only
let biggest = [];
try {
  biggest = q(
    `SELECT chat_id, COUNT(*) AS msgs FROM messages GROUP BY chat_id ORDER BY msgs DESC LIMIT 5`,
  );
} catch {}

// deleted-but-retained rows (soft delete keeps them on disk)
let softDeleted = null;
try {
  softDeleted = one('SELECT COUNT(*) AS n FROM messages WHERE deleted_at IS NOT NULL').n;
} catch {}

// index inventory for the hot tables
let indexes = [];
try {
  indexes = q(
    `SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND tbl_name IN
       ('messages','chat_members','read_state','chats','users','files') ORDER BY tbl_name, name`,
  );
} catch {}

let fileBytes = null;
try {
  fileBytes = statSync(target).size;
} catch {}

const report = {
  path: target,
  fileBytes,
  pageSize,
  pageCount,
  logicalBytes: pageSize * pageCount,
  freePages: freeList,
  freeBytes: freeList * pageSize,
  fragmentationPct: pageCount ? +((freeList / pageCount) * 100).toFixed(1) : 0,
  counts,
  softDeleted,
  tables,
  perDay,
  biggest,
  indexes,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const kb = (b) => (b == null ? '—' : `${(b / 1024).toFixed(1)} KB`);
  console.log(`database: ${target}`);
  console.log(`  file ${kb(fileBytes)} · logical ${kb(report.logicalBytes)} (${pageCount} × ${pageSize}B) · free ${kb(report.freeBytes)} (${report.fragmentationPct}% fragmented)`);
  console.log(`  rows: ` + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' '));
  console.log(`  soft-deleted messages still on disk: ${softDeleted ?? '—'}`);
  console.log('\n  bytes by object:');
  for (const t of tables.slice(0, 12)) {
    const pct = report.logicalBytes ? ((t.bytes / report.logicalBytes) * 100).toFixed(1) : '0';
    console.log(`    ${String(t.name).padEnd(28)} ${kb(t.bytes).padStart(10)}  ${pct.padStart(5)}%  (${t.pages} pages)`);
  }
  if (perDay.length) {
    console.log('\n  messages per day:');
    for (const d of perDay) console.log(`    ${d.day}  ${d.n}`);
  }
  if (biggest.length) {
    console.log('\n  busiest chats (by message count): ' + biggest.map((b) => `#${b.chat_id}:${b.msgs}`).join('  '));
  }
  console.log('\n  indexes: ' + indexes.map((i) => `${i.tbl_name}.${i.name}`).join(', '));
}
db.close();
