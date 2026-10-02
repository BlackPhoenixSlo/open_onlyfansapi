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
/** The event catalogue. `upstream.*` subscribes to every opaque upstream event (`upstream.<name>`). */
export const webhookEventType = z.enum(['message.received', 'account.session_expired', 'webhook.test', 'upstream.*']);
export type WebhookEventType = z.infer<typeof webhookEventType>;
export const WEBHOOK_EVENTS: Record<WebhookEventType, string> = {
  'message.received': 'A connected account received a message.',
  'account.session_expired': "A connected account's session expired; reconnect it.",
  'webhook.test': "Sent by the test route; delivered whatever the endpoint's events filter says.",
  'upstream.*': 'Any other upstream event, passed through as `upstream.<name>`.',
};
export const webhookEventList = z.object({ items: z.array(z.object({ type: webhookEventType, description: z.string() })) });

export const webhookEndpoint = z.object({
  id: z.string(),
  url: z.string(),
  description: z.string().nullable(),
  /** Empty = every event. */
  events: z.array(z.string()),
  /** `whsec_…`: verify deliveries with it (Standard Webhooks). Omitted for read-only keys. */
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

export const deliveryStatus = z.enum(['pending', 'succeeded', 'failed']);
export type DeliveryStatus = z.infer<typeof deliveryStatus>;

export const webhookDelivery = z.object({
  /** Also the `webhook-id` header. */
  id: z.string(),
  endpointId: z.string(),
  eventType: z.string(),
  accountId: z.number().int().nullable(),
  /** The envelope's `data`. */
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
  createdAt: z.string(),
});
export type WebhookDelivery = z.infer<typeof webhookDelivery>;
export const webhookDeliveryList = z.object({ items: z.array(webhookDelivery), nextCursor: z.string().nullable() });
export type WebhookDeliveryList = z.infer<typeof webhookDeliveryList>;
