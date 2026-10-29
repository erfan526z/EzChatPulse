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

**23/23 closed.** The next CP number to use: **CP-24**.

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
