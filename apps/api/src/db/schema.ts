import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
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
