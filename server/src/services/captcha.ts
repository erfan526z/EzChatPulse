import crypto from 'node:crypto';
import type { Db } from '../db.js';
import { config } from '../config.js';
import { BadRequest } from '../errors.js';

/**
 * Basic, self-hosted captcha — no third-party service, no tracking, no images
 * to fetch: a tiny arithmetic question rendered as a jittered SVG, committed to
 * a signed token.
 *
 * How the token works (stateless):
 *   token = v1.<expEpoch>.<nonce>.<hmac(exp.nonce.answer)>
 * The server never stores the answer; at verification time it recomputes the
 * HMAC over the SUBMITTED answer and compares (timing-safe). A correct answer
 * therefore reproduces the signature; a wrong one cannot. Tokens are:
 *   - short-lived (5 min),
 *   - single-use (hash recorded in `captcha_used`, migration v5),
 *   - tamper-evident (any field change breaks the HMAC).
 *
 * This is deliberately simple: it stops scripted/dumb signup floods, not a
 * determined human-in-the-loop attacker.
 */

const TTL_SEC = 300;
const CLEANUP_MS = 3_600_000;

export interface CaptchaChallenge {
  token: string;
  svg: string;
  expiresInSec: number;
}

/** Session-scoped counters surfaced in the admin stats. */
const counters = { failures: 0, issued: 0, solved: 0 };

export function captchaCounters(): { failures: number; issued: number; solved: number } {
  return { ...counters };
}

function sign(input: string): string {
  return crypto.createHmac('sha256', config.jwtSecret).update(input).digest('base64url');
}

function normalizeAnswer(answer: unknown): string {
  return String(answer ?? '')
    .trim()
    .replace(/[\s,]/g, '');
}

function newQuestion(): { text: string; answer: number } {
  const a = 2 + crypto.randomInt(8); // 2..9
  const b = 2 + crypto.randomInt(8);
  if (crypto.randomInt(2) === 0) return { text: `${a} + ${b}`, answer: a + b };
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return { text: `${hi} \u2212 ${lo}`, answer: hi - lo };
}

/** Cosmetic jitter (not security-relevant) — inclusive range, negatives allowed. */
function jitter(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Render the question as an SVG with per-character jitter, rotation and noise. */
function renderSvg(text: string): string {
  const width = 190;
  const height = 54;
  const parts: string[] = [];
  let x = 16;
  for (const ch of text) {
    const rot = jitter(-16, 16);
    const dy = jitter(-4, 4);
    const size = 22 + jitter(0, 3);
    parts.push(
      `<text x="${x}" y="${32 + dy}" font-size="${size}" font-family="ui-monospace,monospace" ` +
        `fill="#2b2f36" transform="rotate(${rot} ${x + 6} ${30 + dy})">${ch === ' ' ? '&nbsp;' : ch.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`,
    );
    x += ch === ' ' ? 9 : 15 + crypto.randomInt(4);
  }
  // a couple of noise strokes + dots so it is not trivially OCR-able
  const noise: string[] = [];
  for (let i = 0; i < 3; i++) {
    const y1 = crypto.randomInt(6, height - 6);
    const y2 = crypto.randomInt(6, height - 6);
    noise.push(
      `<path d="M0 ${y1} Q ${crypto.randomInt(40, 80)} ${crypto.randomInt(0, height)} ${width} ${y2}" ` +
        `stroke="#c9ced6" stroke-width="1" fill="none" opacity="0.75"/>`,
    );
  }
  for (let i = 0; i < 12; i++) {
    noise.push(`<circle cx="${crypto.randomInt(width)}" cy="${crypto.randomInt(height)}" r="1" fill="#d5dae1"/>`);
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" ` +
    `role="img" aria-label="captcha">` +
    `<rect width="${width}" height="${height}" rx="8" fill="#f4f6f8"/>` +
    noise.join('') +
    parts.join('') +
    `</svg>`
  );
}

/** Mint a fresh challenge (question + signed token). */
export function createChallenge(): CaptchaChallenge {
  counters.issued += 1;
  const { text, answer } = newQuestion();
  const exp = Math.floor(Date.now() / 1000) + TTL_SEC;
  const nonce = crypto.randomBytes(9).toString('base64url');
  const token = `v1.${exp}.${nonce}.${sign(`${exp}.${nonce}.${answer}`)}`;
  return { token, svg: renderSvg(text), expiresInSec: TTL_SEC };
}

/**
 * Verify a submitted answer. Throws BadRequest (→ 400) on anything wrong:
 * malformed/tampered token, expired challenge, wrong answer, replayed token.
 */
export function verifyChallenge(db: Db, token: unknown, answer: unknown): void {
  const raw = typeof token === 'string' ? token : '';
  const parts = raw.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new BadRequest('Captcha challenge is invalid — please retry');
  }
  const [, expStr, nonce, signature] = parts;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp <= 0) {
    throw new BadRequest('Captcha challenge is invalid — please retry');
  }
  if (Math.floor(Date.now() / 1000) > exp) {
    throw new BadRequest('Captcha expired — please solve the new one');
  }

  const expected = sign(`${exp}.${nonce}.${normalizeAnswer(answer)}`);
  const got = Buffer.from(String(signature ?? ''));
  const want = Buffer.from(expected);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
    counters.failures += 1;
    throw new BadRequest('Captcha answer is incorrect');
  }

  // single use: a solved token cannot be replayed for another registration/login
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const used = db.prepare('SELECT 1 AS x FROM captcha_used WHERE token_hash = ?').get(hash);
  if (used) throw new BadRequest('This captcha was already used — please solve the new one');
  db.prepare('INSERT INTO captcha_used (token_hash, used_at) VALUES (?, ?)').run(hash, Date.now());
  db.prepare('DELETE FROM captcha_used WHERE used_at < ?').run(Date.now() - CLEANUP_MS);
  counters.solved += 1;
}

/** Reset counters (tests). */
export function resetCaptchaCounters(): void {
  counters.failures = 0;
  counters.issued = 0;
  counters.solved = 0;
}
