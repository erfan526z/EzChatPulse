/**
 * UI regression checks against a running dev stack (:5173 + :8443).
 *
 *   npm run ui:check            # or: node scripts/ui-check.mjs
 *
 * These assert the invariants that are easy to break silently: the design
 * tokens, the bubble chain geometry, the layout ladder, and the three screens
 * that open from the chat (profile, group info, settings). They are deliberately
 * DOM-measured (computed styles, bounding boxes, hit tests) rather than
 * markup-string checks — CP-24 was invisible in the DOM and only showed up when
 * geometry was asserted.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const require = createRequire(ROOT + 'package.json');

const PLAYWRIGHT = process.env.PLAYWRIGHT_CORE ?? '/home/erfan/.hermes/hermes-agent/apps/desktop/node_modules/playwright-core';
const CHROME = process.env.CHROME_PATH ?? '/home/erfan/.cache/ms-playwright/chromium-1208/chrome-linux/chrome';
const BASE = process.env.UI_BASE ?? 'http://localhost:5173';
const USER = process.env.UI_USER ?? 'demo';
const PASS = process.env.UI_PASS ?? 'demopass123';

if (!existsSync(CHROME)) {
  console.error(`Chromium not found at ${CHROME} (set CHROME_PATH)`);
  process.exit(2);
}

const { chromium } = require(PLAYWRIGHT);

let pass = 0;
const failures = [];
function check(label, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ok   ${label}${detail ? ' — ' + detail : ''}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`);
  }
}

const auth = await (await fetch(`${BASE}/api/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: USER, password: PASS }),
})).json();
if (!auth.token) {
  console.error(`login failed for ${USER} — is the dev stack up and seeded? (scripts/dev-ui.sh)`);
  process.exit(2);
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-proxy-server'] });

async function session(width, height) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((t) => localStorage.setItem('chatpulse.token', t), auth.token);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.chat-item', { timeout: 20000 });
  return { ctx, page, errors };
}

const openChat = async (page, name) => {
  await page.locator('.chat-item').filter({ hasText: name }).first().click();
  await page.waitForSelector('.msg-row', { timeout: 15000 });
  await page.waitForTimeout(600);
};

// ── tokens + layout ladder ───────────────────────────────────────────────
{
  const { ctx, page, errors } = await session(1280, 800);
  const t = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return {
      accent: cs.getPropertyValue('--accent').trim(),
      radius: cs.getPropertyValue('--r-bubble').trim(),
      root: parseFloat(cs.fontSize),
      cols: getComputedStyle(document.querySelector('#main-view')).gridTemplateColumns.split(' ').length,
    };
  });
  check('accent token resolves', /^#[0-9a-f]{6}$/i.test(t.accent) || t.accent.startsWith('grad'), t.accent);
  check('bubble radius token is 10px', t.radius === '0.625rem', t.radius);
  check('desktop root scale is 15px', t.root === 15, String(t.root));
  check('desktop shows two columns', t.cols === 2, `${t.cols} tracks`);
  check('no JS errors (desktop)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

{
  const { ctx, page } = await session(390, 844);
  const t = await page.evaluate(() => ({
    root: parseFloat(getComputedStyle(document.documentElement).fontSize),
    cols: getComputedStyle(document.querySelector('#main-view')).gridTemplateColumns.split(' ').length,
  }));
  check('phone root scale is 16px', Math.abs(t.root - 16) < 0.1, String(t.root));
  check('phone is a single column', t.cols === 1, `${t.cols} tracks`);
  await ctx.close();
}

// ── bubble chain geometry ────────────────────────────────────────────────
{
  const { ctx, page, errors } = await session(390, 844);
  await openChat(page, 'Jack');
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('.msg-row')].map((r) => {
      const b = r.querySelector('.msg-bubble');
      const cs = getComputedStyle(b);
      const after = getComputedStyle(b, '::after');
      // the WALL side is left for incoming, right for outgoing — that is where
      // the tail attaches, so measure that corner rather than a fixed one
      const wall = r.dataset.side === 'in' ? 'borderBottomLeftRadius' : 'borderBottomRightRadius';
      const wallTop = r.dataset.side === 'in' ? 'borderTopLeftRadius' : 'borderTopRightRadius';
      return {
        run: r.dataset.run,
        side: r.dataset.side,
        top: parseFloat(cs[wallTop]),
        bottom: parseFloat(cs[wall]),
        tail: after.content !== 'none',
      };
    }),
  );
  check('every message carries a run marker', rows.length > 0 && rows.every((r) => Boolean(r.run)), `${rows.length} rows`);
  const first = rows.find((r) => r.run === 'first');
  const last = rows.find((r) => r.run === 'last');
  if (first) check('first of a run: rounded top, no tail', first.top > 8 && !first.tail, JSON.stringify(first));
  if (last) check('last of a run: square tail corner, hook drawn', last.bottom < 1 && last.tail, JSON.stringify(last));
  const thread = await page.evaluate(() => {
    const t = document.querySelector('#messages');
    return { scroll: t.scrollWidth, client: t.clientWidth };
  });
  check('thread has no horizontal overflow', thread.scroll === thread.client, `${thread.scroll}/${thread.client}`);
  check('no JS errors (thread)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ── header opens the right screen in both chat types ─────────────────────
{
  const { ctx, page, errors } = await session(390, 844);

  await openChat(page, 'Jack');
  const privateTitle = await page.evaluate(() => document.querySelector('.chat-header-main')?.title);
  await page.click('.chat-header-main');
  await page.waitForTimeout(600);
  check('private header opens the profile', Boolean(await page.evaluate(() => document.querySelector('.profile-card'))), privateTitle);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  await page.click('#chat-header .back-btn');
  await page.waitForTimeout(500);
  await openChat(page, 'Our Group');
  const groupTitle = await page.evaluate(() => document.querySelector('.chat-header-main')?.title);
  await page.click('.chat-header-main');
  await page.waitForTimeout(700);
  const info = await page.evaluate(() => {
    const s = document.querySelector('.chat-info');
    if (!s) return null;
    return {
      name: s.querySelector('.ci-name')?.textContent,
      sub: s.querySelector('.ci-sub')?.textContent,
      members: s.querySelectorAll('.ci-member').length,
      desc: Boolean(s.querySelector('.ci-desc-text, .ci-desc-empty')),
      actions: s.querySelectorAll('.ci-actions button, .ci-danger .label').length,
    };
  });
  check('group header opens group info', Boolean(info) && info.members > 0, `${groupTitle} · ${info?.members} members`);
  check('info page shows name and count', Boolean(info?.name) && /member/.test(info?.sub ?? ''), `${info?.name} · ${info?.sub}`);
  check('info page has description + actions', Boolean(info?.desc) && (info?.actions ?? 0) >= 3);
  check('no JS errors (info page)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}


// ── emoji: broad set + recents ──────────────────────────────────────────
{
  const { ctx, page, errors } = await session(390, 844);
  await openChat(page, 'Jack');
  await page.click('#emoji-btn');
  await page.waitForTimeout(400);
  const panel = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.emoji-cat-btn')];
    return {
      open: !document.querySelector('.emoji-panel')?.classList.contains('hidden'),
      tabs: tabs.length,
      cells: document.querySelectorAll('.emoji-cell').length,
      titles: tabs.map((t) => t.title),
    };
  });
  check('emoji panel opens with a recents tab', panel.open && panel.titles[0] === 'Recently used', panel.titles.join(', '));
  check('emoji set is broad', panel.tabs >= 10 && panel.cells >= 80, `${panel.tabs} categories, ${panel.cells} cells in the active one`);

  // pick one, reopen: it should now be first in recents
  const first = await page.evaluate(() => document.querySelector('.emoji-cell')?.textContent ?? '');
  await page.click('.emoji-cell');
  await page.waitForTimeout(200);
  const typed = await page.evaluate(() => document.querySelector('#composer textarea')?.value ?? '');
  check('clicking an emoji inserts it at the cursor', typed.includes(first), JSON.stringify(typed.slice(0, 12)));

  await page.click('#emoji-btn');
  await page.waitForTimeout(300);
  const recents = await page.evaluate(() => {
    document.querySelector('.emoji-cat-btn[title="Recently used"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return [...document.querySelectorAll('.emoji-cell')].map((c) => c.textContent).slice(0, 3);
  });
  check('a used emoji appears in recents', recents.includes(first), JSON.stringify(recents));
  check('no JS errors (emoji)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ── hardware back walks back through the app, not out of it ──────────────
{
  const { ctx, page, errors } = await session(390, 844);
  const shown = (sel) =>
    page.evaluate((s) => {
      const el = document.querySelector(s);
      return Boolean(el && el.getBoundingClientRect().width > 0);
    }, sel);
  const goBack = async () => {
    await page.evaluate(() => history.back());
    await page.waitForTimeout(600);
  };

  await openChat(page, 'Jack');
  check('phone: the conversation replaces the list', await shown('#chat-header'));
  await goBack();
  check(
    'back closes the conversation and stays in the app',
    !(await shown('#chat-header')) && (await shown('#sidebar')),
    `app alive: ${await page.evaluate(() => Boolean(document.querySelector('#main-view')?.offsetParent))}`,
  );

  await page.click('#btn-drawer');
  await page.waitForTimeout(500);
  check('drawer opens', await shown('.drawer'));
  await goBack();
  check('back closes the drawer', !(await shown('.drawer')) && (await shown('#sidebar')));

  await page.click('#btn-me');
  await page.waitForTimeout(600);
  check('settings opens', await shown('.settings-screen'));
  await goBack();
  check('back closes settings', !(await shown('.settings-screen')) && (await shown('#sidebar')));

  // a modal sits on top of a chat: back must close the modal first, then the chat
  await openChat(page, 'Jack');
  await page.click('.chat-header-main');
  await page.waitForTimeout(600);
  const modalUp = await shown('#modal-root .modal-overlay');
  await goBack();
  const modalGone = !(await shown('#modal-root .modal-overlay'));
  check('back closes the profile modal first', modalUp && modalGone && (await shown('#chat-header')));
  await goBack();
  check('and then the conversation', !(await shown('#chat-header')) && (await shown('#sidebar')));

  check('no JS errors (back stack)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

// ── settings: accent + theme + profile editor ────────────────────────────
{
  const { ctx, page, errors } = await session(390, 844);
  await page.click('#btn-me');
  await page.waitForTimeout(700);

  const swatches = await page.evaluate(() => document.querySelectorAll('.set-swatch').length);
  check('appearance offers the accent palette', swatches >= 5, `${swatches} swatches`);

  // pick a swatch that is NOT the current one, so the check is repeatable
  const target = await page.evaluate(() => {
    const active = document.querySelector('.set-swatch.on')?.dataset.accent;
    const other = [...document.querySelectorAll('.set-swatch')].find((b) => b.dataset.accent !== active);
    return other?.dataset.accent ?? null;
  });
  const before = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
  await page.click(`.set-swatch[data-accent="${target}"]`);
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => ({
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    on: document.querySelector('.set-swatch.on')?.dataset.accent,
  }));
  check('picking an accent applies it', after.on === target && after.accent !== before, `${before} → ${after.accent} (${target})`);

  await page.click('.set-chip:has-text("Light")');
  await page.waitForTimeout(300);
  check('light theme toggles', await page.evaluate(() => document.documentElement.dataset.theme === 'light'));
  await page.click('.set-chip:has-text("Dark")');
  await page.waitForTimeout(300);

  const closed = await page.evaluate(() => {
    const editor = document.querySelector('.profile-editor');
    return { h: Math.round(editor.getBoundingClientRect().height), label: document.querySelector('.set-profile .set-link')?.textContent };
  });
  await page.click('.set-profile .set-row-side');
  await page.waitForTimeout(600);
  const open = await page.evaluate(() => {
    const editor = document.querySelector('.profile-editor');
    return {
      h: Math.round(editor.getBoundingClientRect().height),
      label: document.querySelector('.set-profile .set-link')?.textContent,
      rows: document.querySelectorAll('.pe-row').length,
      avatar: Math.round(document.querySelector('.set-profile .avatar').getBoundingClientRect().width),
      applies: [...document.querySelectorAll('.pe-apply')].map((b) => b.disabled),
    };
  });
  check('profile editor is closed by default', closed.h === 0 && closed.label === 'Edit', JSON.stringify(closed));
  check('Edit unwinds two rows and grows the picture', open.h > 150 && open.rows === 2 && open.avatar > 70, JSON.stringify({ h: open.h, avatar: open.avatar }));
  check('Apply starts disabled in both rows', open.applies.every(Boolean), JSON.stringify(open.applies));
  check('no JS errors (settings)', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

await browser.close();
console.log(`\n${pass}/${pass + failures.length} UI checks passed`);
if (failures.length) {
  console.log('failed: ' + failures.join(' | '));
  process.exit(1);
}
