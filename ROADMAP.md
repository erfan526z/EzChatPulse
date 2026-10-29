# EzChatPulse — Roadmap

> Feature backlog, security work, parked ideas, and what's been shipped. Bug log
> lives in **[BUGS.md](BUGS.md)**.
> Legend: ✅ done · 🔜 next · 🟡 needs a decision · 💤 parked

## Security & reliability (all four get an admin-panel entry)

| # | Item | Notes | Admin panel | Status |
|---|------|-------|-------------|--------|
| S1 | Email verification | block bot account creation: require a verified email before an account can send messages; `email_verified` column already exists (migration v4), the capture flow is built — needs SMTP creds + a signed token link + resend | toggle "require verified email", unverified-account list, manual verify, resend | 🟡 needs SMTP |
| S2 | Basic captcha | very simple, **self-hosted** (no third-party, no tracking): server-signed math/hold-to-confirm challenge with a short TTL, applied to registration and to login after N failures | enable/disable, sensitivity (attempts before captcha), captcha-failure counter | 🔜 |
| S3 | Backup + restore | ✅ **DONE** — WAL-safe online snapshots (db + uploads + manifest) tarred into `data/backups/`, automatic every `BACKUP_INTERVAL_HOURS` (24) keeping `BACKUP_KEEP` (5); restore = safety snapshot → atomic swap → restart | Backup now · list (size/date) · download · delete · restore (double-confirm) | ✅ live |
| S4 | Search = full-string match only | ✅ **DONE** — non-admins only match an account by FULL username or FULL display name (case-insensitive); admins keep substring search; LIKE wildcards escaped (`%`/`_` matched literally) | toggle strict search on/off (persisted in `app_settings`, admins keep fuzzy) | ✅ live |

## Active backlog (features, priority order)

| # | Feature | Notes | Status |
|---|---------|-------|--------|
| 1 | Profile image + user info popup | click a chat header → user card (avatar, name, username); avatar upload reuses the existing file infra. Friends asked for this in chat (Aug 15) | 🔜 next |
| 2 | UI major overhaul | the interface reads as generic/AI-template: gradient-everywhere, glass blur, purple accents, emoji-as-icons, default type scale. Wanted: a real design identity — deliberate type scale + spacing system, one signature accent (not gradients on everything), consistent icon set, purposeful motion, better empty states, light/dark with real contrast tuning | 🔜 next |
| 3 | Reconnect catch-up | a WS broadcast missed while the socket is connecting never re-fetches (gap found live Aug 9); on reconnect, refetch chats + recent messages | 🔜 |
| 4 | Message search (FTS) | server-side full-text search over messages (SQLite FTS5); sidebar search also covers message content | 🟡 |
| 5 | GIF support "like Telegram" | GIF **search** needs a provider decision (Tenor/Giphy API key) + quick-send UI; sending GIFs as files already works | 🟡 needs decision |
| 6 | Per-user storage quota + file management | per-user space (upload cap exists), admin-editable quota, add/remove/replace files, distinct shared-file bubble, per-file public/private flag | 🟡 |
| 7 | Notifications (Web Push) | service worker + VAPID push for new messages when the tab is closed | 🟡 |
| 8 | Channels + bots | broadcast channels; bot API | 💤 |
| 9 | Server-side image thumbnails | downscale large uploads (sharp) instead of shipping originals to phones | 💤 |
| 10 | Android app | separate project; cheapest first step = PWA wrapper around the existing web client | 💤 |

## Parked / concerns

| Item | Note |
|------|------|
| Email password reset | blocked on SMTP; emails now exist (v4) + one-time capture in settings. Shares the SMTP dependency with S1 — build them together |
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

## License

This project uses GPL-3.0 (LICENSE).
