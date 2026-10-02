// Standard Webhooks signing (https://www.standardwebhooks.com). Free of env.ts so the local receiver can use it.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const SECRET_PREFIX = 'whsec_';

/** `whsec_` + base64 of 32 random bytes. */
export function newWebhookSecret(): string {
  return SECRET_PREFIX + randomBytes(32).toString('base64');
}

/** The JSON body of every delivery. */
export function envelope(e: { id: string; type: string; createdAt: Date; accountId: number | null; data: unknown }): string {
  return JSON.stringify({ id: e.id, type: e.type, createdAt: e.createdAt.toISOString(), accountId: e.accountId, data: e.data });
}

/** `v1,<base64 HMAC-SHA256(base64-decoded secret, "<id>.<timestamp>.<body>")>` */
export function sign(secret: string, id: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.slice(SECRET_PREFIX.length), 'base64');
  return 'v1,' + createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64');
}

/** The `webhook-id`, `webhook-timestamp` and `webhook-signature` headers for one delivery attempt. */
export function signatureHeaders(secret: string, id: string, body: string, now = new Date()): Record<string, string> {
  const timestamp = Math.floor(now.getTime() / 1000);
  return { 'webhook-id': id, 'webhook-timestamp': String(timestamp), 'webhook-signature': sign(secret, id, timestamp, body) };
}

/** True when one of the space-separated `v1,` signatures matches and the timestamp is within `toleranceS`. */
export function verifySignature(
  secret: string,
  headers: { id: string; timestamp: string; signature: string },
  body: string,
  toleranceS = 300,
): boolean {
  const timestamp = Number(headers.timestamp);
  if (!Number.isInteger(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > toleranceS) return false;
  const expected = Buffer.from(sign(secret, headers.id, timestamp, body));
  return headers.signature.split(' ').some((candidate) => {
    const got = Buffer.from(candidate);
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}
