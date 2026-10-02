import { lookup } from 'node:dns/promises';
import { BlockList, isIPv4 } from 'node:net';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { env } from '../../env.js';
import { envelope, signatureHeaders } from '../../lib/signature.js';

/** Delay before retry n (after the nth finished attempt); the last step repeats. */
export const BACKOFF_SECONDS = [30, 120, 600, 3600, 21_600];
/** A claim pushes `next_attempt_at` this far out so no other worker picks the row while it is in flight. */
const LEASE_SECONDS = 60;
const BATCH = 20;
const TIMEOUT_MS = 10_000;
const MAX_ERROR_LENGTH = 500;

export type Claimed = {
  id: string;
  endpointId: string;
  eventType: string;
  accountId: number | null;
  payload: unknown;
  /** Postgres timestamptz text (raw `execute` rows are not mapped by drizzle). */
  createdAt: string;
  url: string;
  secret: string;
};

/**
 * Leases up to `limit` due deliveries of enabled endpoints. `FOR UPDATE … SKIP LOCKED` keeps concurrent workers
 * off each other's rows; the lease moves `next_attempt_at` out and leaves `attempts` alone (counted on completion),
 * so a crash mid-POST only delays the retry by the lease.
 */
export async function claimDeliveries(limit = BATCH): Promise<Claimed[]> {
  const res = await db.execute<Claimed>(sql`
    with claimed as (
      update webhook_delivery set next_attempt_at = now() + make_interval(secs => ${LEASE_SECONDS})
      where id in (
        select d.id from webhook_delivery d join webhook_endpoint e on e.id = d.endpoint_id
        where d.status = 'pending' and d.next_attempt_at <= now() and e.enabled
        order by d.next_attempt_at
        limit ${limit}
        for update of d skip locked
      )
      returning *
    )
    select c.id, c.endpoint_id as "endpointId", c.event_type as "eventType", c.account_id as "accountId",
      c.payload, c.created_at as "createdAt", e.url, e.secret
    from claimed c join webhook_endpoint e on e.id = c.endpoint_id`);
  return res.rows;
}

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
] as const) {
  blocked.addSubnet(net, prefix, 'ipv6');
}

/** True for private, loopback, link-local and unspecified addresses (IPv4-mapped IPv6 included). */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(.+)$/i.exec(address)?.[1];
  if (mapped && isIPv4(mapped)) return blocked.check(mapped, 'ipv4');
  return isIPv4(address) ? blocked.check(address, 'ipv4') : blocked.check(address, 'ipv6');
}

/** Refuses non-https URLs and hosts that resolve to a private address, unless ALLOW_HTTP_WEBHOOKS. */
export async function assertDeliverable(url: URL): Promise<void> {
  if (env.ALLOW_HTTP_WEBHOOKS) return;
  if (url.protocol !== 'https:') throw new Error('webhook URLs must use https://');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await lookup(host, { all: true });
  if (addresses.some((a) => isPrivateAddress(a.address))) {
    throw new Error(`${host} resolves to a private address`);
  }
}

/** One POST. Never throws: the outcome is the status code or an error message. */
async function post(c: Claimed): Promise<{ statusCode: number | null; error: string | null }> {
  try {
    const url = new URL(c.url);
    await assertDeliverable(url);
    const body = envelope({ id: c.id, type: c.eventType, createdAt: new Date(c.createdAt), accountId: c.accountId, data: c.payload });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'Gateway-Webhooks', ...signatureHeaders(c.secret, c.id, body) },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await res.body?.cancel();
    return { statusCode: res.status, error: res.status >= 200 && res.status < 300 ? null : `HTTP ${res.status}` };
  } catch (err) {
    const message = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
    return { statusCode: null, error: message.slice(0, MAX_ERROR_LENGTH) };
  }
}

/**
 * Records a finished attempt: `attempts + 1`, and `next_attempt_at` overwritten with the real backoff (replacing the
 * lease). 2xx resets the endpoint's breaker; the last failed attempt marks the delivery failed and counts towards
 * pausing the endpoint at WEBHOOK_PAUSE_AFTER consecutive failures.
 */
export async function completeDelivery(id: string, endpointId: string, outcome: { statusCode: number | null; error: string | null }) {
  const ok = outcome.error === null;
  const backoff = sql`array[${sql.raw(BACKOFF_SECONDS.join(','))}]`;
  await db.transaction(async (tx) => {
    const res = await tx.execute<{ status: string }>(sql`
      update webhook_delivery set
        attempts = attempts + 1,
        last_attempt_at = now(),
        last_status_code = ${outcome.statusCode},
        last_error = ${outcome.error},
        status = case when ${ok} then 'succeeded' when attempts + 1 >= ${env.WEBHOOK_MAX_ATTEMPTS} then 'failed' else 'pending' end,
        next_attempt_at = now() + make_interval(secs => (${backoff})[least(attempts + 1, ${BACKOFF_SECONDS.length})])
      where id = ${id} and status = 'pending'
      returning status`);
    const status = res.rows[0]?.status;
    if (status === 'succeeded') {
      await tx.execute(sql`
        update webhook_endpoint set consecutive_failures = 0 where id = ${endpointId} and consecutive_failures <> 0`);
    } else if (status === 'failed') {
      const pause = sql`consecutive_failures + 1 >= ${env.WEBHOOK_PAUSE_AFTER}`;
      await tx.execute(sql`
        update webhook_endpoint set
          consecutive_failures = consecutive_failures + 1,
          paused_reason = case when enabled and ${pause} then 'failures' else paused_reason end,
          enabled = case when ${pause} then false else enabled end,
          updated_at = now()
        where id = ${endpointId}`);
    }
  });
}

/** One worker tick: claim a batch, POST each concurrently, record the outcomes. Returns the number delivered. */
export async function deliverDue(): Promise<number> {
  const batch = await claimDeliveries();
  await Promise.all(batch.map(async (c) => completeDelivery(c.id, c.endpointId, await post(c))));
  return batch.length;
}

const RETENTION_BATCH = 10_000;

/** Deletes deliveries older than `days`, in batches like the request-log retention. */
export async function deleteExpiredDeliveries(days: number): Promise<number> {
  let deleted = 0;
  for (;;) {
    const res = await db.execute(sql`
      delete from webhook_delivery where id in (
        select id from webhook_delivery where created_at < now() - make_interval(days => ${days}) limit ${RETENTION_BATCH}
      )`);
    deleted += res.rowCount ?? 0;
    if ((res.rowCount ?? 0) < RETENTION_BATCH) return deleted;
  }
}
