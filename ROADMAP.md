# EzChatPulse — Roadmap

> Feature backlog, security work, parked ideas, and what's been shipped. Bug log
> lives in **[BUGS.md](BUGS.md)**.
> Legend: ✅ done · 🔜 next · 🟡 needs a decision · 💤 parked

## Security & reliability (all four get an admin-panel entry)

| # | Item | Notes | Admin panel | Status |
|---|------|-------|-------------|--------|
| S1 | Email verification | ✅ **DONE** — Resend with a verified sending subdomain (send-only key supplied via an env file outside the repo, mode 600): HMAC link bound to user+address (24h, idempotent), auto-sent on signup / email set, resend with 60s cooldown, JS-free `/verify` landing page; admin toggle blocks sending for unverified accounts | toggle "verified email to send", verified/pending counts, per-user **Verify**, resend | ✅ live |
| S2 | Basic captcha | ✅ **DONE** — self-hosted, no third-party: arithmetic question rendered as a jittered SVG, committed to an HMAC-signed token (5-min TTL, single-use via `captcha_used`, migration v5); required on registration and on login after N failures (in-memory per-username counters, 15-min window) | enable/disable, threshold (0–50), failure + solve counters | ✅ live |
| S3 | Backup + restore | ✅ **DONE** — WAL-safe online snapshots (db + uploads + manifest) tarred into `data/backups/`, automatic every `BACKUP_INTERVAL_HOURS` (24) keeping `BACKUP_KEEP` (5); restore = safety snapshot → atomic swap → restart | Backup now · list (size/date) · download · delete · restore (double-confirm) | ✅ live |
| S4 | Search = full-string match only | ✅ **DONE** — non-admins only match an account by FULL username or FULL display name (case-insensitive); admins keep substring search; LIKE wildcards escaped (`%`/`_` matched literally) | toggle strict search on/off (persisted in `app_settings`, admins keep fuzzy) | ✅ live |

## Active backlog (priority order)

> **Performance first (Nov 5, from a real HAR capture):** images dominate — three
> files were 1.7 MB of a 1.7 MB page, fetched fresh on *every* chat open because
> `/api/files` had no cache headers. Caching is fixed; these are the follow-ups
> that matter most, ahead of new features.

| # | Feature | Notes | Status |
|---|---------|-------|--------|
| 1 | Profile image + user info popup | click a chat header → user card (avatar, name, username, bio, common groups); avatar upload reuses the existing file infra. Friends asked for this in chat | 🔜 next |
| 2 | UI major overhaul | the interface reads as generic/AI-template: gradient-everywhere, glass blur, purple accents, emoji-as-icons, default type scale. Wanted: a real design identity — deliberate type scale + spacing system, one signature accent (not gradients on everything), consistent icon set, purposeful motion, better empty states, light/dark with real contrast tuning | 🔜 |
| 3 | Message search (FTS) | server-side full-text search over messages (SQLite FTS5); sidebar search also covers message content | 🟡 |
| 4 | GIF support "like Telegram" | GIF **search** needs a provider decision (Tenor/Giphy API key) + quick-send UI; sending GIFs as files already works | 🟡 needs decision |
| 5 | Per-user storage quota + file management | per-user space (upload cap exists), admin-editable quota, add/remove/replace files, distinct shared-file bubble, per-file public/private flag | 🟡 |
| 6 | Notifications (Web Push) | service worker + VAPID push for new messages when the tab is closed | 🟡 |
| 7 | Channels + bots | broadcast channels; bot API | 💤 |
| 8 | Android app | separate project; cheapest first step = PWA wrapper around the existing web client | 💤 |## Parked / concerns

| Item | Note |
|------|------|
| Email password reset | **unblocked** — transactional mail now works (Resend, verified domain, S1 tokens). Next step: reuse the verification-token pattern for a reset link + force-logout |
| Origin TLS | self-signed behind ArvanCloud "Full" mode; optional certbot-on-origin (~15 min), worth doing with the security round |
| Password change doesn't invalidate other sessions | stateless JWTs; acceptable for now (a token version column would fix it) |
| Dependency CVE watch | the Gitea CVE (Oct 2026) was learned from outside; a weekly `npm audit` + advisory check is not automated yet |
| Alerting | no notification when auth failures / exploit attempts spike; would pair with S2's counters |

## Shipped (feature rounds)

| Round | Date | What | Proof |
|-------|------|------|-------|
| 1 | Aug 7 | Message edit + delete (context menu, edited marker, delete-for-me/for-everyone, migration v2) | 55/55 tests, live-verified |
| 2 | Aug 9 | User settings (display name live fan-out, password change, logout) | 58/58, 9/9 live |
| 3 | Aug 9 | Admin panel (stats, users, password reset, registration kill-switch, migration v3) | 63/63, live |
| 4 | Aug 9 | Emoji panel (8 offline categories, cursor insert) | live |
| 5 | Aug 9 | Reply-to-message (quote + jump), email capture (one-time, private DTO, migration v4), soft-delete retention (hidden rows + admin purge) | 68/68, 12/12 live |
| 6 | Aug 15 | Delete confirmation, leave/delete group (member.left, last-member auto-delete, admin cascade + chat.deleted) | 71/71, 11/11 live |
| — | Sep 21 | CP-22 hardening: malformed requests → 400 (shared error handler), no log spam | 79/79 tests |
| 7 | Oct 29 | **Backups + restore** (S3): WAL-safe snapshots of db+uploads every 24h (keep 5), admin panel section (backup now / download / delete / restore), cold restore with pre-restore safety snapshot | 89/89 tests, 10/10 live incl. a real restore |
| 8 | Oct 29 | **Strict user search** (S4): non-admins only find accounts by full username/display name (case-insensitive) — closes user enumeration; admins keep substring search; LIKE wildcards escaped; admin-panel toggle | 94/94 tests, 11/11 live |
| 9 | Oct 29 | **Basic captcha** (S2): signed single-use arithmetic challenge as SVG; enforced on registration + after N failed logins; admin toggle, threshold, counters; migration v5 | 103/103 tests, 14/14 live browser |
| 10 | Oct 29 | **Email verification** (S1): Resend + verified domain, HMAC link (24h), auto-send on signup/email-set, resend cooldown, `/verify` page, admin require-verified toggle that gates sending, manual verify, counters; migration v6 | 111/111 tests, 12/12 live |
| 11 | Nov 5 | **Perf/Caching** (from a HAR capture): uploaded files are immutable (`private, max-age=31536000`, sha256 `ETag`, `304` on revalidation); hashed build assets cached a year (`immutable`); static serving extracted to `static.ts`; `index.html` always revalidates | 115/115 tests |
| 12 | Nov 5 | **Image thumbnails**: sharp generates a 512 px webp on upload (lazy for older files), served via `/api/files/:id?thumb=1` with its own ETag; bubbles use it, the lightbox keeps the original; non-image/SVG/GIF untouched; shared `fileDTO()`; bubbles no longer fire an unauthenticated 401 request. Backfill: 10 images, **~6.9 MB of payload removed** (1.07 MB PNG → 14 KiB) | 120/120 tests, live |
| 13 | Nov 5 | **Reconnect catch-up**: a second `ready` frame (socket came back) now re-fetches the chat list and the open chat, merging by id so scroll and pending sends survive — a dropped socket no longer leaves the pane silently stale | local browser: gap message appears once after reconnect |
| 14 | Nov 5 | **Client fetch hygiene**: in-flight file fetches are de-duplicated (N renders of one image = 1 request); history pages are tracked per chat so scrolling up/down no longer re-requests a page the client holds; every `/api` JSON response is `Cache-Control: no-store` (no more 304 round trips for live data), while file streaming still overrides it with `immutable` | 121/121 tests, local browser: 1 page request on open, 1 on first scroll-up, 0 on repeat |

## License

This project uses GPL-3.0 (LICENSE).
