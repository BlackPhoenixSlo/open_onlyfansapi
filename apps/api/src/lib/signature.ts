// Webhook bodies and signing (plan-v5 §2.3). Free of env.ts so the local receiver can use it.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** `whsec_` + base64 of 32 random bytes. The whole string is the HMAC key. */
export function newWebhookSecret(): string {
  return 'whsec_' + randomBytes(32).toString('base64');
}

/**
 * The JSON body of every delivery and every client WS frame: `{"event","account_id","payload"}` in that order.
 * `account_id` is the account id as a JSON string, omitted when the event has no account (e.g. `webhook.test`).
 */
export function envelope(e: { type: string; accountId: number | null; data: unknown }): string {
  return JSON.stringify(
    e.accountId === null ? { event: e.type, payload: e.data } : { event: e.type, account_id: String(e.accountId), payload: e.data },
  );
}

/** The `Signature` header: lowercase hex HMAC-SHA256 of the raw body, keyed with the secret's UTF-8 bytes. */
export function sign(secret: string, body: string | Buffer): string {
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(body).digest('hex');
}

/** True when `signature` is the hex HMAC of `body` (compared in constant time). */
export function verifySignature(secret: string, signature: string, body: string | Buffer): boolean {
  if (!/^[0-9a-f]{64}$/i.test(signature)) return false;
  return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(sign(secret, body), 'hex'));
}
