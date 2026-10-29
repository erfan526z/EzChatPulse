import crypto from 'node:crypto';
import type { Db } from '../db.js';
import { getSetting } from '../db.js';
import { config } from '../config.js';
import { BadRequest, NotFound } from '../errors.js';
import { sendMail, mailConfigured } from './mailer.js';

/**
 * Email verification (S1).
 *
 * Token: `v1.<userId>.<expEpoch>.<hmac(userId.exp.email)>` — stateless and
 * single-purpose: it can only verify the address it was minted for, it expires
 * after 24h, and changing the address invalidates it because the signature
 * covers the email. No token rows to clean up, nothing to leak from the DB.
 */

const TTL_SEC = 24 * 60 * 60;
/** One verification mail per minute per account. */
const RESEND_COOLDOWN_MS = 60_000;

export interface VerificationTarget {
  userId: number;
  email: string;
}

function sign(input: string): string {
  return crypto.createHmac('sha256', config.jwtSecret).update(input).digest('base64url');
}

export function createVerificationToken(userId: number, email: string): string {
  const exp = Math.floor(Date.now() / 1000) + TTL_SEC;
  const normalized = email.trim().toLowerCase();
  return `v1.${userId}.${exp}.${sign(`${userId}.${exp}.${normalized}`)}`;
}

/** Validate a token; returns what it authorises. Throws BadRequest when unusable. */
export function parseVerificationToken(db: Db, token: unknown): VerificationTarget {
  const raw = typeof token === 'string' ? token : '';
  const parts = raw.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new BadRequest('This verification link is not valid');

  const [, uidStr, expStr, signature] = parts;
  const userId = Number(uidStr);
  const exp = Number(expStr);
  if (!Number.isInteger(userId) || userId <= 0 || !Number.isFinite(exp)) {
    throw new BadRequest('This verification link is not valid');
  }
  if (Math.floor(Date.now() / 1000) > exp) throw new BadRequest('This verification link has expired');

  const row = db.prepare('SELECT id, email, email_verified FROM users WHERE id = ?').get(userId) as
    | { id: number; email: string | null; email_verified: number }
    | undefined;
  if (!row) throw new NotFound('Account not found');
  if (!row.email) throw new BadRequest('This account has no email address');

  const expected = sign(`${userId}.${exp}.${row.email.trim().toLowerCase()}`);
  const got = Buffer.from(String(signature ?? ''));
  const want = Buffer.from(expected);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
    throw new BadRequest('This verification link is not valid');
  }
  return { userId, email: row.email };
}

/** Mark the account's email verified. Idempotent. */
export function verifyEmailToken(db: Db, token: unknown): VerificationTarget {
  const target = parseVerificationToken(db, token);
  db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(target.userId);
  return target;
}

function emailBody(name: string, link: string): { html: string; text: string } {
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px;margin:0 auto;padding:8px">
  <h2 style="margin:0 0 8px;font-size:20px;color:#111">Confirm your email</h2>
  <p style="color:#333;line-height:1.55;margin:0 0 18px">
    Hi ${name.replace(/[<>&]/g, '')}, confirm this address to finish setting up your EzChatPulse account.
  </p>
  <p style="margin:0 0 22px">
    <a href="${link}" style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600">Verify my email</a>
  </p>
  <p style="color:#666;font-size:13px;line-height:1.5;margin:0 0 6px">This link expires in 24 hours and can only be used for this address.</p>
  <p style="color:#888;font-size:12px;word-break:break-all;margin:0">If the button does not work, paste this into your browser:<br>${link}</p>
  <p style="color:#aaa;font-size:12px;margin-top:18px">Didn't sign up? You can safely ignore this email.</p>
</div>`;
  const text = `Hi ${name},

Confirm your email address for EzChatPulse:

${link}

This link expires in 24 hours and only works for this address.
Didn't sign up? You can ignore this email.`;
  return { html, text };
}

/** Admin switch: must accounts confirm an email before they can send messages? */
export function requireVerifiedEmailSetting(db: Db): boolean {
  return getSetting(db, 'require_verified_email', 'false') === 'true';
}

/**
 * True when this account may NOT send messages yet: the admin requires verified
 * emails and this account has not been verified. `email_verified = 1` is the
 * single source of truth — it is set by the emailed link, or manually by an admin
 * for people who cannot receive mail at all.
 */
export function sendingBlockedByVerification(db: Db, userId: number): boolean {
  if (!requireVerifiedEmailSetting(db)) return false;
  const row = db.prepare('SELECT email_verified FROM users WHERE id = ?').get(userId) as
    | { email_verified: number }
    | undefined;
  if (!row) return false;
  return row.email_verified !== 1;
}

/**
 * Send (or resend) the verification mail. Returns the transport result; callers
 * decide whether a failed send should fail the request (registration: no;
 * explicit resend: yes).
 */
export async function sendVerificationEmail(
  db: Db,
  userId: number,
): Promise<{ sent: boolean; to?: string; error?: string }> {
  const row = db
    .prepare('SELECT id, username, display_name, email, email_verified, email_verify_sent_at FROM users WHERE id = ?')
    .get(userId) as
    | {
        id: number;
        username: string;
        display_name: string;
        email: string | null;
        email_verified: number;
        email_verify_sent_at: number | null;
      }
    | undefined;
  if (!row) throw new NotFound('Account not found');
  if (!row.email) throw new BadRequest('Add an email address first');
  if (row.email_verified) return { sent: false, error: 'already verified' };

  const since = row.email_verify_sent_at ?? 0;
  const waitMs = since + RESEND_COOLDOWN_MS - Date.now();
  if (waitMs > 0) {
    throw new BadRequest(`Please wait ${Math.ceil(waitMs / 1000)}s before requesting another email`);
  }
  if (!mailConfigured()) throw new BadRequest('Email sending is not configured on this server');

  db.prepare('UPDATE users SET email_verify_sent_at = ? WHERE id = ?').run(Date.now(), userId);

  const token = createVerificationToken(userId, row.email);
  const link = `${config.appUrl}/verify?token=${encodeURIComponent(token)}`;
  const { html, text } = emailBody(row.display_name || row.username, link);
  const result = await sendMail({
    to: row.email,
    subject: 'Confirm your email — EzChatPulse',
    html,
    text,
  });
  return { sent: result.sent, to: row.email, error: result.error };
}
