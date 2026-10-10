import type { FastifyBaseLogger } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { webhookEventType } from '../../contracts.js';
import { db } from '../../db/index.js';
import { event } from '../../db/schema.js';
import { cause } from '../../lib/errors.js';
import { publish } from '../../lib/event-bus.js';
import { newId } from '../../lib/ids.js';
import { applyLiveEvent } from '../analytics/live.js';
import { accountOwner } from '../accounts/ownership.js';
import { emit } from '../webhooks/service.js';

/** Frames waiting for ingest; more are dropped. */
const QUEUE_MAX = 1000;
/** At most one "frames dropped" warning per window. */
const DROP_REPORT_MS = 60_000;

/** Catalogue types an upstream frame may carry verbatim (`webhook.test` is gateway-only); all are stored. */
const STORED = new Set<string>(webhookEventType.options.filter((t) => t !== 'webhook.test' && t !== 'upstream.*'));
/** The upstream `/ws` frame (plan-v4 §2.2 plus `amount_cents`, plan-v5 §2.4). The payload is never parsed. */
const eventFrame = z.object({
  /** Stable per (type, account, OF object), or null; becomes `event.dedup_key`. */
  id: z.string().min(1).nullable(),
  type: z.string().min(1),
  account_id: z.int32().positive(),
  ts: z.iso.datetime({ offset: true }),
  payload: z.unknown().refine((v) => v !== undefined),
  /** OF's gross amount in cents, or null; fills the ledger's `amount_cents`. Anything but an int32 becomes null. */
  amount_cents: z.int32().nullish().catch(null),
});
const heartbeat = z.object({ type: z.literal('heartbeat'), ts: z.string() });
export type EventFrame = z.infer<typeof eventFrame>;
/** `bad_amount` is counted, not dropped: the frame is kept with `amount_cents` null. */
export type DropReason = 'malformed' | 'unknown_type' | 'queue_full' | 'bad_amount';

/**
 * Parses one text frame: an event frame, `'heartbeat'`, or why it is dropped. `onBadAmount` is called for a kept
 * frame whose `amount_cents` was present but not an int32.
 */
export function parseFrame(
  raw: string,
  onBadAmount?: () => void,
): EventFrame | 'heartbeat' | Exclude<DropReason, 'queue_full' | 'bad_amount'> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return 'malformed';
  }
  if (heartbeat.safeParse(json).success) return 'heartbeat';
  const parsed = eventFrame.safeParse(json);
  if (!parsed.success) return 'malformed';
  const { type } = parsed.data;
  if (!STORED.has(type) && !(type.startsWith('upstream.') && type.length > 'upstream.'.length)) return 'unknown_type';
  if (parsed.data.amount_cents === null && (json as { amount_cents?: unknown }).amount_cents != null) onBadAmount?.();
  return parsed.data;
}

/** Accounts already warned about as owned by no workspace (one warning per account per process). */
const unowned = new Set<number>();

/**
 * One event: a stored type goes into the ledger first (a duplicate `id` stops here). Then, for the workspace that owns
 * the account, the bus, and together a webhook `emit()` (when the workspace is linked) and the analytics store's live
 * update (`applyLiveEvent`, which never throws). An event of an account no workspace owns stays in the ledger only
 * (one warning per account). Its `evt_` id is the ledger id, the bus id and the deliveries' idempotency key. A failed
 * ledger insert is logged and the event dropped.
 */
export async function ingestFrame(frame: EventFrame, log: FastifyBaseLogger): Promise<void> {
  const { type, account_id: accountId } = frame;
  const data = frame.payload;
  const createdAt = new Date(frame.ts);
  const id = newId('evt');
  if (STORED.has(type)) {
    try {
      const rows = await db
        .insert(event)
        .values({ id, accountId, type, amountCents: frame.amount_cents ?? null, dedupKey: frame.id, createdAt })
        .onConflictDoNothing({ target: event.dedupKey, where: sql`${event.dedupKey} is not null` })
        .returning({ id: event.id });
      if (rows.length === 0) return; // duplicate
    } catch (err) {
      log.error({ err: cause(err), type, accountId }, 'event ledger insert failed; event dropped');
      return;
    }
  }
  const owner = await accountOwner(accountId);
  if (!owner) {
    if (!unowned.has(accountId)) {
      unowned.add(accountId);
      log.warn({ accountId }, 'events of an account no workspace owns are not sent (analytics:claim assigns it)');
    }
    return;
  }
  const { teamId } = owner;
  publish({ id, type, accountId, ts: frame.ts, data, teamId });
  const tasks: Promise<unknown>[] = [applyLiveEvent(id, type, accountId, teamId, data, log)];
  if (owner.linked) {
    tasks.push(emit(teamId, id, type, accountId, data).catch((err) => log.error({ err: cause(err), type, teamId }, 'webhook emit failed')));
  }
  await Promise.all(tasks);
}

/**
 * Sequential ingest with a bounded queue. Dropped frames are counted and reported in one warning when the queue
 * empties, at most once per minute. `clear()` discards the waiting frames; `idle()` resolves once none is in flight.
 */
export function createIngestQueue(log: FastifyBaseLogger) {
  const pending: EventFrame[] = [];
  let running: Promise<void> | null = null;
  const dropped: Record<DropReason, number> = { malformed: 0, unknown_type: 0, queue_full: 0, bad_amount: 0 };
  let lastReport = 0;
  let reportTimer: NodeJS.Timeout | undefined;

  function report() {
    if (reportTimer || !Object.values(dropped).some((n) => n > 0)) return;
    const wait = lastReport + DROP_REPORT_MS - Date.now();
    if (wait > 0) {
      reportTimer = setTimeout(() => {
        reportTimer = undefined;
        report();
      }, wait).unref();
      return;
    }
    log.warn({ dropped: { ...dropped } }, 'upstream event frames dropped');
    lastReport = Date.now();
    for (const reason of Object.keys(dropped) as DropReason[]) dropped[reason] = 0;
  }

  async function drain() {
    while (pending.length > 0) {
      const frame = pending.shift()!;
      try {
        await ingestFrame(frame, log);
      } catch (err) {
        log.error({ err: cause(err), type: frame.type }, 'event ingest failed');
      }
    }
    running = null;
    report();
  }

  return {
    push(frame: EventFrame) {
      if (pending.length >= QUEUE_MAX) {
        dropped.queue_full++;
        return;
      }
      pending.push(frame);
      running ??= drain();
    },
    drop(reason: DropReason) {
      dropped[reason]++;
      if (!running) report();
    },
    /** Discards waiting frames and reports pending drop counts now. */
    clear() {
      pending.length = 0;
      clearTimeout(reportTimer);
      reportTimer = undefined;
      lastReport = 0;
      report();
    },
    idle: () => running ?? Promise.resolve(),
  };
}
