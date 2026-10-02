import type { FastifyBaseLogger } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { webhookEventType } from '../../contracts.js';
import { db } from '../../db/index.js';
import { event, teamBackend } from '../../db/schema.js';
import { publish } from '../../lib/event-bus.js';
import { newId } from '../../lib/ids.js';
import { emit } from '../webhooks/service.js';

/** Frames waiting for ingest; more are dropped. */
const QUEUE_MAX = 1000;
/** At most one "frames dropped" warning per window. */
const DROP_REPORT_MS = 60_000;

/** Catalogue types an upstream frame may carry verbatim (`webhook.test` is gateway-only); all are stored. */
const STORED = new Set<string>(webhookEventType.options.filter((t) => t !== 'webhook.test' && t !== 'upstream.*'));
/** Stored types whose `data.amountCents` fills the ledger's `amount_cents` (plan-v4 §2.3). */
const AMOUNT_TYPES = new Set(['tip.received', 'ppv.unlocked', 'subscription.new', 'subscription.renewed']);
const amount = z.object({ amountCents: z.int32() });

/** The upstream `/ws` frame (plan-v4 §2.2). */
const eventFrame = z.object({
  /** Stable per (type, account, OF object), or null; becomes `event.dedup_key`. */
  id: z.string().min(1).nullable(),
  type: z.string().min(1),
  account_id: z.int32().positive(),
  ts: z.iso.datetime({ offset: true }),
  payload: z.unknown().refine((v) => v !== undefined),
});
const heartbeat = z.object({ type: z.literal('heartbeat'), ts: z.string() });
export type EventFrame = z.infer<typeof eventFrame>;
export type DropReason = 'malformed' | 'unknown_type' | 'queue_full';

/** Parses one text frame: an event frame, `'heartbeat'`, or why it is dropped. */
export function parseFrame(raw: string): EventFrame | 'heartbeat' | Exclude<DropReason, 'queue_full'> {
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
  return parsed.data;
}

/** The driver's cause only: drizzle's own error message embeds the query parameters (fan message text). */
const cause = (err: unknown) => (err instanceof Error && err.cause instanceof Error ? err.cause : err);

/**
 * One event: a stored type goes into the ledger first (a duplicate `id` stops here), then the bus, then a webhook
 * `emit()` per linked workspace. A failed ledger insert is logged; the event is still published but not emitted.
 */
export async function ingestFrame(frame: EventFrame, log: FastifyBaseLogger): Promise<void> {
  const { type, account_id: accountId } = frame;
  const data = frame.payload;
  const createdAt = new Date(frame.ts);
  const id = newId('evt');
  if (STORED.has(type)) {
    const parsed = AMOUNT_TYPES.has(type) ? amount.safeParse(data) : null;
    try {
      const rows = await db
        .insert(event)
        .values({ id, accountId, type, amountCents: parsed?.data?.amountCents ?? null, dedupKey: frame.id, createdAt })
        .onConflictDoNothing({ target: event.dedupKey, where: sql`${event.dedupKey} is not null` })
        .returning({ id: event.id });
      if (rows.length === 0) return; // duplicate
    } catch (err) {
      log.error({ err: cause(err), type, accountId }, 'event ledger insert failed; published, not emitted');
      publish({ id, type, createdAt, accountId, data });
      return;
    }
  }
  publish({ id, type, createdAt, accountId, data });
  const teams = await db.select({ teamId: teamBackend.teamId }).from(teamBackend);
  await Promise.all(
    teams.map((t) =>
      emit(t.teamId, type, accountId, data).catch((err) =>
        log.error({ err: cause(err), type, teamId: t.teamId }, 'webhook emit failed'),
      ),
    ),
  );
}

/**
 * Sequential ingest with a bounded queue. Dropped frames are counted and reported in one warning when the queue
 * empties, at most once per minute. `clear()` discards the waiting frames; `idle()` resolves once none is in flight.
 */
export function createIngestQueue(log: FastifyBaseLogger) {
  const pending: EventFrame[] = [];
  let running: Promise<void> | null = null;
  const dropped: Record<DropReason, number> = { malformed: 0, unknown_type: 0, queue_full: 0 };
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
