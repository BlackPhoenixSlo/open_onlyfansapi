import { and, arrayOverlaps, desc, eq, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { webhookDelivery, webhookEndpoint } from '../../db/schema.js';
import { webhookEventType, type DeliveryStatus, type WebhookDelivery, type WebhookEndpoint, type WebhookEventType } from '../../contracts.js';
import { env } from '../../env.js';
import { AppError } from '../../lib/errors.js';
import { timeIdCursor } from '../../lib/cursor.js';
import { newId } from '../../lib/ids.js';
import { limiter } from '../../lib/limiter.js';
import { newWebhookSecret } from '../../lib/signature.js';

type EndpointRow = typeof webhookEndpoint.$inferSelect;
type DeliveryRow = typeof webhookDelivery.$inferSelect;

function toEndpoint(row: EndpointRow): WebhookEndpoint {
  return {
    id: row.id,
    url: row.url,
    description: row.description,
    events: row.events,
    secret: row.secret,
    enabled: row.enabled,
    pausedReason: row.pausedReason,
    consecutiveFailures: row.consecutiveFailures,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toDelivery(row: DeliveryRow): WebhookDelivery {
  return {
    id: row.id,
    eventId: row.eventId,
    endpointId: row.endpointId,
    eventType: row.eventType,
    accountId: row.accountId,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt.toISOString(),
    lastStatusCode: row.lastStatusCode,
    lastError: row.lastError,
    lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
    replayOf: row.replayOf,
    redeliverable: isRedeliverable(row),
    createdAt: row.createdAt.toISOString(),
  };
}

/** drizzle sends a JS `null` as SQL NULL; a JSON null payload is the jsonb value `null` (the column is NOT NULL). */
const jsonPayload = (data: unknown) => (data === null ? sql`'null'::jsonb` : data);

const notFound = () => new AppError(404, 'not_found', 'Webhook endpoint not found');

/** https only, unless ALLOW_HTTP_WEBHOOKS (local development). */
function assertUrlAllowed(url: string) {
  if (!env.ALLOW_HTTP_WEBHOOKS && new URL(url).protocol !== 'https:') {
    throw new AppError(400, 'invalid_webhook_url', 'Webhook URLs must use https://');
  }
}

async function findEndpoint(teamId: string, id: string): Promise<EndpointRow> {
  const [row] = await db
    .select()
    .from(webhookEndpoint)
    .where(and(eq(webhookEndpoint.id, id), eq(webhookEndpoint.teamId, teamId)))
    .limit(1);
  if (!row) throw notFound();
  return row;
}

export async function listEndpoints(teamId: string): Promise<WebhookEndpoint[]> {
  const rows = await db
    .select()
    .from(webhookEndpoint)
    .where(eq(webhookEndpoint.teamId, teamId))
    .orderBy(desc(webhookEndpoint.createdAt));
  return rows.map(toEndpoint);
}

export async function getEndpoint(teamId: string, id: string): Promise<WebhookEndpoint> {
  return toEndpoint(await findEndpoint(teamId, id));
}

export async function createEndpoint(
  teamId: string,
  input: { url: string; description: string | null; events: WebhookEventType[] },
): Promise<WebhookEndpoint> {
  assertUrlAllowed(input.url);
  const [row] = await db
    .insert(webhookEndpoint)
    .values({ id: newId('whe'), teamId, ...input, secret: newWebhookSecret() })
    .returning();
  return toEndpoint(row!);
}

/** `enabled: true` clears the breaker (pending deliveries resume); `enabled: false` pauses it manually. */
export async function updateEndpoint(
  teamId: string,
  id: string,
  patch: { url?: string; description?: string | null; events?: WebhookEventType[]; enabled?: boolean },
): Promise<WebhookEndpoint> {
  if (patch.url !== undefined) assertUrlAllowed(patch.url);
  const breaker =
    patch.enabled === true
      ? { pausedReason: null, consecutiveFailures: 0 }
      : patch.enabled === false
        ? { pausedReason: 'manual' as const }
        : {};
  const [row] = await db
    .update(webhookEndpoint)
    .set({ ...patch, ...breaker, updatedAt: new Date() })
    .where(and(eq(webhookEndpoint.id, id), eq(webhookEndpoint.teamId, teamId)))
    .returning();
  if (!row) throw notFound();
  return toEndpoint(row);
}

export async function deleteEndpoint(teamId: string, id: string): Promise<void> {
  const rows = await db
    .delete(webhookEndpoint)
    .where(and(eq(webhookEndpoint.id, id), eq(webhookEndpoint.teamId, teamId)))
    .returning({ id: webhookEndpoint.id });
  if (rows.length === 0) throw notFound();
}

/** Queues a `webhook.test` delivery (with a fresh `evt_` id) to this endpoint, whatever its events filter. */
export async function queueTest(teamId: string, id: string): Promise<WebhookDelivery> {
  const endpoint = await findEndpoint(teamId, id);
  const [row] = await db
    .insert(webhookDelivery)
    .values({
      id: newId('whd'),
      teamId,
      endpointId: endpoint.id,
      eventId: newId('evt'),
      eventType: 'webhook.test',
      payload: { message: 'Test event from the gateway' },
    })
    .returning();
  return toDelivery(row!);
}

/**
 * Whether a delivery may be sent again: not `dropped`, and its type is a catalogue name or `upstream.<name>`
 * (a 1.x name would go out under the 2.0 envelope).
 */
export function isRedeliverable(d: { status: string; eventType: string }): boolean {
  if (d.status === 'dropped') return false;
  return (webhookEventType.options as readonly string[]).includes(d.eventType) || /^upstream\..+/.test(d.eventType);
}

/**
 * Re-sends a delivery as a new pending row (new `whd_` id, same `event_id`) with `replay_of` set. 409 when the
 * delivery is not redeliverable.
 */
export async function redeliver(teamId: string, endpointId: string, deliveryId: string): Promise<WebhookDelivery> {
  const [original] = await db
    .select()
    .from(webhookDelivery)
    .where(
      and(eq(webhookDelivery.id, deliveryId), eq(webhookDelivery.endpointId, endpointId), eq(webhookDelivery.teamId, teamId)),
    )
    .limit(1);
  if (!original) throw new AppError(404, 'not_found', 'Delivery not found');
  if (!isRedeliverable(original)) {
    throw new AppError(409, 'not_redeliverable', 'This delivery was dropped or uses a 1.x event name; it cannot be sent again');
  }
  const [row] = await db
    .insert(webhookDelivery)
    .values({
      id: newId('whd'),
      teamId,
      endpointId,
      eventId: original.eventId,
      eventType: original.eventType,
      accountId: original.accountId,
      payload: jsonPayload(original.payload),
      replayOf: original.id,
    })
    .returning();
  return toDelivery(row!);
}

export async function listDeliveries(
  teamId: string,
  endpointId: string,
  f: { status?: DeliveryStatus; event?: string; cursor?: string; limit: number },
): Promise<{ items: WebhookDelivery[]; nextCursor: string | null }> {
  await findEndpoint(teamId, endpointId);
  const where: (SQL | undefined)[] = [eq(webhookDelivery.endpointId, endpointId)];
  if (f.status) where.push(eq(webhookDelivery.status, f.status));
  if (f.event) where.push(eq(webhookDelivery.eventType, f.event));
  if (f.cursor) {
    const [ts, id] = timeIdCursor.decode(f.cursor);
    where.push(sql`(${webhookDelivery.createdAt}, ${webhookDelivery.id}) < (${ts}::timestamptz, ${id})`);
  }
  const rows = await db
    .select()
    .from(webhookDelivery)
    .where(and(...where))
    .orderBy(desc(webhookDelivery.createdAt), desc(webhookDelivery.id))
    .limit(f.limit + 1);
  const { items, nextCursor } = timeIdCursor.page(rows, f.limit);
  return { items: items.map(toDelivery), nextCursor };
}

// emit() writes share the pg.Pool with the proxy and dashboard: an upstream burst queues here instead of
// taking every connection.
const limitEmit = limiter(3);

/**
 * Queues one event for every enabled endpoint of the team that subscribes to `type` (empty events = all;
 * `upstream.*` covers every `upstream.<name>`), in a single multi-row INSERT. `eventId` is the event's `evt_` id
 * (the idempotency key). Returns the number queued.
 */
export function emit(teamId: string, eventId: string, type: string, accountId: number | null, data: unknown): Promise<number> {
  return limitEmit(async () => {
    const subscribed = type.startsWith('upstream.') ? [type, 'upstream.*'] : [type];
    const endpoints = await db
      .select({ id: webhookEndpoint.id })
      .from(webhookEndpoint)
      .where(
        and(
          eq(webhookEndpoint.teamId, teamId),
          eq(webhookEndpoint.enabled, true),
          or(sql`cardinality(${webhookEndpoint.events}) = 0`, arrayOverlaps(webhookEndpoint.events, subscribed)),
        ),
      );
    if (endpoints.length === 0) return 0;
    await db.insert(webhookDelivery).values(
      endpoints.map((e) => ({
        id: newId('whd'),
        teamId,
        endpointId: e.id,
        eventId,
        eventType: type,
        accountId,
        payload: jsonPayload(data),
      })),
    );
    return endpoints.length;
  });
}
