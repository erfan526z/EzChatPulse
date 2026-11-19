#!/usr/bin/env node
/**
 * Endpoint latency probe.
 *
 *   node scripts/perf-probe.mjs [--base https://localhost:8443] [--user probe] [--pass probepass123] [--n 30]
 *
 * Insecure TLS is allowed on purpose (the dev/scale stack uses a self-signed
 * certificate). Reports p50 / p95 / max per endpoint plus a rough "ops/sec".
 */
import https from 'node:https';
import http from 'node:http';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const BASE = arg('base', 'https://localhost:8443');
const USER = arg('user', 'probe');
const PASS = arg('pass', 'probepass123');
const N = Number(arg('n', 30));
const url = new URL(BASE);
const secure = url.protocol === 'https:';
const agent = secure ? new https.Agent({ rejectUnauthorized: false, keepAlive: true }) : undefined;

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const headers = {};
    if (payload) headers['content-type'] = 'application/json';
    if (payload) headers['content-length'] = String(payload.length);
    if (token) headers.authorization = `Bearer ${token}`;
    const started = process.hrtime.bigint();
    const lib = secure ? https : http;
    const req = lib.request(
      { hostname: url.hostname, port: url.port, path, method, headers, agent },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          const ms = Number(process.hrtime.bigint() - started) / 1e6;
          resolve({ status: res.statusCode, ms, bytes: Buffer.byteLength(data), body: data });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const pct = (arr, p) => {
  const sorted = [...arr].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
};

async function measure(label, fn) {
  const times = [];
  let bytes = 0;
  let status = 0;
  // one warm-up, so we do not measure cold caches on the first run
  await fn();
  for (let i = 0; i < N; i++) {
    const r = await fn();
    times.push(r.ms);
    bytes += r.bytes ?? 0;
    status = r.status ?? status;
  }
  const total = times.reduce((a, b) => a + b, 0);
  console.log(
    `${label.padEnd(34)} p50 ${pct(times, 50).toFixed(1).padStart(7)}ms  p95 ${pct(times, 95).toFixed(1).padStart(7)}ms  max ${Math.max(...times).toFixed(1).padStart(7)}ms  avg ${(total / times.length).toFixed(1).padStart(7)}ms  ${(bytes / times.length / 1024).toFixed(1).padStart(6)}KB  [${status}]`,
  );
  return { p50: pct(times, 50), p95: pct(times, 95), avg: total / times.length };
}

const login = await request('POST', '/api/login', { username: USER, password: PASS });
if (login.status !== 200) {
  console.error(`login failed: ${login.status} ${login.body.slice(0, 120)}`);
  process.exit(2);
}
const token = JSON.parse(login.body).token;
const chats = JSON.parse((await request('GET', '/api/chats', undefined, token)).body).chats;
const busiest = [...chats].sort((a, b) => (b.unread ?? 0) - (a.unread ?? 0))[0];

console.log(`probing ${BASE} as ${USER} · ${chats.length} chats · ${N} samples each\n`);

await measure('/api/health', () => request('GET', '/api/health'));
await measure('/api/chats (list, all chats)', () => request('GET', '/api/chats', undefined, token));
await measure('/api/chats/:id (detail)', () => request('GET', `/api/chats/${busiest.id}`, undefined, token));
await measure('/api/chats/:id/messages (page 1)', () =>
  request('GET', `/api/chats/${busiest.id}/messages`, undefined, token),
);
await measure('/api/chats/:id/messages (older page)', () => {
  const oldest = Math.min(...chats.map((c) => c.lastMessage?.id ?? Infinity));
  return request('GET', `/api/chats/${busiest.id}/messages?before=${oldest}`, undefined, token);
}).catch(() => {});
await measure('/api/me', () => request('GET', '/api/me', undefined, token));
await measure('/api/users?q=scale_1 (strict search)', () => request('GET', '/api/users?q=scale_1', undefined, token));
await measure('POST /api/chats/:id/read', () =>
  request('POST', `/api/chats/${busiest.id}/read`, { msgId: busiest.lastMessage?.id ?? 1 }, token),
);
