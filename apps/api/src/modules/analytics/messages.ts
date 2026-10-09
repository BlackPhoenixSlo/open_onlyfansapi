import { and, asc, desc, eq, gte, inArray, lt, max, min, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { chatCoverage, messageFact, purchaseFact } from '../../db/schema.js';
import type { StatsFan, StatsMessage } from '../../contracts.js';
import { cursorTime, keysetCursor } from '../../lib/cursor.js';
import { messageDetail, plainText } from './derive.js';

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
  'is_free',
  'is_opened',
  'is_tip',
  'tip_cents',
  'media_count',
  'photos',
  'videos',
  'gifs',
  'audios',
  'has_preview',
  'is_mass',
  'is_automated',
  'automated_reason',
  'is_reply',
  'is_liked',
  'deleted_at',
] as const;

/** A stats request's workspace, accounts (null = all of the workspace's) and instants `[from, to)`. */
export type Scope = { teamId: string; accountIds: number[] | null; from: Date; to: Date };

/** The rows of `table` (`message_fact` or `purchase_fact`) in `s`. */
export const inScope = (table: typeof messageFact | typeof purchaseFact, s: Scope) =>
  and(
    eq(table.teamId, s.teamId),
    s.accountIds ? inArray(table.accountId, s.accountIds) : undefined,
    gte(table.createdAt, s.from),
    lt(table.createdAt, s.to),
  );

/** A PPV DM: outbound, not mass, priced. Unsent ones count. */
export const ppvDm = sql`${messageFact.direction} = 'outbound' and not ${messageFact.isMass} and ${messageFact.priceCents} > 0`;

const coverage = and(
  eq(chatCoverage.teamId, messageFact.teamId),
  eq(chatCoverage.accountId, messageFact.accountId),
  eq(chatCoverage.chatId, messageFact.chatId),
);

/**
 * One row per fan with a message in `[from, to)`: latest fan message first (fans who wrote nothing in the range
 * last), then latest message, at most `limit`; `total` counts them all. Deleted (unsent) messages count.
 */
export async function scopedFans(scope: Scope, limit: number): Promise<{ total: number; items: StatsFan[] }> {
  const outbound = sql`${messageFact.direction} = 'outbound'`;
  const tip = sql`${messageFact.direction} = 'inbound' and ${messageFact.isTip}`;
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
      ppvSent: sql<number>`(count(*) filter (where ${ppvDm}))::int`,
      ppvOpened: sql<number>`(count(*) filter (where ${ppvDm} and ${messageFact.isOpened}))::int`,
      tips: sql<number>`(count(*) filter (where ${tip}))::int`,
      tipCents: sql<number>`coalesce(sum(${messageFact.tipCents}) filter (where ${tip}), 0)::int`,
      firstAt: min(messageFact.createdAt),
      lastAt,
      lastFanAt,
      total: sql<number>`(count(*) over ())::int`,
    })
    .from(messageFact)
    .leftJoin(chatCoverage, coverage)
    .where(inScope(messageFact, scope))
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
      priceCents: messageFact.priceCents,
      isTip: messageFact.isTip,
      tipCents: messageFact.tipCents,
      isOpened: messageFact.isOpened,
      mediaCount: messageFact.mediaCount,
      isMass: messageFact.isMass,
      isAutomated: messageFact.isAutomated,
      automatedReason: messageFact.automatedReason,
      deletedAt: messageFact.deletedAt,
      raw: messageFact.raw,
    })
    .from(messageFact)
    .leftJoin(chatCoverage, coverage)
    .where(
      and(
        inScope(messageFact, scope),
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

const toMessage = ({ createdAt, deletedAt, raw, ...r }: Awaited<ReturnType<typeof messagePage>>['rows'][number]): StatsMessage => ({
  ...r,
  ...messageDetail(raw),
  createdAt: createdAt.toISOString(),
  text: typeof raw.text === 'string' ? plainText(raw.text) : '',
  deletedAt: deletedAt?.toISOString() ?? null,
});

/** The `cursor` of `GET /v1/stats/messages`: account, chat, time and message id of the last row. */
const messageCursor = keysetCursor(
  z.tuple([z.number().int(), z.number().int(), cursorTime, z.number().int()]),
  (c: Cursor) => [c.accountId, c.chatId, c.createdAt.toISOString(), c.messageId] as const,
);

/**
 * The first `limit` messages in `[from, to)` after `cursor` (a previous page's `nextCursor`; 400 `invalid_cursor` when
 * it is not one), by account, chat, time and message id; `truncated` when more match, and then `nextCursor` continues
 * after the last item.
 */
export async function scopedMessages(
  scope: MessageScope,
  limit: number,
  cursor: string | undefined,
): Promise<{ truncated: boolean; nextCursor: string | null; items: StatsMessage[] }> {
  let after: Cursor | null = null;
  if (cursor) {
    const [accountId, chatId, at, messageId] = messageCursor.decode(cursor);
    after = { accountId, chatId, createdAt: new Date(at), messageId };
  }
  const { rows } = await messagePage(scope, after, limit + 1);
  const { items, nextCursor } = messageCursor.page(rows, limit);
  return { truncated: nextCursor !== null, nextCursor, items: items.map(toMessage) };
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
