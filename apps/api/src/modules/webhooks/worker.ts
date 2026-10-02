import { lookup } from 'node:dns/promises';
import { BlockList, isIPv4 } from 'node:net';
import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { env } from '../../env.js';
import { limiter } from '../../lib/limiter.js';
import { envelope, signatureHeaders } from '../../lib/signature.js';

/** Delay before retry n (after the nth finished attempt); the last step repeats. */
export const BACKOFF_SECONDS = [30, 120, 600, 3600, 21_600];
/** A claim pushes `next_attempt_at` this far out so no other worker picks the row while it is in flight. */
const LEASE_SECONDS = 60;
const BATCH = 20;
/** POSTs (with their completion writes) in flight at once: the pg.Pool is shared with the proxy and dashboard. */
const CONCURRENCY = 5;
/** Per attempt, DNS lookup included. */
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
  /** The `next_attempt_at` this claim set, as exact Postgres text: completion is fenced on it. */
  leasedUntil: string;
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
      c.payload, c.created_at as "createdAt", c.next_attempt_at as "leasedUntil", e.url, e.secret
    from claimed c join webhook_endpoint e on e.id = c.endpoint_id`);
  return res.rows;
}

function blockList(ipv4: [string, number][], ipv6: [string, number][]): BlockList {
  const list = new BlockList();
  for (const [net, prefix] of ipv4) list.addSubnet(net, prefix, 'ipv4');
  for (const [net, prefix] of ipv6) list.addSubnet(net, prefix, 'ipv6');
  return list;
}

/** Link-local, including cloud metadata (169.254.169.254): refused even with ALLOW_HTTP_WEBHOOKS. */
const linkLocal = blockList([['169.254.0.0', 16]], [['fe80::', 10]]);
/** Private, loopback, unspecified and special-purpose ranges: refused unless ALLOW_HTTP_WEBHOOKS. */
const privateNets = blockList(
  [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ],
  [
    ['::', 128],
    ['::1', 128],
    ['64:ff9b::', 96],
    ['2002::', 16],
    ['fc00::', 7],
  ],
);

/** IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is checked as IPv4. */
function inList(list: BlockList, address: string): boolean {
  const mapped = /^::ffff:(.+)$/i.exec(address)?.[1];
  if (mapped && isIPv4(mapped)) return list.check(mapped, 'ipv4');
  return isIPv4(address) ? list.check(address, 'ipv4') : list.check(address, 'ipv6');
}

export const isLinkLocalAddress = (address: string) => inList(linkLocal, address);
export const isPrivateAddress = (address: string) => isLinkLocalAddress(address) || inList(privateNets, address);

/** Rejects when `signal` aborts first (dns.lookup takes no signal). */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/**
 * Refuses hosts that resolve to a link-local address and, unless ALLOW_HTTP_WEBHOOKS, to a private one.
 * (https-only is enforced when the URL is saved, in service.ts.)
 */
export async function assertDeliverable(url: URL, signal: AbortSignal = AbortSignal.timeout(TIMEOUT_MS)): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await abortable(lookup(host, { all: true }), signal);
  for (const { address } of addresses) {
    if (isLinkLocalAddress(address)) throw new Error(`${host} resolves to a link-local address`);
    if (!env.ALLOW_HTTP_WEBHOOKS && isPrivateAddress(address)) throw new Error(`${host} resolves to a private address`);
  }
}

/** One POST under a single 10 s deadline. Never throws: the outcome is the status code or an error message. */
async function post(c: Claimed): Promise<{ statusCode: number | null; error: string | null }> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const url = new URL(c.url);
    await assertDeliverable(url, signal);
    const body = envelope({ id: c.id, type: c.eventType, createdAt: new Date(c.createdAt), accountId: c.accountId, data: c.payload });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'Gateway-Webhooks', ...signatureHeaders(c.secret, c.id, body) },
      body,
      redirect: 'manual',
      signal,
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
 * lease). Fenced on the lease: if this worker outlived it and the row was claimed again (or already completed),
 * nothing changes. 2xx resets the endpoint's breaker; the last failed attempt marks the delivery failed and counts
 * towards pausing the endpoint at WEBHOOK_PAUSE_AFTER consecutive failures.
 */
export async function completeDelivery(
  c: Pick<Claimed, 'id' | 'endpointId' | 'leasedUntil'>,
  outcome: { statusCode: number | null; error: string | null },
) {
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
      where id = ${c.id} and status = 'pending' and next_attempt_at = ${c.leasedUntil}::timestamptz
      returning status`);
    const status = res.rows[0]?.status;
    if (status === 'succeeded') {
      await tx.execute(sql`
        update webhook_endpoint set consecutive_failures = 0 where id = ${c.endpointId} and consecutive_failures <> 0`);
    } else if (status === 'failed') {
      const pause = sql`consecutive_failures + 1 >= ${env.WEBHOOK_PAUSE_AFTER}`;
      await tx.execute(sql`
        update webhook_endpoint set
          consecutive_failures = consecutive_failures + 1,
          paused_reason = case when enabled and ${pause} then 'failures' else paused_reason end,
          enabled = case when ${pause} then false else enabled end,
          updated_at = now()
        where id = ${c.endpointId}`);
    }
  });
}

const limit = limiter(CONCURRENCY);

/**
 * One worker tick: claim a batch, POST up to CONCURRENCY at a time, record the outcomes. The whole batch settles
 * before this returns (so the job's overrun guard holds); then it throws if any completion write failed.
 * Returns the number of deliveries attempted.
 */
export async function deliverDue(): Promise<number> {
  const batch = await claimDeliveries();
  const results = await Promise.allSettled(batch.map((c) => limit(async () => completeDelivery(c, await post(c)))));
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length > 0) {
    throw new AggregateError(failed.map((r) => r.reason), `${failed.length} of ${batch.length} delivery completions failed`);
  }
  return batch.length;
}
