import { and, asc, desc, eq, gte, inArray, lt, max, min, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { chatCoverage, messageFact } from '../../db/schema.js';
import type { StatsFan, StatsMessage } from '../../contracts.js';
import { plainText } from './derive.js';

// The stored messages per fan (`GET /v1/stats/fans`, `GET /v1/stats/messages`): read from `message_fact` of the
// workspace's own rows, with the fan's username from `chat_coverage`.

export const MESSAGE_EXPORT_COLUMNS = [
  'account_id',
  'chat_id',
  'fan_username',
  'message_id',
  'created_at',
  'direction',
  'text',
  'price_cents',
  'is_tip',
  'media_count',
  'is_mass',
  'is_automated',
] as const;

type Scope = { teamId: string; accountIds: number[] | null; from: Date; to: Date };

const inScope = (s: Scope) =>
  and(
    eq(messageFact.teamId, s.teamId),
    s.accountIds ? inArray(messageFact.accountId, s.accountIds) : undefined,
    gte(messageFact.createdAt, s.from),
    lt(messageFact.createdAt, s.to),
  );

const coverage = and(
  eq(chatCoverage.teamId, messageFact.teamId),
  eq(chatCoverage.accountId, messageFact.accountId),
  eq(chatCoverage.chatId, messageFact.chatId),
);

/** One row per fan with a message in `[from, to)`, latest message first, at most `limit`. */
export async function scopedFans(scope: Scope, limit: number): Promise<StatsFan[]> {
  const lastAt = max(messageFact.createdAt);
  const rows = await db
    .select({
      accountId: messageFact.accountId,
      chatId: messageFact.chatId,
      fanUsername: chatCoverage.fanUsername,
      fanMessages: sql<number>`(count(*) filter (where ${messageFact.direction} = 'inbound'))::int`,
      creatorMessages: sql<number>`(count(*) filter (where ${messageFact.direction} = 'outbound' and not ${messageFact.isMass} and not ${messageFact.isAutomated}))::int`,
      massMessages: sql<number>`(count(*) filter (where ${messageFact.direction} = 'outbound' and ${messageFact.isMass}))::int`,
      firstAt: min(messageFact.createdAt),
      lastAt,
    })
    .from(messageFact)
    .leftJoin(chatCoverage, coverage)
    .where(inScope(scope))
    .groupBy(messageFact.accountId, messageFact.chatId, chatCoverage.fanUsername)
    .orderBy(desc(lastAt), asc(messageFact.accountId), asc(messageFact.chatId))
    .limit(limit);
  return rows.map((r) => ({ ...r, firstAt: r.firstAt!.toISOString(), lastAt: r.lastAt!.toISOString() }));
}

/** The messages in `[from, to)`, by account, chat, time and message id; `limit` undefined = all of them. */
export async function scopedMessages(
  scope: Scope & { chatId?: number; direction: 'in' | 'out' | 'all' },
  limit: number | undefined,
): Promise<StatsMessage[]> {
  const direction = scope.direction === 'all' ? undefined : eq(messageFact.direction, scope.direction === 'in' ? 'inbound' : 'outbound');
  const query = db
    .select({
      accountId: messageFact.accountId,
      chatId: messageFact.chatId,
      fanUsername: chatCoverage.fanUsername,
      messageId: messageFact.messageId,
      createdAt: messageFact.createdAt,
      direction: messageFact.direction,
      text: sql<string | null>`${messageFact.raw}->>'text'`,
      priceCents: messageFact.priceCents,
      isTip: messageFact.isTip,
      mediaCount: messageFact.mediaCount,
      isMass: messageFact.isMass,
      isAutomated: messageFact.isAutomated,
    })
    .from(messageFact)
    .leftJoin(chatCoverage, coverage)
    .where(and(inScope(scope), scope.chatId !== undefined ? eq(messageFact.chatId, scope.chatId) : undefined, direction))
    .orderBy(asc(messageFact.accountId), asc(messageFact.chatId), asc(messageFact.createdAt), asc(messageFact.messageId))
    .$dynamic();
  const rows = await (limit === undefined ? query : query.limit(limit));
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), text: r.text ? plainText(r.text) : '' }));
}

/** A CSV text cell Excel would read as a formula (`=`, `+`, `-`, `@`) gets a leading `'`, so it shows as typed. */
export const csvSafeText = (text: string) => (/^[=+\-@]/.test(text) ? `'${text}` : text);
