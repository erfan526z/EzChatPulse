# EzChatPulse

A self-hosted, Telegram-style chat application: real-time messaging over WebSocket,
private + group chats, presence (online / last seen), persistent history, media
sharing, typing indicators, read receipts — served over TLS with a single Node
process, one SQLite file, and a dependency tree you can read in one sitting.

![CI](https://github.com/erfan526z/EzChatPulse/actions/workflows/ci.yml/badge.svg)

## Features

**Messaging**
- Real-time delivery over WebSocket (send → ack → fan-out, optimistic UI)
- Private chats & group chats (admin-managed membership, leave/delete group)
- Reply to a message (quoted block, click to jump), edit, delete for me / for everyone
- Emoji picker (8 offline categories, cursor-aware insert)
- Presence: online / last seen, live in the UI, multi-device safe
- Typing indicators (debounced) and read receipts (✓ sent / ✓✓ read)
- Persistent history with **keyset pagination** — pages stay O(50) even after 100k+ messages
- Media & file sharing (25 MB cap, content-addressed dedupe, member-gated access)

**Operations**
- Admin console: live stats, user management, password resets, registration kill-switch,
  soft-delete purging, and see below
- **Backups & restore**: WAL-safe snapshots on a schedule, download/restore from the panel
- Migrations applied automatically on boot (`schema_migrations`, currently v6)

**Security** (see [Security model](#security-model))
- Password hashing (bcrypt), JWT sessions, per-IP rate limits on auth, per-user limits on sends
- Self-hosted **captcha** on signup and after repeated failed logins
- Optional **email verification** gate before an account can send
- **Strict user search**: no account enumeration by partial name
- Malformed input answers `4xx` with a generic message, never a 500 or a stack trace

**Client**
- Dark, glassy, animated web UI — no framework, vanilla TypeScript + Vite,
  ~16 KB gzipped JS
- Works on phones (safe-area insets, `dvh`, floating compose, tap-vs-drag aware context menu)

## Quick start

```bash
# dev (hot reload)
npm install
./scripts/gen-cert.sh          # self-signed cert → certs/ (one-time)
npm run dev                    # server :8443 + vite dev :5173
# open http://localhost:5173 — the browser will warn about the self-signed
# cert on API calls; click through, or trust certs/cert.pem in your OS.

# production (single deployment)
npm run build
npm start                      # https://localhost:8443 serves the app + API + WS
```

The first account you register is a normal user; admins are defined by the
`ADMIN_USERNAMES` env var (comma-separated), so put your own username there and
restart to unlock `/admin`.

## Configuration

All via env vars (defaults in parentheses):

| Var | Default | Description |
|---|---|---|
| `PORT` | `8443` | HTTPS/WSS port |
| `HOST` | `0.0.0.0` | bind address |
| `DATA_DIR` | `../data` | SQLite db, uploads and backups live here |
| `DB_PATH` | `<DATA_DIR>/chatpulse.db` | database file |
| `JWT_SECRET` | auto-generated | persisted in `data/.jwt-secret` |
| `MAX_UPLOAD_BYTES` | `26214400` (25 MB) | upload cap |
| `AUTH_RATE_PER_MIN` | `10` | auth attempts per IP per minute |
| `ADMIN_USERNAMES` | *(empty)* | comma-separated usernames allowed into `/admin` |
| `REGISTRATION_OPEN` | `true` | initial value of the registration kill-switch |
| `BACKUP_INTERVAL_HOURS` | `24` | automatic backup cadence (`0` disables) |
| `BACKUP_KEEP` | `5` | how many backups to keep before pruning |
| `MAIL_ENABLED` | `1` | master switch for outbound email |
| `RESEND_API_KEY` | *(empty)* | Resend API key (send-only) for verification mail |
| `MAIL_FROM` | `EzChatPulse <noreply@example.com>` | sender address (must be on a domain verified with your mail provider) |
| `APP_URL` | `https://localhost:8443` | public origin used in email links |
| `CERT_PATH` / `KEY_PATH` | `certs/cert.pem`, `certs/key.pem` | TLS material |

## Security model

What the app does by default, and what it lets you turn on:

| Area | Behaviour |
|---|---|
| Passwords | bcrypt (cost 10); never logged, never in DTOs |
| Sessions | stateless JWT (`sub`, expiry); logout clears the client token |
| Brute force | per-IP limiter on `/api/login` + `/api/register`; captcha after N failures per username (default 3, 15-minute window) |
| Signup abuse | self-hosted captcha (signed single-use challenge, 5-minute TTL) on every registration |
| Account enumeration | user search answers **only** exact username / display-name matches for non-admins; admins keep substring search; `LIKE` wildcards are escaped |
| Email | optional; verification link is an HMAC token bound to user + address, 24 h TTL, single-purpose |
| Verified-only mode | admin toggle: unverified accounts can read but not send (`EMAIL_NOT_VERIFIED`) |
| Files | content-addressed, access checked against chat membership — no public URLs |
| Deletion | delete-for-everyone is a soft delete (row retained, hidden everywhere); admins can purge after N days |
| Errors | `AppError` → its status; malformed requests → `400` generic; unexpected → `500` generic, no stack traces |
| Backups | SQLite online-backup API (WAL-safe) + uploads, atomic restore with a pre-restore snapshot |

Not included (deliberate, see [ROADMAP.md](ROADMAP.md)): 2FA, password reset by
email, session revocation on password change, end-to-end encryption.

## Admin console

`GET /admin` — a single static page, only usable by a username in `ADMIN_USERNAMES`:

- **Stats**: users, chats, messages, files, retained deleted messages, DB size, uptime,
  live connections, captcha failures/solves, verified/pending email counts
- **Users**: list with online state and email status, reset password, **manually verify**
  an email (for people who cannot receive mail)
- **Switches**: registration on/off, captcha on/off + failure threshold, strict search on/off,
  "verified email required to send"
- **Maintenance**: purge soft-deleted rows older than N days
- **Backups**: backup now, list (size/date), download, delete, restore (double-confirm)

## Email verification (optional)

Verification mail goes out through [Resend](https://resend.com) over HTTPS — no SMTP.
Set `RESEND_API_KEY` (a **send-only** key), `MAIL_FROM` on a domain you have verified
with Resend, and `APP_URL` to your public origin. Without a key the app still runs:
registration just skips the greeting mail and `/api/me/verify-email` answers
"mail is not configured". Users can add or resend from **Settings → Email**, and the
composer shows a banner while the verified-only policy blocks them.

## Backups

Automatic: every `BACKUP_INTERVAL_HOURS` the server writes
`<DATA_DIR>/backups/backup-<ISO>.tar.gz` containing a consistent database snapshot,
the uploads directory and a manifest, then prunes to the newest `BACKUP_KEEP`.
A catch-up run also fires shortly after boot when the newest backup is stale.

Restore is deliberately cold and safe: a `-pre-restore` snapshot of the current state
is taken first, the database handle is closed, the file is replaced atomically, and
the process exits so the service manager restarts it on the restored data.

Manual recovery (fresh host):

```bash
tar -xzf backup-<ISO>.tar.gz -C /tmp/restore
systemctl stop <service>
cp /tmp/restore/chatpulse.db <DATA_DIR>/chatpulse.db
rm -f <DATA_DIR>/chatpulse.db-wal <DATA_DIR>/chatpulse.db-shm
cp -r /tmp/restore/uploads/* <DATA_DIR>/uploads/
systemctl start <service>
```

## Test & perf tooling

```bash
npm test                       # 111 integration tests (real HTTP + WS + in-memory DB)
SEED_USERS=20 SEED_MESSAGES=100000 npm run seed     # backfill fake history
LOAD_USERS=50 LOAD_MSGS=200 npm run loadtest        # 50 ws clients, 10k messages
npm run smoke                  # full auth flow against the live server
```

CI (`.github/workflows/ci.yml`) runs build + the full suite on every push and PR.

Measured on the development machine (Node 20, SQLite WAL):

| Metric | Result |
|---|---|
| Seed insert rate (100k msgs) | ~144,000 msg/s (DB ends at ~10 MB) |
| Load test: 50 users × 200 msgs | 10,000/10,000 acks, 0 errors |
| Throughput | ~4,500 msg/s |
| Ack latency p50 / p95 / p99 | 9 / 21 / 25 ms |
| History page (after 100k+ msgs) | ~2 ms |
| Server RSS under load | ~99 MB |

## Architecture

```
web/ (Vite SPA, vanilla TS) ── REST (auth/history/upload) ──┐
                             ── WSS (real-time events)   ──┤
                                                           ▼
server/ (Node + TS)  ┌─ ws/hub.ts        socket registry + fan-out (payload serialized once)
                     ├─ ws/handler.ts    auth handshake, msg.* dispatch, verification gate
                     ├─ services/        messages (keyset pagination), chats, files,
                     │                   captcha, verification, mailer, backup
                     ├─ presence.ts      online registry, debounced last_seen
                     └─ db.ts            better-sqlite3, WAL, schema_migrations (v1–v6)
                                           │
                                     data/chatpulse.db + data/uploads/ + data/backups/
```

Why it stays fast with years of history:
- Keyset pagination (`WHERE chat_id=? AND id<? LIMIT 50`) — never `OFFSET`
- Index `(chat_id, id DESC)`; append-only messages; unread = arithmetic diff
  of one `read_state` row per (chat, user) — no `COUNT(*)` scans
- WAL + `synchronous=NORMAL` + prepared statements (better-sqlite3)
- Hot paths (presence, typing, sockets) live in memory; DB touched only on
  persist / read / login

## Real-time protocol (WSS, JSON)

Client → server: `auth {token}`,
`msg.send {cid, tempId, kind, text?, fileId?, replyTo?}`,
`msg.edit {cid, msgId, text}`, `msg.delete {cid, msgId, mode: 'me'|'everyone'}`,
`read {cid, msgId}`, `typing {cid}`.

Server → client: `ready {userId}`, `msg.ack {tempId, msg}`, `msg.new {msg}`,
`msg.edited`, `msg.deleted`, `typing`, `read`, `presence {userId, online, lastSeenAt?}`,
`user.updated`, `chat.created`, `chat.member`, `chat.removed`, `member.left`,
`chat.deleted`, `error {code, message}`.

## Roadmap

See [ROADMAP.md](ROADMAP.md) — security work (shipped), the active feature backlog,
parked ideas, and the round-by-round history.

## License

GPL-3.0 — see [LICENSE](LICENSE).
