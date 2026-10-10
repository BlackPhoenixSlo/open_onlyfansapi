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

/**
 * `PATCH /api/accounts/:id` (dashboard only): an omitted field is left unchanged. `proxy`: `{ label }` moves the account
 * onto an existing proxy, `{ url }` (`scheme://[user:pass@]host:port`, checked by the upstream) stores a new one for it,
 * `null` unbinds it. `DELETE /api/accounts/:id` (dashboard only, no body) disconnects the account upstream: 204, or
 * 404 `account_not_found`.
 */
export const updateAccountBody = z.object({
  label: z.string().trim().min(1).max(100).optional(),
  proxy: z
    .union([z.strictObject({ label: z.string().min(1).max(128) }), z.strictObject({ url: z.string().trim().min(1).max(2048) })])
    .nullable()
    .optional(),
});
export type UpdateAccountBody = z.infer<typeof updateAccountBody>;

/** A proxy label: one path segment (no `/`, no leading `.`, so never `.` or `..`). */
export const proxyLabel = z.string().min(1).max(200).regex(/^[^/.][^/]*$/, 'No "/" and no leading "."');

/**
 * `POST /api/proxies` (dashboard only): a proxy bound to no account. `acct-<id>` labels are reserved for per-account
 * proxies; `url` is `scheme://[user:pass@]host:port`, checked by the upstream.
 */
export const createProxyBody = z.object({
  label: proxyLabel.refine((l) => !/^acct-\d+$/.test(l), 'acct-<id> labels are reserved for per-account proxies'),
  url: z.string().trim().min(1).max(2048),
});
export type CreateProxyBody = z.infer<typeof createProxyBody>;

/**
 * A proxy in the upstream's registry (`GET /api/proxies`, dashboard only); never its credentials. `stats` count the OF
 * calls made through it since `since` (the upstream's start: they reset when it restarts).
 */
export const proxy = z.object({
  label: z.string(),
  scheme: z.string(),
  host: z.string().nullable(),
  port: z.number().int().nullable(),
  assignedAccountIds: z.array(z.number().int()),
  verifiedIp: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  verifiedGeo: z.string().nullable(),
  /** Whether the last Test reached onlyfans.com through the proxy (null: not checked); `ofError` says why not. */
  ofReachable: z.boolean().nullable(),
  ofError: z.string().nullable(),
  /** `failed` counts calls that still failed after their retries; `blocked` the responses OF answered 403 or 429. */
  stats: z.object({
    ok: z.number().int(),
    failed: z.number().int(),
    blocked: z.number().int(),
    lastOkAt: z.string().nullable(),
    lastError: z.string().nullable(),
    lastErrorAt: z.string().nullable(),
    lastUsedAt: z.string().nullable(),
  }),
  since: z.string(),
});
export type ProxyInfo = z.infer<typeof proxy>;
export const proxyList = z.object({ items: z.array(proxy) });

export const whoami = z.object({
  team: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    /** Whether this workspace is linked to the upstream (at sign-up, or by `link-team <slug>`). */
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
  'chat_queue.finished': { description: 'A mass-message queue finished', status: 'emitted' },
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

// Stats metrics (docs/spec/future-client-story-ask.md §4.6): fan-turn reply time and reply SLA, and openers, from the analytics store.
export const statsGroupBy = z.enum(['day', 'hour', 'account']);
export type StatsGroupBy = z.infer<typeof statsGroupBy>;

/** A stats window or the timezone (§4.5). Windows are seconds. */
const windowSeconds = z.number().int().min(1).max(90 * 86_400);

export const statsConfig = z.object({
  /** Bumped on every change; results cite it. */
  version: z.number().int(),
  replyCapSeconds: z.number().int(),
  slaSeconds: z.number().int(),
  minReplyChars: z.number().int(),
  openGapSeconds: z.number().int(),
  openReplySeconds: z.number().int(),
  convertSeconds: z.number().int(),
  /** IANA name; day and hour buckets and `from`/`to` days are in it. */
  timezone: z.string(),
  updatedAt: z.string(),
});
export type StatsConfig = z.infer<typeof statsConfig>;
export const statsConfigResponse = z.object({ config: statsConfig });
/** How fresh the stats are (docs/analytics.md, Live updates). Times are ISO; null = none yet. */
export const statsFreshness = z.object({
  /** The newest `messages.received` / `messages.sent` event for the workspace's claimed accounts. */
  lastLiveAt: z.string().nullable(),
  /** Message events in the last 24 hours. */
  liveEvents24h: z.number().int(),
  /** The newest `refreshed_at` of those accounts: the start of the newest backfill that read up to now (null = none has ended since migration 0015). */
  lastRefreshAt: z.string().nullable(),
  /** The next daily refresh time (`STATS_REFRESH_HOUR_UTC`:00 UTC); null when the refresh is off. */
  nextRefreshAt: z.string().nullable(),
});
export type StatsFreshness = z.infer<typeof statsFreshness>;
/** `GET /v1/stats/config`: the config and the stats' freshness. */
export const statsConfigGetResponse = statsConfigResponse.extend({ freshness: statsFreshness });

/** `POST /v1/stats/backfill`: claim the account for the workspace and backfill the last `days` days in the background. */
export const statsBackfillBody = z.object({
  accountId: z.number().int().positive(),
  days: z.number().int().min(1).max(366).default(30),
});
export const statsBackfillStarted = z.object({ runId: z.string() });
export const statsBackfillQuery = z.object({ accountId: z.coerce.number().int().positive() });
/** `GET /v1/stats/backfill`: the account's last dashboard run since the API started, or `idle`. Times are ISO. */
export const statsBackfillRun = z.union([
  z.object({ status: z.literal('idle') }),
  z.object({
    status: z.enum(['queued', 'running', 'done', 'error']),
    runId: z.string(),
    accountId: z.number().int(),
    from: z.string(),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
    /** Upstream requests made, 429s and retries included. */
    requests: z.number().int(),
    /** Retries after a transient upstream failure (502, 503, 504 or a network error). */
    retries: z.number().int(),
    /** Chats walked. */
    chats: z.number().int(),
    /** Messages stored. */
    messages: z.number().int(),
    /** Chats skipped after a 4xx; 5 in a row end the run as `session_expired`. */
    failedChats: z.number().int(),
    error: z.string().nullable(),
    /** `session_expired`: OF answered 401, or 5 chats in a row failed, so the account must be re-connected before a run can work. */
    errorCode: z.enum(['session_expired']).nullable(),
  }),
]);
export type StatsBackfillRun = z.infer<typeof statsBackfillRun>;

/** `PUT /v1/stats/config`: only the given fields change. */
export const putStatsConfigBody = z.object({
  replyCapSeconds: windowSeconds.optional(),
  slaSeconds: windowSeconds.optional(),
  minReplyChars: z.number().int().min(0).max(10_000).optional(),
  openGapSeconds: windowSeconds.optional(),
  openReplySeconds: windowSeconds.optional(),
  convertSeconds: windowSeconds.optional(),
  timezone: z.string().min(1).max(64).optional(),
});
export type PutStatsConfigBody = z.input<typeof putStatsConfigBody>;

export const statsMetric = z.object({
  id: z.string(),
  name: z.string(),
  /** The formula in words. */
  description: z.string(),
  unit: z.enum(['seconds', 'percent', 'count']),
  groupings: z.array(statsGroupBy),
  /** The config windows it reads. */
  windows: z.array(z.string()),
  /** Checked by hand against OF and the Infloww diff (spec §6 step 0). */
  verified: z.boolean(),
});
export type StatsMetric = z.infer<typeof statsMetric>;
export const statsMetricList = z.object({ items: z.array(statsMetric) });

/** `from`/`to` are days in the config timezone, `to` inclusive; default the last 30 days. */
export const statsMetricQuery = z.object({
  from: isoDay.optional(),
  to: isoDay.optional(),
  accountId: z.coerce.number().int().positive().optional(),
  groupBy: statsGroupBy.default('day'),
  format: z.enum(['json', 'csv']).default('json'),
});
export type StatsMetricQuery = z.input<typeof statsMetricQuery>;

/** Reply-time metrics carry the turn counts, opener metrics the opener counts. */
export const statsMetricRow = z.object({
  /** `YYYY-MM-DD` (day), `00`–`23` (hour of day of the turn start or opener send) or the account id. */
  group: z.string(),
  /** null when no turn or opener qualifies. */
  value: z.number().nullable(),
  /** Turns or openers behind `value`. */
  n: z.number().int(),
  /** Fan turns starting in the group, by status. */
  turns: z.number().int().optional(),
  inCap: z.number().int().optional(),
  late: z.number().int().optional(),
  breached: z.number().int().optional(),
  /** Turns (cap not elapsed) or openers (`open_reply` not elapsed) still open at `asOf`. */
  pending: z.number().int(),
  /** Turns replied within `sla`. */
  slaMet: z.number().int().optional(),
  /** Openers sent in the group, by kind and by fan reply. */
  openers: z.number().int().optional(),
  firstEver: z.number().int().optional(),
  reactivation: z.number().int().optional(),
  unknownKind: z.number().int().optional(),
  replied: z.number().int().optional(),
  noReply: z.number().int().optional(),
  /** Openers whose open_gap held mass or automated messages (that did not reset it). */
  massOrAutomatedGap: z.number().int().optional(),
});
export type StatsMetricRow = z.infer<typeof statsMetricRow>;

/** A stats response over a range of days: the config timezone and version it used, when, and its `from`/`to` days. */
const statsWindow = { timezone: z.string(), configVersion: z.number().int(), asOf: z.string(), from: z.string(), to: z.string() };

export const statsMetricSeries = z.object({
  metric: z.string(),
  ...statsWindow,
  groupBy: statsGroupBy,
  /** Sparse: groups with at least one turn. */
  rows: z.array(statsMetricRow),
});
export type StatsMetricSeries = z.infer<typeof statsMetricSeries>;

export const statsSamplesQuery = statsMetricQuery.omit({ format: true }).extend({
  /** Only turns in this group of `groupBy` (a row's `group`). */
  group: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(20).default(20),
});
export type StatsSamplesQuery = z.input<typeof statsSamplesQuery>;

/** One fan turn behind a number; `chatId` is the fan's user id, so the chat opens in OF. */
export const statsSample = z.object({
  accountId: z.number().int(),
  chatId: z.number().int(),
  fanMessageId: z.number().int(),
  fanAt: z.string(),
  lastFanMessageId: z.number().int(),
  lastFanAt: z.string(),
  replyMessageId: z.number().int().nullable(),
  replyAt: z.string().nullable(),
  /** From the first fan message; null while open. */
  waitSeconds: z.number().nullable(),
  /** From the last fan message before the reply; null while open. */
  waitFromLastSeconds: z.number().nullable(),
  status: z.enum(['in_cap', 'late', 'breached', 'pending']),
  slaMet: z.boolean(),
});
export type StatsSample = z.infer<typeof statsSample>;

/** One opener behind a number. */
export const statsOpenerSample = z.object({
  accountId: z.number().int(),
  chatId: z.number().int(),
  openerMessageId: z.number().int(),
  sentAt: z.string(),
  kind: z.enum(['first_ever', 'reactivation', 'unknown']),
  /** The last DM before it (a reactivation); null when none is stored. A fan message there makes the DM a reply, not an opener. */
  previousMessageId: z.number().int().nullable(),
  previousAt: z.string().nullable(),
  /** `sentAt - previousAt`; null when none is stored. */
  gapSeconds: z.number().nullable(),
  /** Mass and automated messages in the gap; they do not reset it. */
  massOrAutomatedInGap: z.number().int(),
  /** The fan's first message after it, within `open_reply` or not (of `min_reply_chars`+ for a substantive metric); null when none. */
  fanReplyMessageId: z.number().int().nullable(),
  fanReplyAt: z.string().nullable(),
  fanReplySeconds: z.number().nullable(),
  status: z.enum(['replied', 'no_reply', 'pending']),
});
export type StatsOpenerSample = z.infer<typeof statsOpenerSample>;
export const statsSamples = z.object({ metric: z.string(), ...statsWindow, items: z.array(z.union([statsSample, statsOpenerSample])) });
export type StatsSamples = z.infer<typeof statsSamples>;

/** `GET /v1/stats/scripts`: `from`/`to` days in the config timezone, `to` inclusive; default the last 30 days. */
export const statsScriptsQuery = z.object({
  from: isoDay.optional(),
  to: isoDay.optional(),
  accountId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type StatsScriptsQuery = z.input<typeof statsScriptsQuery>;

/**
 * A script candidate (spec §4.4) with its sends in the range. Reply counts are per outbound sequence holding a send:
 * replied within `open_reply` after its last DM, no reply, or pending (the window has not elapsed). Rates are
 * percent of the decided sequences; null when none. The substantive variant counts only a fan message of
 * `min_reply_chars`+.
 */
export const statsScript = z.object({
  /** SHA-256 of the normalised text, 16 hex. */
  hash: z.string(),
  origin: z.enum(['auto']),
  sends: z.number().int(),
  /** Distinct chats it was sent in. */
  chats: z.number().int(),
  /**
   * Sends and distinct chats over all stored DM sends of the hash over the accounts in scope (the same population
   * script detection reads), in range or not; a key limited to some accounts may see fewer.
   */
  sendsAll: z.number().int(),
  chatsAll: z.number().int(),
  firstSentAt: z.string(),
  lastSentAt: z.string(),
  sequences: z.number().int(),
  replied: z.number().int(),
  noReply: z.number().int(),
  pending: z.number().int(),
  replyRate: z.number().nullable(),
  substantiveReplied: z.number().int(),
  substantiveNoReply: z.number().int(),
  substantivePending: z.number().int(),
  substantiveReplyRate: z.number().nullable(),
  /** Distinct exact (raw) texts sent. */
  variantCount: z.number().int(),
  /** Up to 5 exact texts, most sent first. */
  variants: z.array(z.object({ text: z.string(), count: z.number().int() })),
});
export type StatsScript = z.infer<typeof statsScript>;

export const statsScripts = z.object({
  ...statsWindow,
  normaliserVersion: z.number().int(),
  /** Most sent first; scripts with no send in the range are left out. */
  items: z.array(statsScript),
});
export type StatsScripts = z.infer<typeof statsScripts>;

/** `GET /v1/stats/fans`: `from`/`to` days in the config timezone, `to` inclusive; default the last 30 days. */
export const statsFansQuery = z.object({
  from: isoDay.optional(),
  to: isoDay.optional(),
  accountId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  /** Keeps the fans whose username, name, custom name or chat id contains it (any case; trimmed, a leading `@` dropped); empty = all. */
  search: z.string().max(200).optional(),
});
export type StatsFansQuery = z.input<typeof statsFansQuery>;

/**
 * One fan (chat) with a stored message in the range, or a payer of the range without one (counts 0, times null); the
 * counts split the range's messages, so they sum to all of them. Times are ISO; money is booked sales (as
 * `GET /v1/stats/revenue`), in cents.
 */
export const statsFan = z.object({
  accountId: z.number().int(),
  /** The fan's user id (OF's chat id). */
  chatId: z.number().int(),
  /** From the chat list; null when not seen. On a payer row without a message in the range, from the transaction (below). */
  fanUsername: z.string().nullable(),
  /** The fan's name from the chat list, else OF's `user.name` on the fan's newest booked transaction in the range with a name; null when neither has one. */
  name: z.string().nullable(),
  fanMessages: z.number().int(),
  /** Outbound, not mass, not automated. */
  dmMessages: z.number().int(),
  massMessages: z.number().int(),
  /** Outbound, automated, not mass. */
  automatedMessages: z.number().int(),
  /** PPVs sent: outbound, not mass, priced. */
  ppvSent: z.number().int(),
  /** Of `ppvSent`, those the fan bought (OF's `isOpened`). */
  ppvOpened: z.number().int(),
  /** The fan's tip messages. */
  tips: z.number().int(),
  /** Their amounts (OF's `tipAmount`), in cents. */
  tipCents: z.number().int(),
  /** Null on a payer without a message in the range. */
  firstAt: z.string().nullable(),
  lastAt: z.string().nullable(),
  /** The fan's newest message in the range; null when the fan wrote nothing in it. */
  lastFanAt: z.string().nullable(),
  /** The fan's booked gross in the range. */
  gross: z.number().int(),
  /** The fan's booked gross over every stored transaction. */
  grossAllTime: z.number().int(),
  /** OF's `user.isDeleted` on the fan's newest booked transaction in the range with a name (else the newest in the range), as in `GET /v1/stats/revenue`: the fan deleted their OF account. False with none. */
  isDeleted: z.boolean(),
  /** A message of the fan's chat is stored, any time (a payer row can have one outside the range). */
  hasChat: z.boolean(),
});
export type StatsFan = z.infer<typeof statsFan>;

export const statsFans = z.object({
  ...statsWindow,
  /** Fans in scope before `limit`; more than `items` when the list is cut. */
  total: z.number().int(),
  /** Most gross in the range first, then latest fan message (fans who wrote nothing last), then latest message. */
  items: z.array(statsFan),
});
export type StatsFans = z.infer<typeof statsFans>;

/**
 * `GET /v1/stats/messages`: the stored messages, `direction=in` for the fans' messages only. `limit` and `cursor` page
 * JSON only; CSV holds the whole range.
 */
export const statsMessagesQuery = z.object({
  from: isoDay.optional(),
  to: isoDay.optional(),
  accountId: z.coerce.number().int().positive().optional(),
  chatId: z.coerce.number().int().positive().optional(),
  direction: z.enum(['in', 'out', 'all']).default('all'),
  format: z.enum(['json', 'csv']).default('json'),
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
  /** The previous page's `nextCursor`: continue after its last message. */
  cursor: z.string().optional(),
});
export type StatsMessagesQuery = z.input<typeof statsMessagesQuery>;

export const statsMessage = z.object({
  accountId: z.number().int(),
  chatId: z.number().int(),
  fanUsername: z.string().nullable(),
  messageId: z.number().int(),
  createdAt: z.string(),
  direction: z.enum(['inbound', 'outbound']),
  /** The message as plain text (tags stripped, HTML unescaped, whitespace collapsed); empty when it has none. */
  text: z.string(),
  priceCents: z.number().int(),
  /** OF's `isFree`. */
  isFree: z.boolean(),
  /** OF's `isOpened`: on a priced message, the fan bought it. */
  isOpened: z.boolean(),
  isTip: z.boolean(),
  /** The tip's amount (OF's `tipAmount`) in cents; 0 when not a tip. */
  tipCents: z.number().int(),
  /** All media (OF's `mediaCount`). */
  mediaCount: z.number().int(),
  /** Media by type; `gifs` also counts a GIPHY gif, which is not in `mediaCount`. */
  photos: z.number().int(),
  videos: z.number().int(),
  gifs: z.number().int(),
  audios: z.number().int(),
  /** Some media is shown free before purchase (OF's `previews`). */
  hasPreview: z.boolean(),
  isMass: z.boolean(),
  isAutomated: z.boolean(),
  /** Why `isAutomated`: the welcome message or a known automation's text; null when not automated. */
  automatedReason: z.enum(['welcome', 'automation']).nullable(),
  /** Replies to another message (OF's `replyToMessage`). */
  isReply: z.boolean(),
  /** OF's `isLiked`: the other side liked it. */
  isLiked: z.boolean(),
  /** When an unsend (`messages.deleted`) marked it; null = not deleted. */
  deletedAt: z.string().nullable(),
});
export type StatsMessage = z.infer<typeof statsMessage>;

export const statsMessages = z.object({
  ...statsWindow,
  /** `limit` cut the list: more messages match. Always `nextCursor !== null`; kept for compatibility. */
  truncated: z.boolean(),
  /** Pass as `cursor` for the next page; null when nothing is cut. */
  nextCursor: z.string().nullable(),
  /** By account, chat, time and message id. */
  items: z.array(statsMessage),
});
export type StatsMessages = z.infer<typeof statsMessages>;

/** `GET /v1/stats/revenue`: `from`/`to` days in the config timezone, `to` inclusive; default the last 30 days. */
export const statsRevenueQuery = z.object({
  from: isoDay.optional(),
  to: isoDay.optional(),
  accountId: z.coerce.number().int().positive().optional(),
});
export type StatsRevenueQuery = z.input<typeof statsRevenueQuery>;

/** Money sums in cents: OF's `amount` (gross) and `net` per transaction, a missing one counted as 0. */
const revenueSums = { gross: z.number().int(), net: z.number().int(), transactions: z.number().int() };

/**
 * Revenue from the stored booked transactions (`purchase_fact`, all USD; OF's status `done` or `loading`, so a refund
 * or reversal, `undo` or `pending_return`, is left out) and PPV sends (`message_fact`). Rates are percent; null when
 * nothing to divide by.
 */
export const statsRevenue = z.object({
  ...statsWindow,
  totals: z.object({
    ...revenueSums,
    /** The part of `gross` OF has settled (status `done`). */
    settledGross: z.number().int(),
    /** The part of `gross` OF still holds (status `loading`). */
    pendingGross: z.number().int(),
    /** Fans with a transaction in the range whose fan is known; per account (a fan paying on two accounts counts twice). */
    payers: z.number().int(),
    /** Fans (chats) with a message in the range that is not unsent, either direction; per account, on accounts with a booked transaction in the range only. */
    fansMessaged: z.number().int(),
    /** Fan CVR, `payers / fansMessaged`, in percent (can pass 100: a payer need not have been messaged). */
    fanCvr: z.number().nullable(),
    /** DMs sent: outbound, not mass, not automated (welcome message or automation); unsent ones included. */
    dmMessages: z.number().int(),
    /** The priced ones of `dmMessages`. */
    dmPpvs: z.number().int(),
    /** Infloww's golden ratio, `dmPpvs / dmMessages`, in percent. */
    goldenRatio: z.number().nullable(),
  }),
  /** OF's transaction type (`message`, `tips`, `subscription`, `subscription_prolong`, `post`, ...; `unknown` when absent), most gross first. */
  byKind: z.array(z.object({ kind: z.string(), ...revenueSums })),
  /** Every day of the range in the config timezone, zeros included. */
  byDay: z.array(z.object({ day: z.string(), ...revenueSums })),
  /** PPV DMs: priced outbound messages, not mass, unsent and automated ones included; `opened` = OF's `isOpened` (bought); `rate` = opened / sent in percent. */
  ppv: z.object({ sent: z.number().int(), opened: z.number().int(), rate: z.number().nullable() }),
  /**
   * Up to 50 (account, fan) pairs, most gross first, named as in `GET /v1/stats/fans`: `name` is OF's display name (else
   * username) on the fan's newest transaction in the range that has one; `lastAt` is the newest transaction, ISO.
   */
  topPayers: z.array(
    statsFan.pick({ accountId: true, chatId: true, name: true, isDeleted: true, hasChat: true }).extend({ ...revenueSums, lastAt: z.string() }),
  ),
  /** All payers of the range (not only the top 50) with no stored chat (`hasChat` false), and their gross. */
  withoutChat: z.object({ payers: z.number().int(), gross: z.number().int() }),
});
export type StatsRevenue = z.infer<typeof statsRevenue>;
