import { desc } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { organization, user } from './auth-schema.js';

export * from './auth-schema.js';

/** Link from a workspace to the backend owner user whose accounts it may use. Set only by `link-team`. */
export const teamBackend = pgTable('team_backend', {
  teamId: text('team_id')
    .primaryKey()
    .references(() => organization.id, { onDelete: 'cascade' }),
  backendUserId: integer('backend_user_id').notNull(),
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
