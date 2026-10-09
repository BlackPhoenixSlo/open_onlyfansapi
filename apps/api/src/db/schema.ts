import { desc, sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { organization, user } from './auth-schema.js';

export * from './auth-schema.js';

/** A workspace that may reach the upstream. Set only by `link-team`. */
export const teamBackend = pgTable('team_backend', {
  teamId: text('team_id')
    .primaryKey()
    .references(() => organization.id, { onDelete: 'cascade' }),
  linkedAt: timestamp('linked_at', { withTimezone: true }).defaultNow().notNull(),
});

export const apiKey = pgTable(
  'api_key',
  {
    id: text('id').primaryKey(),
    teamId: text('team_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    start: text('start').notNull(),
    keyHash: text('key_hash').notNull().unique(),
    scope: text('scope', { enum: ['read', 'write'] }).notNull(),
    allowedAccountIds: integer('allowed_account_ids').array(),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('api_key_team_id_idx').on(t.teamId)],
);

/** One row per authenticated `/v1` request. `id` is the request id (`req_…`, also the `x-request-id` header). */
export const requestLog = pgTable(
  'request_log',
  {
    id: text('id').primaryKey(),
    teamId: text('team_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    /** null = dashboard session */
    apiKeyId: text('api_key_id'),
    userId: text('user_id'),
    accountId: integer('account_id'),
    method: text('method').notNull(),
    path: text('path').notNull(),
    endpoint: text('endpoint').notNull(),
    query: text('query'),
    ip: text('ip').notNull(),
    statusCode: integer('status_code').notNull(),
    durationMs: integer('duration_ms').notNull(),
    reqBytes: integer('req_bytes').notNull(),
    respBytes: integer('resp_bytes').notNull(),
    errorCode: text('error_code'),
    reqHeaders: jsonb('req_headers').$type<Record<string, string>>().notNull(),
    reqBody: text('req_body'),
    respBody: text('resp_body'),
    // Millisecond precision so the (created_at, id) keyset cursor round-trips through a JS Date.
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  },
  (t) => [
    index('request_log_team_created_idx').on(t.teamId, desc(t.createdAt), desc(t.id)),
    index('request_log_team_key_created_idx').on(t.teamId, t.apiKeyId, desc(t.createdAt)),
  ],
);

/** A URL that receives signed event deliveries (`whe_…`). `events` empty = every event. */
export const webhookEndpoint = pgTable('webhook_endpoint', {
  id: text('id').primaryKey(),
  teamId: text('team_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  description: text('description'),
  events: text('events').array().notNull().default(sql`'{}'::text[]`),
  /** `whsec_…`, stored in plaintext: signing needs it. */
  secret: text('secret').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  pausedReason: text('paused_reason', { enum: ['failures', 'manual'] }),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * One event for one endpoint. `event_id` (`evt_…`) is the `X-OFAPI-Idempotency-Key` the receiver dedups on: a retry
 * and a redelivery keep it, while a redelivery gets a new `whd_` id.
 */
export const webhookDelivery = pgTable(
  'webhook_delivery',
  {
    id: text('id').primaryKey(),
    teamId: text('team_id').notNull(),
    endpointId: text('endpoint_id')
      .notNull()
      .references(() => webhookEndpoint.id, { onDelete: 'cascade' }),
    eventId: text('event_id').notNull(),
    eventType: text('event_type').notNull(),
    accountId: integer('account_id'),
    payload: jsonb('payload').$type<unknown>().notNull(),
    /** `dropped`: a pending v4 delivery cancelled by the 2.0 migration (plan-v5 §2.4); never sent. */
    status: text('status', { enum: ['pending', 'succeeded', 'failed', 'dropped'] }).notNull().default('pending'),
    /** Completed attempts (incremented when a POST finishes, not when it is claimed). */
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
    lastStatusCode: integer('last_status_code'),
    lastError: text('last_error'),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    /** The delivery this one re-sends. */
    replayOf: text('replay_of'),
    /** Upstream event dedup (event source, after v1.0). */
    dedupKey: text('dedup_key'),
    // Millisecond precision so the (created_at, id) keyset cursor round-trips through a JS Date.
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  },
  (t) => [
    index('webhook_delivery_due_idx').on(t.nextAttemptAt).where(sql`${t.status} = 'pending'`),
    index('webhook_delivery_endpoint_created_idx').on(t.endpointId, desc(t.createdAt)),
    uniqueIndex('webhook_delivery_endpoint_dedup_idx').on(t.endpointId, t.dedupKey).where(sql`${t.dedupKey} is not null`),
  ],
);

/**
 * The event ledger (`evt_…`): one row per upstream event of a stored type (the catalogue minus `webhook.test` and
 * `upstream.*`). No payload, no team id: it feeds `/v1/stats`. `created_at` is the event's time (the frame's `ts`).
 */
export const event = pgTable(
  'event',
  {
    id: text('id').primaryKey(),
    accountId: integer('account_id').notNull(),
    type: text('type').notNull(),
    amountCents: integer('amount_cents'),
    /** The frame's `id`; null = not deduplicated. */
    dedupKey: text('dedup_key'),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  },
  (t) => [
    index('event_created_idx').on(t.createdAt),
    uniqueIndex('event_dedup_idx').on(t.dedupKey).where(sql`${t.dedupKey} is not null`),
  ],
);

// Analytics store (docs/spec/future-client-story-ask.md §4.3), filled by the backfill; live message events also write
// `message_fact`. Every row carries the workspace that owns its account, and every query filters on it. OF ids are
// bigint: message ids pass int4.

const analyticsTeamId = () =>
  text('team_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' });
const analyticsAt = (name: string) => timestamp(name, { withTimezone: true, precision: 3 });

/** Which workspace an account belongs to (§4.1); one workspace per account. */
export const accountWorkspace = pgTable('account_workspace', {
  accountId: integer('account_id').primaryKey(),
  teamId: analyticsTeamId(),
  /**
   * The start of the newest stored backfill that ran to its end and read up to now (its `to` not before its start;
   * chats are walked over hours, so the next window overlaps by 1 h); never moves back.
   */
  refreshedAt: analyticsAt('refreshed_at'),
});

/** One OF chat message as fetched, with columns derived from `raw` (§2): rebuilt from `raw`, never re-scraped. */
export const messageFact = pgTable(
  'message_fact',
  {
    teamId: analyticsTeamId(),
    accountId: integer('account_id').notNull(),
    messageId: bigint('message_id', { mode: 'number' }).notNull(),
    /** The fan's user id (OF's chat id). */
    chatId: bigint('chat_id', { mode: 'number' }).notNull(),
    direction: text('direction', { enum: ['inbound', 'outbound'] }).notNull(),
    createdAt: analyticsAt('created_at').notNull(),
    isMass: boolean('is_mass').notNull(),
    queueId: bigint('queue_id', { mode: 'number' }),
    isAutomated: boolean('is_automated').notNull(),
    automatedReason: text('automated_reason', { enum: ['welcome', 'automation'] }),
    priceCents: integer('price_cents').notNull(),
    isTip: boolean('is_tip').notNull(),
    /** `tipAmount` in cents on a tip, else 0. */
    tipCents: integer('tip_cents').notNull(),
    /** OF's `isOpened`: on a priced message, the fan bought it. */
    isOpened: boolean('is_opened').notNull(),
    mediaCount: integer('media_count').notNull(),
    /** Sorted media ids, comma-joined; null = no media. */
    mediaKey: text('media_key'),
    /** The script hash (§4.4): outbound only; null for inbound or text the normaliser finds not eligible. */
    textHash: text('text_hash'),
    /** The normaliser version behind `text_hash`; set on outbound rows, null on inbound. */
    normaliserVersion: integer('normaliser_version'),
    raw: jsonb('raw').$type<Record<string, unknown>>().notNull(),
    fetchedAt: analyticsAt('fetched_at').notNull(),
    /** When a `messages.deleted` event (an unsend) marked the message; null = not deleted. A backfill that re-reads it clears it. */
    deletedAt: analyticsAt('deleted_at'),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.messageId] }),
    index('message_fact_team_account_chat_idx').on(t.teamId, t.accountId, t.chatId, t.createdAt),
  ],
);

/** How far back a chat's message walk reached; `reached_start` = it hit the chat's first message. */
export const chatCoverage = pgTable(
  'chat_coverage',
  {
    teamId: analyticsTeamId(),
    accountId: integer('account_id').notNull(),
    chatId: bigint('chat_id', { mode: 'number' }).notNull(),
    /** The fan's username as the chat list or a message names it; null = not seen. */
    fanUsername: text('fan_username'),
    /** The fan's name and custom name (OF's `displayName`) as the chat list names them; null = not seen. */
    fanName: text('fan_name'),
    fanCustomName: text('fan_custom_name'),
    oldestMessageId: bigint('oldest_message_id', { mode: 'number' }),
    oldestAt: analyticsAt('oldest_at'),
    reachedStart: boolean('reached_start').notNull(),
    walkedAt: analyticsAt('walked_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.chatId] })],
);

/** One OF transaction: the only source of money and purchase time. */
export const purchaseFact = pgTable(
  'purchase_fact',
  {
    teamId: analyticsTeamId(),
    accountId: integer('account_id').notNull(),
    txId: text('tx_id').notNull(),
    fanId: bigint('fan_id', { mode: 'number' }),
    /** `field` = the transaction's `user.id`; `description` = parsed from its description link; null = unknown. */
    fanIdSource: text('fan_id_source', { enum: ['field', 'description'] }),
    kind: text('kind'),
    grossCents: integer('gross_cents'),
    netCents: integer('net_cents'),
    currency: text('currency'),
    createdAt: analyticsAt('created_at').notNull(),
    raw: jsonb('raw').$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.txId] }),
    index('purchase_fact_team_account_created_idx').on(t.teamId, t.accountId, t.createdAt),
  ],
);

/**
 * A script candidate (§4.3, §4.4): a DM text hash sent 5+ times in 3+ chats within 30 days on one of the
 * workspace's accounts. Auto-detected only; exact variants and counts are read from `message_fact`.
 */
export const script = pgTable(
  'script',
  {
    teamId: analyticsTeamId(),
    hash: text('hash').notNull(),
    origin: text('origin', { enum: ['auto'] }).notNull().default('auto'),
    /** The normaliser version `hash` was found with; only rows of the current version are read. */
    normaliserVersion: integer('normaliser_version').notNull(),
  },
  (t) => [primaryKey({ columns: [t.teamId, t.hash] })],
);

/**
 * A workspace's stats windows (§4.5), in seconds, and the timezone of day and hour buckets. One row per workspace,
 * made with the defaults on first read; every change bumps `version`, which results cite.
 */
export const statsConfig = pgTable('stats_config', {
  teamId: text('team_id')
    .primaryKey()
    .references(() => organization.id, { onDelete: 'cascade' }),
  version: integer('version').notNull().default(1),
  replyCapSeconds: integer('reply_cap_seconds').notNull().default(12 * 3600),
  slaSeconds: integer('sla_seconds').notNull().default(15 * 60),
  minReplyChars: integer('min_reply_chars').notNull().default(15),
  openGapSeconds: integer('open_gap_seconds').notNull().default(7 * 86400),
  openReplySeconds: integer('open_reply_seconds').notNull().default(24 * 3600),
  convertSeconds: integer('convert_seconds').notNull().default(72 * 3600),
  timezone: text('timezone').notNull().default('UTC'),
  updatedAt: analyticsAt('updated_at').defaultNow().notNull(),
});
