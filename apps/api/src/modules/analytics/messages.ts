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

/**
 * One row per fan with a message in `[from, to)`: latest fan message first (fans who wrote nothing in the range
 * last), then latest message, at most `limit`; `total` counts them all.
 */
export async function scopedFans(scope: Scope, limit: number): Promise<{ total: number; items: StatsFan[] }> {
  const outbound = sql`${messageFact.direction} = 'outbound'`;
  const lastAt = max(messageFact.createdAt);
  const lastFanAt = sql<Date | null>`max(${messageFact.createdAt}) filter (where ${messageFact.direction} = 'inbound')`.mapWith(messageFact.createdAt);
  const rows = await db
    .select({
      accountId: messageFact.accountId,
      chatId: messageFact.chatId,
      fanUsername: chatCoverage.fanUsername,
      fanMessages: sql<number>`(count(*) filter (where ${messageFact.direction} = 'inbound'))::int`,
      dmMessages: sql<number>`(count(*) filter (where ${outbound} and not ${messageFact.isMass} and not ${messageFact.isAutomated}))::int`,
      massMessages: sql<number>`(count(*) filter (where ${outbound} and ${messageFact.isMass}))::int`,
      automatedMessages: sql<number>`(count(*) filter (where ${outbound} and ${messageFact.isAutomated} and not ${messageFact.isMass}))::int`,
      firstAt: min(messageFact.createdAt),
      lastAt,
      lastFanAt,
      total: sql<number>`(count(*) over ())::int`,
    })
    .from(messageFact)
    .leftJoin(chatCoverage, coverage)
    .where(inScope(scope))
    .groupBy(messageFact.accountId, messageFact.chatId, chatCoverage.fanUsername)
    .orderBy(sql`${lastFanAt} desc nulls last`, desc(lastAt), asc(messageFact.accountId), asc(messageFact.chatId))
    .limit(limit);
  return {
    total: rows[0]?.total ?? 0,
    items: rows.map(({ total: _total, ...r }) => ({
      ...r,
      firstAt: r.firstAt!.toISOString(),
      lastAt: r.lastAt!.toISOString(),
      lastFanAt: r.lastFanAt?.toISOString() ?? null,
    })),
  };
}

type MessageScope = Scope & { chatId?: number; direction: 'in' | 'out' | 'all' };
type Cursor = { accountId: number; chatId: number; createdAt: Date; messageId: number };

/** Rows per query of the CSV export; a setting so a test can cross a batch boundary with a few rows. */
export const messageExport = { batchSize: 2000 };

/** Up to `limit` messages after `after` (keyset, in export order). */
async function messagePage(scope: MessageScope, after: Cursor | null, limit: number) {
  const direction = scope.direction === 'all' ? undefined : eq(messageFact.direction, scope.direction === 'in' ? 'inbound' : 'outbound');
  const rows = await db
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
    .where(
      and(
        inScope(scope),
        scope.chatId !== undefined ? eq(messageFact.chatId, scope.chatId) : undefined,
        direction,
        after
          ? sql`(${messageFact.accountId}, ${messageFact.chatId}, ${messageFact.createdAt}, ${messageFact.messageId}) > (${after.accountId}, ${after.chatId}, ${after.createdAt.toISOString()}::timestamptz, ${after.messageId})`
          : undefined,
      ),
    )
    .orderBy(asc(messageFact.accountId), asc(messageFact.chatId), asc(messageFact.createdAt), asc(messageFact.messageId))
    .limit(limit);
  return { rows, last: rows.at(-1) ?? null };
}

const toMessage = ({ createdAt, text, ...r }: Awaited<ReturnType<typeof messagePage>>['rows'][number]): StatsMessage => ({
  ...r,
  createdAt: createdAt.toISOString(),
  text: text ? plainText(text) : '',
});

/** The first `limit` messages in `[from, to)`, by account, chat, time and message id; `truncated` when more match. */
export async function scopedMessages(scope: MessageScope, limit: number): Promise<{ truncated: boolean; items: StatsMessage[] }> {
  const { rows } = await messagePage(scope, null, limit + 1);
  return { truncated: rows.length > limit, items: rows.slice(0, limit).map(toMessage) };
}

/** Every message in `[from, to)` in the same order, `messageExport.batchSize` rows per query. */
export async function* messageBatches(scope: MessageScope): AsyncGenerator<StatsMessage[]> {
  let after: Cursor | null = null;
  for (;;) {
    const page = await messagePage(scope, after, messageExport.batchSize);
    if (page.rows.length) yield page.rows.map(toMessage);
    if (page.rows.length < messageExport.batchSize) return;
    after = page.last;
  }
}
