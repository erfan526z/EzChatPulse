import { config } from '../config.js';

/**
 * Outbound transactional mail via Resend (HTTPS API — no SMTP, no extra deps).
 *
 * The API key is a send-only key supplied through the environment
 * (`RESEND_API_KEY`, installed as /etc/chatpulse/mail.env, mode 600). It is never
 * logged, never returned in API responses, and never written to the database.
 *
 * `setMailTransport()` is a test seam: tests capture outgoing mail instead of
 * hitting the network.
 */

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export interface MailResult {
  sent: boolean;
  id?: string;
  error?: string;
}

export type MailTransport = (message: MailMessage) => Promise<MailResult>;

let override: MailTransport | null = null;

/** Replace the transport (tests) or pass null to restore the real one. */
export function setMailTransport(transport: MailTransport | null): void {
  override = transport;
}

/** True when the app has everything it needs to send mail (or a transport is installed). */
export function mailConfigured(): boolean {
  return override !== null || (config.mailEnabled && config.resendApiKey.length > 0);
}

export async function sendMail(message: MailMessage): Promise<MailResult> {
  if (override) return override(message);
  if (!mailConfigured()) return { sent: false, error: 'mail is not configured on this server' };

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.resendApiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: config.mailFrom,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        ...(message.text ? { text: message.text } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
    if (!res.ok || !body.id) {
      // provider message is safe to log (it never echoes the key)
      console.error(`mail: send failed (${res.status}): ${body.message ?? 'unknown error'}`);
      return { sent: false, error: body.message ?? `provider returned ${res.status}` };
    }
    return { sent: true, id: body.id };
  } catch (err) {
    const messageText = err instanceof Error ? err.message : 'send failed';
    console.error(`mail: send failed: ${messageText}`);
    return { sent: false, error: messageText };
  }
}
