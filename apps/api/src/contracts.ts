// Wire types shared with apps/web (imported there via the `@api/contracts` alias, types only).
import { z } from 'zod';

export const keyScope = z.enum(['read', 'write']);
export type KeyScope = z.infer<typeof keyScope>;

export const apiKey = z.object({
  id: z.string(),
  name: z.string(),
  start: z.string(),
  scope: keyScope,
  allowedAccountIds: z.array(z.number().int()).nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type ApiKey = z.infer<typeof apiKey>;

const keyName = z.string().trim().min(1).max(100);
/** null = all accounts the workspace can reach */
const allowedAccountIds = z.array(z.number().int().positive()).min(1).nullable();

export const createKeyBody = z.object({
  name: keyName,
  scope: keyScope.default('read'),
  allowedAccountIds: allowedAccountIds.default(null),
});
export type CreateKeyBody = z.input<typeof createKeyBody>;

// No defaults here: an omitted field is left unchanged.
export const updateKeyBody = z.object({
  name: keyName.optional(),
  scope: keyScope.optional(),
  allowedAccountIds: allowedAccountIds.optional(),
});
export type UpdateKeyBody = z.input<typeof updateKeyBody>;

export const keyList = z.object({ items: z.array(apiKey) });
export const createdKey = z.object({ key: apiKey, secret: z.string() });
export type CreatedKey = z.infer<typeof createdKey>;

export const account = z.object({
  id: z.number().int(),
  label: z.string().nullable(),
  username: z.string().nullable(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  status: z.string(),
});
export type Account = z.infer<typeof account>;
export const accountList = z.object({ items: z.array(account) });

/** `POST /api/accounts/connect`: a DevTools "Copy as cURL (bash)" of an OF request (live cookies; never logged). */
export const connectAccountBody = z.object({
  curl: z.string().min(1),
  nickname: z.string().trim().min(1).max(100).optional(),
  /** `scheme://[user:pass@]host:port`; checked by the upstream. */
  proxyUrl: z.string().trim().min(1).max(2048).optional(),
});
export type ConnectAccountBody = z.infer<typeof connectAccountBody>;
/** The upstream's `/session/bootstrap` success body, passed through unchanged. */
export type ConnectedAccount = { accountId: number; username: string | null; status: string };

export const whoami = z.object({
  team: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    /** Whether the operator linked this workspace to the upstream (`link-team <slug>`). */
    linked: z.boolean(),
  }),
  key: apiKey.pick({ id: true, name: true, scope: true, allowedAccountIds: true }).nullable(),
  user: z.object({ id: z.string() }).nullable(),
});
export type Whoami = z.infer<typeof whoami>;

export type ErrorBody = { error: { code: string; message: string; requestId: string } };

// Request logs
export const logStatus = z.enum(['2xx', '4xx', '5xx', 'error']);
export type LogStatus = z.infer<typeof logStatus>;

export const logSummary = z.object({
  id: z.string(),
  createdAt: z.string(),
  method: z.string(),
  /** As called, without the query string, e.g. `/v1/12/users/me`. */
  path: z.string(),
  /** Normalised, e.g. `GET /users/:id` (proxy) or `GET /v1/whoami` (gateway route). */
  endpoint: z.string(),
  statusCode: z.number().int(),
  durationMs: z.number().int(),
  reqBytes: z.number().int(),
  respBytes: z.number().int(),
  /** Gateway-generated error code; null for successes and passed-through upstream errors. */
  errorCode: z.string().nullable(),
  /** null = dashboard session */
  keyId: z.string().nullable(),
  keyName: z.string().nullable(),
  userId: z.string().nullable(),
  accountId: z.number().int().nullable(),
});
export type LogSummary = z.infer<typeof logSummary>;
export const logList = z.object({ items: z.array(logSummary), nextCursor: z.string().nullable() });
export type LogList = z.infer<typeof logList>;

export const logDetail = logSummary.extend({
  /** Redacted query string without the leading `?`. */
  query: z.string().nullable(),
  ip: z.string(),
  reqHeaders: z.record(z.string(), z.string()),
  /** Redacted and truncated; stored only per LOG_BODIES (default: status >= 400). */
  reqBody: z.string().nullable(),
  respBody: z.string().nullable(),
});
export type LogDetail = z.infer<typeof logDetail>;

// Usage and Home
export const usageGroupBy = z.enum(['day', 'key', 'account', 'endpoint']);
export type UsageGroupBy = z.infer<typeof usageGroupBy>;

export const usage = z.object({
  /** One entry per UTC day in the range, zero-filled. `day` is `YYYY-MM-DD`. */
  series: z.array(z.object({ day: z.string(), requests: z.number().int(), errors: z.number().int() })),
  /** `key`: day, key id, account id or endpoint ('' = dashboard / no account). `share` is 0..1 of all requests. */
  rows: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      requests: z.number().int(),
      errors: z.number().int(),
      avgMs: z.number(),
      bytes: z.number(),
      share: z.number(),
    }),
  ),
});
export type Usage = z.infer<typeof usage>;

export const overview = z.object({
  requests24h: z.number().int(),
  requests7d: z.number().int(),
  /** 0..1 share of 24 h requests with status >= 400 */
  errorRate24h: z.number(),
  /** Non-revoked API keys */
  activeKeys: z.number().int(),
  /** Disabled webhook endpoints (manually or by the failure breaker) */
  pausedWebhooks: z.number().int(),
  /** Webhook endpoints that are paused, or enabled with failed deliveries since their last success */
  needsAttention: z.array(
    z.object({ kind: z.literal('webhook'), id: z.string(), url: z.string(), reason: z.enum(['paused', 'failing']) }),
  ),
});
export type Overview = z.infer<typeof overview>;

// Webhooks
/**
 * The event catalogue (plan-v5 §1.12, §2.4): every in-scope event name of the reference API, plus our own
 * `posts.expired`, `webhook.test` and `upstream.*` (every opaque upstream event, as `upstream.<name>`).
 * Each description says whether the event is emitted, TBC (the OF source is known but not mapped yet; until then
 * such frames may arrive as `upstream.<name>`) or never (no source in a self-hosted gateway).
 */
export const webhookEventType = z.enum([
  'messages.received',
  'messages.sent',
  'messages.ppv.unlocked',
  'messages.deleted',
  'messages.liked',
  'messages.unliked',
  'chat_queue.updated',
  'chat_queue.finished',
  'subscriptions.new',
  'subscriptions.renewed',
  'subscriptions.expired',
  'users.typing',
  'users.online',
  'users.offline',
  'posts.liked',
  'posts.expired',
  'tips.received',
  'transactions.new',
  'accounts.connected',
  'accounts.reconnected',
  'accounts.disconnected',
  'accounts.session_expired',
  'accounts.authentication_failed',
  'accounts.otp_code_required',
  'accounts.face_otp_required',
  'media_uploads.completed',
  'media_uploads.failed',
  'webhook.test',
  'upstream.*',
]);
export type WebhookEventType = z.infer<typeof webhookEventType>;
export const webhookEventStatus = z.enum(['emitted', 'tbc', 'never']);
export type WebhookEventStatus = z.infer<typeof webhookEventStatus>;

/** Each type's meaning and whether this gateway emits it: `tbc` = known OF source, not mapped yet; `never` = no source here. */
export const WEBHOOK_EVENTS: Record<WebhookEventType, { description: string; status: WebhookEventStatus }> = {
  'messages.received': { description: 'A connected account received a message', status: 'emitted' },
  'messages.sent': { description: 'A connected account sent a message', status: 'emitted' },
  'messages.ppv.unlocked': { description: 'A fan unlocked a paid message', status: 'tbc' },
  'messages.deleted': { description: "A message in one of the account's chats was deleted", status: 'emitted' },
  'messages.liked': { description: 'A fan liked a message', status: 'tbc' },
  'messages.unliked': { description: 'A fan unliked a message', status: 'tbc' },
  'chat_queue.updated': { description: 'A mass-message queue made progress', status: 'tbc' },
  'chat_queue.finished': { description: 'A mass-message queue finished', status: 'tbc' },
  'subscriptions.new': { description: 'A fan subscribed to a connected account', status: 'tbc' },
  'subscriptions.renewed': { description: 'A fan renewed a subscription', status: 'tbc' },
  'subscriptions.expired': { description: 'A fan subscription expired', status: 'tbc' },
  'users.typing': { description: 'A fan is typing', status: 'tbc' },
  'users.online': { description: 'A fan came online', status: 'tbc' },
  'users.offline': { description: 'A fan went offline', status: 'tbc' },
  'posts.liked': { description: 'A fan liked a post', status: 'tbc' },
  'posts.expired': { description: "A post in the account's feed expired, not only one of its own", status: 'emitted' },
  'tips.received': { description: 'A connected account received a tip', status: 'tbc' },
  'transactions.new': { description: 'A new earnings transaction', status: 'tbc' },
  'accounts.connected': { description: 'An account was connected for the first time', status: 'emitted' },
  'accounts.reconnected': { description: 'An account that already had a session was connected again', status: 'emitted' },
  'accounts.disconnected': { description: 'An account was disconnected', status: 'never' },
  'accounts.session_expired': { description: "A connected account's session expired; reconnect it", status: 'emitted' },
  'accounts.authentication_failed': { description: 'Connecting an account failed', status: 'never' },
  'accounts.otp_code_required': { description: 'Connecting an account needs an OTP code', status: 'never' },
  'accounts.face_otp_required': { description: 'Connecting an account needs a face check', status: 'never' },
  'media_uploads.completed': { description: 'A media upload completed', status: 'never' },
  'media_uploads.failed': { description: 'A media upload failed', status: 'never' },
  'webhook.test': { description: "Sent by the Test action, regardless of the endpoint's event filter", status: 'emitted' },
  'upstream.*': { description: 'Any other upstream event, passed through as upstream.<name>', status: 'emitted' },
};

const STATUS_SUFFIX: Record<WebhookEventStatus, string> = {
  emitted: '',
  tbc: ' (TBC: not emitted yet)',
  never: ' (never emitted by this gateway)',
};

/** The catalogue's served description: the text, then the status unless emitted (`… (TBC: not emitted yet).`). */
export function eventDescription(type: WebhookEventType): string {
  const { description, status } = WEBHOOK_EVENTS[type];
  return `${description}${STATUS_SUFFIX[status]}.`;
}

export const webhookEventList = z.object({
  items: z.array(z.object({ type: webhookEventType, description: z.string(), status: webhookEventStatus })),
});
export type WebhookEventInfo = z.infer<typeof webhookEventList>['items'][number];

export const webhookEndpoint = z.object({
  id: z.string(),
  url: z.string(),
  description: z.string().nullable(),
  /** Empty = every event. */
  events: z.array(z.string()),
  /** `whsec_…`: the HMAC key of the `Signature` header, used as-is. Omitted for read-only keys. */
  secret: z.string().optional(),
  enabled: z.boolean(),
  /** Why the endpoint is disabled: `failures` = paused by the breaker. */
  pausedReason: z.enum(['failures', 'manual']).nullable(),
  consecutiveFailures: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WebhookEndpoint = z.infer<typeof webhookEndpoint>;
export const webhookEndpointList = z.object({ items: z.array(webhookEndpoint) });

const webhookUrl = z.url({ protocol: /^https?$/ }).max(2048);
const webhookDescription = z.string().trim().max(500).nullable();
const webhookEvents = z.array(webhookEventType).max(50);

export const createWebhookBody = z.object({
  url: webhookUrl,
  description: webhookDescription.default(null),
  events: webhookEvents.default([]),
});
export type CreateWebhookBody = z.input<typeof createWebhookBody>;

// No defaults here: an omitted field is left unchanged. `enabled: true` also clears the failure breaker.
export const updateWebhookBody = z.object({
  url: webhookUrl.optional(),
  description: webhookDescription.optional(),
  events: webhookEvents.optional(),
  enabled: z.boolean().optional(),
});
export type UpdateWebhookBody = z.input<typeof updateWebhookBody>;

/** `dropped`: a pending v4 delivery the 2.0 migration cancelled; never sent. */
export const deliveryStatus = z.enum(['pending', 'succeeded', 'failed', 'dropped']);
export type DeliveryStatus = z.infer<typeof deliveryStatus>;

export const webhookDelivery = z.object({
  id: z.string(),
  /** The event's `evt_…` id, sent as `X-OFAPI-Idempotency-Key`: the same on retries and redeliveries. */
  eventId: z.string(),
  endpointId: z.string(),
  eventType: z.string(),
  accountId: z.number().int().nullable(),
  /** The envelope's `payload`. */
  payload: z.unknown(),
  status: deliveryStatus,
  /** Finished attempts. */
  attempts: z.number().int(),
  nextAttemptAt: z.string(),
  lastStatusCode: z.number().int().nullable(),
  lastError: z.string().nullable(),
  lastAttemptAt: z.string().nullable(),
  /** The delivery this one re-sent. */
  replayOf: z.string().nullable(),
  /** False for `dropped` deliveries and 1.x event names: redeliver answers 409. */
  redeliverable: z.boolean(),
  createdAt: z.string(),
});
export type WebhookDelivery = z.infer<typeof webhookDelivery>;
export const webhookDeliveryList = z.object({ items: z.array(webhookDelivery), nextCursor: z.string().nullable() });
export type WebhookDeliveryList = z.infer<typeof webhookDeliveryList>;

/**
 * One event as the bus carries it, and as `GET /api/webhooks/stream` sends it to the dashboard (`event: event`) whether
 * or not an endpoint gets it; `envelope()` from lib/signature.ts turns it into the client wire frame. `ts` is when it
 * happened (ISO 8601).
 */
export type GatewayEvent = { id: string; type: string; accountId: number | null; ts: string; data: unknown };

/** One finished delivery attempt, as `GET /api/webhooks/stream` sends it to the dashboard (`event: delivery`). */
/** A finished delivery attempt: sent (2xx), will be retried, or out of attempts. */
export type AttemptStatus = Exclude<DeliveryStatus, 'dropped'>;

export type DeliveryNotice = {
  deliveryId: string;
  endpointId: string;
  eventType: string;
  url: string;
  description: string | null;
  /** After this attempt: sent (2xx), will be retried, or out of attempts. */
  status: AttemptStatus;
  statusCode: number | null;
  error: string | null;
};

/** One `GET /api/webhooks/stream` frame: its SSE `event:` name and its JSON `data:`. */
export type DashboardFrame = { event: 'event'; data: GatewayEvent } | { event: 'delivery'; data: DeliveryNotice };

// Stats
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

/** `GET /v1/stats`: UTC days, `to` inclusive. Defaults and the range limit are applied by the route. */
export const statsQuery = z.object({
  from: isoDay.optional(),
  to: isoDay.optional(),
  accountId: z.coerce.number().int().positive().optional(),
  /** Comma-separated event types, e.g. `messages.received,tips.received`. */
  types: z.string().optional(),
});
export type StatsQuery = z.input<typeof statsQuery>;

export const stats = z.object({
  /** Sparse: one row per (UTC day, account, type) with at least one event. `amountCents` sums OF's gross amounts. */
  rows: z.array(
    z.object({
      day: z.string(),
      accountId: z.number().int(),
      type: z.string(),
      count: z.number().int(),
      amountCents: z.number().int(),
    }),
  ),
});
export type Stats = z.infer<typeof stats>;
