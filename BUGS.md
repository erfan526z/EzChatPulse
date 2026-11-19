# EzChatPulse — Bug Tracker

> Bug log only. Features/backlog live in **[ROADMAP.md](ROADMAP.md)**.
>
> **Status:** 🔴 open · 🟡 in progress · 🟢 fixed · ✅ verified · 💤 parked
>
> **Severity:** 🔥 critical (blocks use) · ⚠️ major (broken/wrong UX) · 🔸 minor (glitch) · ✨ polish

## Summary

| ID | Issue | Severity | Type | Status | Area |
|----|-------|----------|------|--------|------|
| CP-1 | Read receipts: second tick (✓✓) never appears | ⚠️ major | bug | ✅ verified | chat pane / presence |
| CP-2 | No auto-scroll when at the bottom of a chat | ⚠️ major | bug/ux | ✅ verified | chat pane |
| CP-3 | Persian (RTL) messages render LTR | 🔸 minor | feature | ✅ verified | bubbles |
| CP-4 | Esc should close the open chat | ✨ polish | suggestion | ✅ verified | keyboard |
| CP-5 | Hard to find how to start a new chat | 🔸 minor | ux feedback | ✅ verified | sidebar |
| CP-6 | Image pokes outside the bubble on phones | 🔸 minor | bug | ✅ verified | bubbles / css |
| CP-7 | Selected-chat highlight doesn't restore on chat switch | 🔸 minor | bug | ✅ verified | sidebar / css |
| CP-8 | Narrow screens split the pane when no chat is open | 🔸 minor | bug | ✅ verified | layout / css |
| CP-9 | History loads newest-first on a fresh device (top msg = 26th, bottom = 1st) | ⚠️ major | bug | ✅ verified | history load |
| CP-10 | Second tick (✓✓) missing during live chat (works after reload) | ⚠️ major | bug | ✅ verified | chat pane |
| CP-11 | Sidebar header cramped — user name truncated (design: search top, profile bottom, + menu) | 🔸 minor | ux | ✅ verified | sidebar |
| CP-12 | Persian filename uploaded as mojibake ('ØªÙ…') | 🔸 minor | bug | ✅ verified | uploads |
| CP-13 | On phone, profile + button slip under Firefox's bottom search bar | 🔸 minor | bug | ✅ verified | layout / mobile |
| CP-14 | Clearing the sidebar search does nothing (results stay stuck) | 🔸 minor | bug | ✅ verified | sidebar search |
| CP-15 | False unread: your own message shows as '1' after refresh | 🔸 minor | bug | ✅ verified | unread counts |
| CP-16 | Edit/delete buttons misplaced (off-screen on phone, horizontal scrollbar on desktop hover) | 🔸 minor | bug | ✅ verified | message actions |
| CP-17 | Delete-for-everyone leaves a WhatsApp-style tombstone — should vanish | 🔸 minor | bug | ✅ verified | message delete |
| CP-18 | Deleted message still shows its content in the chat-list preview | 🔸 minor | bug | ✅ verified | sidebar preview |
| CP-19 | 'edited' label unreadable on colorful bubbles (too dark) | 🔹 cosmetic | bug | ✅ verified | message meta |
| CP-20 | On phone, Enter sends instead of inserting a newline | 🔸 minor | bug | ✅ verified | composer / mobile |
| CP-21 | Group sender-name gradient spans the bubble width, not the name | 🔹 cosmetic | bug | ✅ verified | group bubbles |
| CP-22 | Malformed requests (scanner probes, bad JSON) return 500 + log spam | 🔸 minor | robustness | ✅ verified | error handling |
| CP-23 | Toasts were click-through (`#toast-root` had `pointer-events:none` with no re-enable), so the new actionable "Open settings" button could not be clicked | 🔸 minor | UI | ✅ verified | S1 UX round |
| CP-24 | **Profile card was invisible.** `.modal-overlay` starts at `opacity: 0` and only becomes visible with `.show`; the profile built its own overlay and never added it, so clicking a name underlined it and drew nothing. The card was in the DOM the whole time — which is exactly what the first verification checked, so it passed locally and shipped broken. Now rendered through the shared `openModal()` helper, and the check asserts real visibility (overlay opacity, box size, hit-test at the card's centre) instead of DOM presence | 🔺 serious | UI | ✅ verified | profiles round |
| CP-25 | **Profile picture looked missing.** The blob loaded fine, but the avatar element already carried an inline `background` shorthand (the initials gradient) which pins `background-size: auto` — and inline beats any class rule. Setting only `background-image` afterwards drew a 512 px photo at 1:1 anchored top-left inside a 36–84 px circle, so it read as "no picture". Now the whole shorthand is replaced (`url(...) center / cover no-repeat`); the check asserts computed `background-size` is `cover` and a screenshot of the real file is inspected | 🔸 minor | UI | ✅ verified | profiles round |

**29/31 closed** (CP-26, CP-28 open). The next CP number to use: **CP-38**.

### Reported by the user (Nov 2026, phone note — transcribed in
`chatpulse-stuff/notes/user-bug-list-01.md`)

| ID | Issue | Severity | Type | Status | Area |
|----|-------|----------|------|--------|------|
| CP-26 | Emoji set incomplete — picker ships a small curated set, not the full Unicode set | 🔸 minor | bug | 🔴 open | composer / emoji |
| CP-27 | Admin panel's DB size does not report the same thing as the backup size (`.db` file vs VACUUM'd snapshot vs WAL) | 🔸 minor | bug | ✅ verified | admin panel / backups |
| CP-28 | "Feels a bit slow already" — sync better-sqlite3 on one thread, no cache layer (see ROADMAP async DB item) | ⚠️ major | perf | 🔴 open | server |
| CP-29 | Group chat header UX — header is a name + count, not a place; needs a group info screen | ⚠️ major | ux | ✅ fixed | group header |
| CP-30 | Profile pictures don't update for other clients until a full reload | ⚠️ major | bug | ✅ verified | profile / realtime |
| CP-31 | Captcha sometimes cannot be solved (unreadable render? 5-min expiry? strict answer match?) | ⚠️ major | bug | ✅ verified | auth / captcha |

**CP-27** `b5be80c`: stats now separate in-use / on-disk (incl. WAL) / archive sizes.
**CP-30** `a34c610`: the broadcast was fine — `store.setUser` dropped `avatarUrl` and the sidebar's render key ignored name/avatar, so rows never repainted. Two-session test, 10/10.
**CP-31** `5699211`: three separate causes — Persian/Arabic digits failed an exact-match (`۰-۹`/`٠-٩` now folded), glyph jitter made some questions unreadable (±16° → ±9°, darker ink), and at card width the answer input collapsed to ~60 px with the ↻ button clipped (captcha block now stacks). Still open in spirit: nobody has confirmed your friend's *specific* failure on their device.

## Open issues

None right now. When reporting, copy this block:

```
- **ID:** CP-XX
- **Reported:** <date> · **Severity:** <🔥/⚠️/🔸/✨> · **Type:** bug/ux/suggestion
- **Symptom:**
- **Steps to reproduce:**
- **Expected:**
- **Device/browser:**
```

## Fix-round history

| Round | Date | Scope | Result |
|-------|------|-------|--------|
| Fix round 1 | Aug 2 | CP-1..CP-9 root causes in one pass (scroll double-reversal, readBy in DTO, RTL, Esc, new-chat affordance, image bounds, active-chat key, empty-state flex) | 9/9 ✅ |
| Fix round 2 | Aug 4 | CP-10 live ticks (store-key lookup), CP-11 sidebar redesign (search top / profile bottom / + menu), CP-12 UTF-8 filenames | 3/3 ✅ (`900ff75`) |
| Fix round 3 | Aug 5 | CP-13 mobile dvh + safe-area, FAB float (CP-11 polish), CP-14 search-clear rebuild | 3/3 ✅ (`d49f0a7`) |
| CP-15 | Aug 7 | False unread from own sends (unread SQL excludes viewer) | ✅ (`56a1901`) |
| UX round | Aug 9 | CP-16 context menu (right-click/tap, drag-safe), CP-17 no tombstone, CP-18 preview rollback, CP-19 edited-label contrast | 4/4 ✅ (`08a1f1e`) |
| Friends round | Aug 9 | CP-20 mobile newline (coarse-pointer Enter), CP-21 sender-name gradient width | 2/2 ✅ (`b8f9b7a`) |
| Sweep | Aug 15 | CP-6/CP-8/CP-13 🟢-fixed items verified live in a 390×844 mobile viewport → ✅ (CP-13 real-Firefox retest still welcome) | 3/3 ✅ |
| Probe hardening | Sep 21 | CP-22 — malformed paths (internet scanners) and malformed JSON bodies returned 500 and spammed the journal; error handler extracted to a shared module and now maps client faults to 400 (no log noise, no stack leak) | ✅ (`server/src/error-handler.ts`, 8 tests) |

Feature rounds (edit/delete, settings, admin, emoji, reply/email/soft-delete, confirmation + groups) are logged in ROADMAP.md.

## Workflow

1. Fix → mark `🟢 fixed` (reference the commit).
2. Deploy → test live → mark `✅ verified` (note who/what tested).
3. Suggestions get a decision: adopt → task; park → `💤` with reason.
4. When the project moves to a public repo, migrate open entries to real issues; this file stays as the changelog reference.

Full per-issue writeups from earlier rounds are preserved in git history (this file was slimmed Aug 15).

## CP-32 — five defects found reviewing the ported UI on desktop · FIXED (not deployed)

Found from a review pass on the real client at 1920×1000 (not the lab). All fixed
and verified at that viewport; none deployed yet.

| # | Symptom | Cause | Fix |
|---|---------|-------|-----|
| 1 | Dialog text fields were raw browser default (white, square) | the new stylesheet only styled settings fields; the group/new-chat dialogs build bare `input`s | shared dialog-field styles (bg, border, radius, focus ring) |
| 2 | "No chat selected" page lost: the list stretched across the window | the one-column rule for a hidden chat pane was not gated behind the phone breakpoint | collapse only ≤820 px; wide screens keep two columns and the empty state |
| 3 | Profile card did not match the lab; common groups had no avatar | card kept the old left-aligned head and text-only rows | centred head, value-over-label field groups, group rows with avatar + chevron |
| 4 | Settings: Log out floated at the bottom, Email split across two cards | layout artefacts of the first pass | Log out is an account row in its own card; Email label/input/status in one card |
| 5 | Settings nav highlighted "Account" while the page was at the top | `markActive()` measured before layout (every section at 0) and treated any short page as "at the bottom" | deferred one frame; "bottom" only when the panel actually overflows |

Also: Escape now closes any dialog opened through `openModal()` — the drawer,
settings and profile already worked that way, the modals did not.

## CP-35 — typography did not match the lab · FIXED (not deployed)

Measured every text element in the lab against the app at the same viewport
(computed size / weight / letter-spacing / line-height) and aligned the
mismatches. The letterforms were never the problem — the stack resolves to the
same face in both. The differences were values I had invented:

| element | lab | app before | now |
|---|---|---|---|
| Settings title | 16px w600 | 18px w700 | 16px w600 |
| Chat list title | 16px w600 | 18px w700, ls -0.01em | 16px w600 |
| settings row label | w400 | w500 | w400 |
| settings row sub | lh 1.35 | lh 1.45 | 1.35 |
| profile presence | text-3 (muted) | accent green | muted |
| profile field value / label | 15px / 12px | 14px / 11px | 15 / 12 |
| drawer name / handle | 18px w700 / 13px | 16px w600 / 12px | 18 w700 / 13 |
| FAB | 3.5rem, 24px icon | 3.25rem, 22px glyph | 3.5rem, 20px glyph |

Also removed the invented "Follows this device" sub-line under Theme, so the
first card matches the lab's height exactly.

### Deployed 2026-11-13 22:56

CP-32, CP-33, CP-34 and CP-35 shipped together with the UI overhaul (round 16).

- rollback snapshot `/opt/chatpulse-rollback-20261113-2221.tgz` (144 MB)
- pre-deploy DB copy `/opt/chatpulse/data/backups/pre-deploy-20261113-2222.sqlite`
- migration **v10** applied on boot; `users.accent` present
- data intact afterwards: 15 users · 21 chats · 370 messages (counts only, no content read)
- live bundle `index-CMm6CnYP.js` / `index-CqtrFf2Y.css`
- live tokens verified in the browser: `--accent` #34d399, `--r-bubble` .625rem, root 15px at 1280 / 16px at 390, no JS errors

### Redeployed 2026-11-13 23:06 (profile editor)

`68b2849` (unwinding editor) + `2e7b2dd` (flat treatment) + `6fc8f2a` (docs).

- rollback snapshot `/opt/chatpulse-rollback-20261113-2306.tgz` (138 MB)
- live bundle `index-BkpxxDQY.js` / `index-B2vM57Ow.css`
- editor styles confirmed in the served CSS; no JS errors at 1280 / 390

## CP-36 — a long filename gave the thread a horizontal scroller · FIXED

**Reported:** "If a filename is long, the phone will have horizontal scroll."

**Cause:** the bubble was capped at a fixed `26rem` (416 px), which is wider than
a 390 px phone. A file name is `nowrap`, so its intrinsic width sized the bubble,
the row could not shrink below that content, and `#messages` (a scroll container
in both axes) gained a horizontal scrollbar. Measured: bubble **416 px** inside a
390 px viewport.

**Fix:** cap against the viewport — `max-width: min(var(--bubble-max), 78vw)` —
and let the row and the file row shrink (`min-width: 0`), so the name ellipsises
instead of forcing width. Verified: bubble 304 px, thread `scrollWidth ===
clientWidth === 390`, name truncates with an ellipsis.

## CP-37 — picture bubbles looked uneven · FIXED

**Reported:** "pictures sent and the bubble for them is not very neat (stretches as
sender, the borders inconsistent)."

**Two causes:**
1. the image used `max-width: min(15rem, 100%)`. The percentage resolves against
   an indefinite box during intrinsic sizing, so the bubble was sized from the
   picture's *original* width (1600 px) and then capped: a **366 px bubble around
   a 240 px picture** — 126 px of dead space, and the clock pill stretched to the
   full picture height because the base rule's `top: 1px` survived
   `position: absolute` (top + bottom on an auto-height box).
2. media bubbles kept the text bubble's asymmetric padding (6 px top / 11 px
   sides), so the frame around a picture was visibly uneven.

**Fix:** length-only caps on the image (`max-width: 15rem`, `max-height: 22rem`,
`height: auto`) so the bubble shrink-wraps the rendered picture; one uniform
`--media-pad: 3px` frame with the picture's radius nested to match; `top: auto` on
the overlaid clock pill; pictures narrower than their caption are centred.
Verified: 240 px picture in a 246 px bubble (3 px frame each side), pill 70×14,
no overflow at 390 or 1280.

### Redeployed 2026-11-13 23:21 (CP-36, CP-37)

- rollback snapshot `/opt/chatpulse-rollback-20261113-2321.tgz`
- live bundle `index-hN9HdrGf.js` / `index-Br5avP8D.css`
- media/overflow rules confirmed in the served CSS; no JS errors at 1280 / 390

## CP-29 — the chat header is the way into the chat's info · FIXED

**Reported:** in Telegram the whole top block — picture, name, member/online line —
opens the info page, in private chats and groups alike. Here only the text opened
the person card in private chats, and groups had a 👥 button that read as a dead end.

**Fixed:** the identity block (picture + name + presence) is one button:

- private chat → the existing person card (picture, bio, common groups)
- group → the new **group info page**: large picture, name, "N members · M online",
  description, member list with an admin badge and per-row remove, add member,
  leave / delete
- the 👥 members button is gone; the back chevron and Escape still close

Description editing came with it (roadmap 8): `chats.description` (migration v11),
`PATCH /api/chats/:id` admin-only, trimmed, capped at 255, broadcast as
`chat.updated` so every member's client patches in place without a refetch.

Verified 16/16 in the browser (both chat types, phone + desktop, description
round-trip to the server, add-member panel), 132/132 tests.

### Deployed 2026-11-19 13:33

- snapshot `/opt/chatpulse-rollback-20261119-1333.tgz` · DB `pre-deploy-20261119-1333.sqlite`
- migrations **11** (description) and **12** (activity index) applied; data intact
  (16 users · 22 chats · 392 messages, counts only)
- bundles `index-Dc_5NFhO.js` / `index-JSBhGOON.css`; no JS errors at 390 or 1280
