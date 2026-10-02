import type { FastifyBaseLogger } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { webhookEventType } from '../../contracts.js';
import { db } from '../../db/index.js';
import { event, teamBackend } from '../../db/schema.js';
import { publish } from '../../lib/event-bus.js';
import { newId } from '../../lib/ids.js';
import { emit } from '../webhooks/service.js';

/** Frames waiting for ingest; more are dropped with a warning. */
const QUEUE_MAX = 1000;

/** Catalogue types an upstream frame may carry verbatim (`webhook.test` is gateway-only); all are stored. */
const STORED = new Set<string>(webhookEventType.options.filter((t) => t !== 'webhook.test' && t !== 'upstream.*'));
/** Stored types whose `data.amountCents` fills the ledger's `amount_cents` (plan-v4 §2.3). */
const AMOUNT_TYPES = new Set(['tip.received', 'ppv.unlocked', 'subscription.new', 'subscription.renewed']);

/** The upstream `/ws` frame (plan-v4 §2.2). */
const eventFrame = z.object({
  /** Stable per (type, account, OF object); becomes `event.dedup_key`. */
  id: z.string().min(1).nullish(),
  type: z.string().min(1),
  account_id: z.int32().positive(),
  ts: z.iso.datetime({ offset: true }),
  payload: z.unknown(),
});
const heartbeat = z.object({ type: z.literal('heartbeat'), ts: z.string() });
export type EventFrame = z.infer<typeof eventFrame>;

/** Parses one text frame: an event frame, `'heartbeat'`, or null (dropped with a warning). */
export function parseFrame(raw: string, log: FastifyBaseLogger): EventFrame | 'heartbeat' | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    log.warn('upstream event frame is not JSON; dropped');
    return null;
  }
  if (heartbeat.safeParse(json).success) return 'heartbeat';
  const parsed = eventFrame.safeParse(json);
  if (!parsed.success) {
    log.warn({ issues: parsed.error.issues }, 'upstream event frame is malformed; dropped');
    return null;
  }
  const { type } = parsed.data;
  if (!STORED.has(type) && !(type.startsWith('upstream.') && type.length > 'upstream.'.length)) {
    log.warn({ type }, 'upstream event type is not in the catalogue; dropped');
    return null;
  }
  return parsed.data;
}

function amountCents(type: string, payload: unknown): number | null {
  if (!AMOUNT_TYPES.has(type) || typeof payload !== 'object' || payload === null) return null;
  const amount = (payload as { amountCents?: unknown }).amountCents;
  return Number.isSafeInteger(amount) ? (amount as number) : null;
}

/**
 * One event: a stored type goes into the ledger first (a duplicate `id` stops here), then the bus, then a webhook
 * `emit()` per linked workspace. A failed ledger insert is logged; the event is still published but not emitted.
 */
export async function ingestFrame(frame: EventFrame, log: FastifyBaseLogger): Promise<void> {
  const { type, account_id: accountId } = frame;
  const data = frame.payload ?? {};
  const createdAt = new Date(frame.ts);
  let id = newId('evt');
  let stored = true;
  if (STORED.has(type)) {
    try {
      const rows = await db
        .insert(event)
        .values({ id, accountId, type, amountCents: amountCents(type, data), dedupKey: frame.id ?? null, createdAt })
        .onConflictDoNothing({ target: event.dedupKey, where: sql`${event.dedupKey} is not null` })
        .returning({ id: event.id });
      if (rows.length === 0) return; // duplicate
    } catch (err) {
      log.error({ err, type, accountId }, 'event ledger insert failed; published, not emitted');
      stored = false;
    }
  }
  publish({ id, type, createdAt, accountId, data });
  if (!stored) return;
  const teams = await db.select({ teamId: teamBackend.teamId }).from(teamBackend);
  await Promise.all(
    teams.map((t) =>
      emit(t.teamId, type, accountId, data).catch((err) => log.error({ err, type, teamId: t.teamId }, 'webhook emit failed')),
    ),
  );
}

/** Sequential ingest with a bounded queue. `idle()` resolves once the queue is empty. */
export function createIngestQueue(log: FastifyBaseLogger) {
  const pending: EventFrame[] = [];
  let running: Promise<void> | null = null;

  async function drain() {
    while (pending.length > 0) {
      const frame = pending.shift()!;
      try {
        await ingestFrame(frame, log);
      } catch (err) {
        log.error({ err, type: frame.type }, 'event ingest failed');
      }
    }
    running = null;
  }

  return {
    push(frame: EventFrame) {
      if (pending.length >= QUEUE_MAX) {
        log.warn({ type: frame.type }, 'event ingest queue full; frame dropped');
        return;
      }
      pending.push(frame);
      running ??= drain();
    },
    idle: () => running ?? Promise.resolve(),
  };
}
