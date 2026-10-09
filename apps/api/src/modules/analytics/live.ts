import type { FastifyBaseLogger } from 'fastify';
import { and, eq, inArray, isNull, max, sql } from 'drizzle-orm';
import type { StatsFreshness, WebhookEventType } from '../../contracts.js';
import { db } from '../../db/index.js';
import { env } from '../../env.js';
import { accountWorkspace, chatCoverage, event, messageFact } from '../../db/schema.js';
import { cause } from '../../lib/errors.js';
import { deriveContext, deriveMessage, fanNames, int, type Raw } from './derive.js';
import { nextRefresh } from './refresh.js';

// Live updates (docs/analytics.md): upstream message events write `message_fact` between backfills. Scripts and
// `chat_coverage` are backfill-only.

/** The event types that count as live message events (freshness). */
const LIVE_MESSAGE_TYPES = ['messages.received', 'messages.sent'] satisfies WebhookEventType[];

const userId = (user: unknown) => int((user as Raw | null | undefined)?.id);

/**
 * The `message_fact` row of one live OF message object, derived by the backfill's `deriveMessage`; null when the
 * payload is not a message, names no fan (an outbound message needs `toUser` or OF's `chatUserId`) or has no valid
 * time. The live context has no mass history, so an outbound message is mass when OF's `isFromQueue` is true: right
 * on every broadcast copy, wrong on the ~0.2% of DMs that are single-chat queued sends (deriveMessage), which count as
 * mass until a backfill over their range re-derives the row from the mass history. It has no welcome message or
 * automation texts either, so no live message is automated until then. The fan's names for the script hash come from
 * `chat_coverage`, as the backfill's come from the chat list.
 */
async function liveRow(teamId: string, accountId: number, payload: unknown) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const { fanData: _fanData, ...raw } = payload as Raw; // `fanData` is the upstream's own, not OF's
  const outbound = userId(raw.fromUser) === accountId;
  const chatId = outbound ? (userId(raw.toUser) ?? int(raw.chatUserId)) : userId(raw.fromUser);
  if (chatId === null) return null;
  let names: string[] = [];
  if (outbound) {
    const [cov] = await db
      .select({ name: chatCoverage.fanName, username: chatCoverage.fanUsername, displayName: chatCoverage.fanCustomName })
      .from(chatCoverage)
      .where(and(eq(chatCoverage.accountId, accountId), eq(chatCoverage.chatId, chatId)));
    names = fanNames(cov);
  }
  const d = deriveMessage(raw, chatId, deriveContext(accountId, [], null, []), names);
  if (!d || Number.isNaN(d.createdAt.getTime())) return null;
  const isMass = d.direction === 'outbound' && raw.isFromQueue === true;
  return { teamId, accountId, ...d, isMass, raw, fetchedAt: new Date() };
}

type Apply = (teamId: string, accountId: number, payload: unknown) => Promise<void>;

/** Inserts the message's row on the backfill's key `(account_id, message_id)`; a row already there (the backfill read it with full context) is kept. */
const insertMessage: Apply = async (teamId, accountId, payload) => {
  const row = await liveRow(teamId, accountId, payload);
  if (row) await db.insert(messageFact).values(row).onConflictDoNothing();
};

/** Marks the message's row deleted (an unsend) at the time the event is applied; the row stays. An unknown message is ignored; a mark is kept. */
const markDeleted: Apply = async (teamId, accountId, payload) => {
  const messageId = int((payload as Raw | null)?.id);
  if (messageId === null) return;
  await db
    .update(messageFact)
    .set({ deletedAt: new Date() })
    .where(and(eq(messageFact.teamId, teamId), eq(messageFact.accountId, accountId), eq(messageFact.messageId, messageId), isNull(messageFact.deletedAt)));
};

const APPLY = {
  'messages.received': insertMessage,
  'messages.sent': insertMessage,
  'messages.deleted': markDeleted,
} satisfies Partial<Record<WebhookEventType, Apply>>;
const applies = (type: string): type is keyof typeof APPLY => Object.hasOwn(APPLY, type);

/**
 * Applies one ingested event to the analytics store when its account is claimed (`account_workspace`); otherwise
 * does nothing. `messages.received` / `messages.sent` insert the message's row (`insertMessage`); `messages.deleted`
 * marks it deleted (`markDeleted`). Never throws: a failure is logged once with the event id.
 */
export async function applyLiveEvent(eventId: string, type: string, accountId: number, payload: unknown, log: FastifyBaseLogger): Promise<void> {
  if (!applies(type)) return;
  try {
    const [owner] = await db.select({ teamId: accountWorkspace.teamId }).from(accountWorkspace).where(eq(accountWorkspace.accountId, accountId));
    if (owner) await APPLY[type](owner.teamId, accountId, payload);
  } catch (err) {
    log.error({ err: cause(err), eventId, type, accountId }, 'live analytics update failed');
  }
}

/**
 * How fresh the workspace's stats are: the newest live message event (the event ledger's time, which is the OF
 * message's) and how many arrived in the last 24 hours, and the newest `refreshed_at` (the last backfill), over the
 * workspace's claimed accounts (narrowed to `accounts` when given); and the next daily refresh time, if it is on.
 */
export async function freshness(teamId: string, accounts: number[] | null): Promise<StatsFreshness> {
  const scoped = and(eq(accountWorkspace.teamId, teamId), accounts ? inArray(accountWorkspace.accountId, accounts) : undefined);
  const [row] = await db
    .select({
      lastLiveAt: max(event.createdAt),
      liveEvents24h: sql<number>`(count(*) filter (where ${event.createdAt} > now() - interval '24 hours'))::int`,
    })
    .from(event)
    .innerJoin(accountWorkspace, eq(accountWorkspace.accountId, event.accountId))
    .where(and(scoped, inArray(event.type, LIVE_MESSAGE_TYPES)));
  const [refresh] = await db.select({ at: max(accountWorkspace.refreshedAt) }).from(accountWorkspace).where(scoped);
  // An aggregate without GROUP BY always yields exactly one row.
  if (!row || !refresh) throw new Error('freshness aggregate returned no row');
  return {
    lastLiveAt: row.lastLiveAt?.toISOString() ?? null,
    liveEvents24h: row.liveEvents24h,
    lastRefreshAt: refresh.at?.toISOString() ?? null,
    nextRefreshAt: nextRefresh(env.STATS_REFRESH_HOUR_UTC, new Date())?.toISOString() ?? null,
  };
}
