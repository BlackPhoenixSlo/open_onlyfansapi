import type { FastifyBaseLogger } from 'fastify';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { accountWorkspace, chatCoverage, messageFact } from '../../db/schema.js';
import { deriveContext, deriveMessage, fanNames, type Raw } from './derive.js';

// Live updates (docs/analytics.md): upstream message events write `message_fact` between backfills. Scripts and
// `chat_coverage` are backfill-only.

/** The event types that count as live message events (freshness). */
export const LIVE_MESSAGE_TYPES = ['messages.received', 'messages.sent'] as const;

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isSafeInteger(n) ? n : null;
};
const userId = (user: unknown) => num((user as Raw | null | undefined)?.id);
/** The driver's cause only: drizzle's own error message embeds the query parameters (fan message text). */
const cause = (err: unknown) => (err instanceof Error && err.cause instanceof Error ? err.cause : err);

/**
 * The `message_fact` row of one live OF message object, derived by the backfill's `deriveMessage`; null when the
 * payload is not a message, names no fan (an outbound message needs `toUser` or OF's `chatUserId`) or has no valid
 * time. The live context has no mass history, welcome message or automation texts: an outbound message with a
 * `queueId` counts as mass and none as automated until a backfill over its range re-derives the row. The fan's names
 * for the script hash come from `chat_coverage`, as the backfill's come from the chat list.
 */
async function liveRow(teamId: string, accountId: number, payload: unknown) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const { fanData: _fanData, ...raw } = payload as Raw; // `fanData` is the upstream's own, not OF's
  const outbound = userId(raw.fromUser) === accountId;
  const chatId = outbound ? (userId(raw.toUser) ?? num(raw.chatUserId)) : userId(raw.fromUser);
  if (chatId === null) return null;
  const queueId = num(raw.queueId);
  const ctx = deriveContext(accountId, queueId !== null ? [{ id: queueId, sentCount: 2 }] : [], null, []);
  let names: string[] = [];
  if (outbound) {
    const [cov] = await db
      .select({ name: chatCoverage.fanName, username: chatCoverage.fanUsername, displayName: chatCoverage.fanCustomName })
      .from(chatCoverage)
      .where(and(eq(chatCoverage.accountId, accountId), eq(chatCoverage.chatId, chatId)));
    names = fanNames(cov);
  }
  const d = deriveMessage(raw, chatId, ctx, names);
  if (!d || Number.isNaN(d.createdAt.getTime())) return null;
  return { teamId, accountId, ...d, raw, fetchedAt: new Date() };
}

/**
 * Applies one ingested event to the analytics store when its account is claimed (`account_workspace`); otherwise
 * does nothing. `messages.received` / `messages.sent` insert the message's row on the backfill's key
 * `(account_id, message_id)`; a row already there (the backfill read it with full context) is kept. `messages.deleted`
 * removes the row. Never throws: a failure is logged once with the event id.
 */
export async function applyLiveEvent(eventId: string, type: string, accountId: number, payload: unknown, log: FastifyBaseLogger): Promise<void> {
  const deleted = type === 'messages.deleted';
  if (!deleted && !(LIVE_MESSAGE_TYPES as readonly string[]).includes(type)) return;
  try {
    const [owner] = await db.select({ teamId: accountWorkspace.teamId }).from(accountWorkspace).where(eq(accountWorkspace.accountId, accountId));
    if (!owner) return;
    if (deleted) {
      const messageId = num((payload as Raw | null)?.id);
      if (messageId === null) return;
      await db
        .delete(messageFact)
        .where(and(eq(messageFact.teamId, owner.teamId), eq(messageFact.accountId, accountId), eq(messageFact.messageId, messageId)));
      return;
    }
    const row = await liveRow(owner.teamId, accountId, payload);
    if (row) await db.insert(messageFact).values(row).onConflictDoNothing();
  } catch (err) {
    log.error({ err: cause(err), eventId, type, accountId }, 'live analytics update failed');
  }
}

export type Freshness = { lastLiveAt: string | null; lastBackfillAt: string | null; liveEvents24h: number };

/**
 * How fresh the workspace's stats are: the newest live message event (the event ledger's time, which is the OF
 * message's) and how many arrived in the last 24 hours, over the workspace's claimed accounts (narrowed to
 * `accounts` when given), and the last backfill chat walk.
 */
export async function freshness(teamId: string, accounts: number[] | null): Promise<Freshness> {
  const scope = accounts ? sql`and ${inArray(sql`w.account_id`, accounts)}` : sql``;
  const { rows } = await db.execute<{ last_live: Date | string | null; n: number; last_backfill: Date | string | null }>(sql`
    select
      (select max(e.created_at) from event e join account_workspace w on w.account_id = e.account_id
        where w.team_id = ${teamId} ${scope} and e.type in ('messages.received', 'messages.sent')) as last_live,
      (select count(*)::int from event e join account_workspace w on w.account_id = e.account_id
        where w.team_id = ${teamId} ${scope} and e.type in ('messages.received', 'messages.sent')
          and e.created_at > now() - interval '24 hours') as n,
      (select max(c.walked_at) from chat_coverage c join account_workspace w on w.account_id = c.account_id
        where c.team_id = ${teamId} ${scope}) as last_backfill`);
  const iso = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString());
  const row = rows[0]!;
  return { lastLiveAt: iso(row.last_live), lastBackfillAt: iso(row.last_backfill), liveEvents24h: Number(row.n) };
}
