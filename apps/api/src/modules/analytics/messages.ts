import { and, asc, eq, gte, inArray, isNotNull, lt, max, min, sql, type SQL } from 'drizzle-orm';
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

export const txStatus = sql`${purchaseFact.raw}->>'status'`;
/** A booked sale: OF's status `done` (settled) or `loading` (pending); `undo` (refunded) and `pending_return` (being reversed) are not. */
export const booked = sql`${txStatus} in ('done', 'loading')`;

/** A DM: outbound, not mass, not automated (welcome message or automation). Unsent ones count. */
export const dm = sql`${messageFact.direction} = 'outbound' and not ${messageFact.isMass} and not ${messageFact.isAutomated}`;

/** A PPV DM: outbound, not mass, priced. Unsent ones count. */
export const ppvDm = sql`${messageFact.direction} = 'outbound' and not ${messageFact.isMass} and ${messageFact.priceCents} > 0`;

const coverage = and(
  eq(chatCoverage.teamId, messageFact.teamId),
  eq(chatCoverage.accountId, messageFact.accountId),
  eq(chatCoverage.chatId, messageFact.chatId),
);

/** `search` trimmed, a leading `@` dropped, lowercased; empty = no filter. */
const needle = (search: string | undefined) => (search ?? '').trim().replace(/^@/, '').toLowerCase();
/** The fan's username, name or custom name, or its chat id, contains `q` (a `needle`). */
const matches = (q: string, chatId: number, names: (string | null)[]) => names.some((n) => n?.toLowerCase().includes(q)) || String(chatId).includes(q);

/**
 * One row per fan with a message in `[from, to)`, plus each payer of the range (a booked sale with a known fan) with
 * no stored chat at all (message counts 0, times null, `hasChat` false). Each carries `gross` (booked, in cents) in
 * the range and `grossAllTime`, and `isDeleted` (OF's `user.isDeleted` on the fan's newest booked transaction with a
 * name, else the newest, as in `GET /v1/stats/revenue`; false with none). Most gross in the range first, then the
 * latest fan message (fans who wrote nothing in the range last), then the latest message; at most `limit`; `total`
 * counts them all. `search` keeps the fans whose username, name, custom name or chat id contains it. Deleted (unsent)
 * messages count.
 */
export async function scopedFans(scope: Scope, limit: number, search?: string): Promise<{ total: number; items: StatsFan[] }> {
  const outbound = sql`${messageFact.direction} = 'outbound'`;
  const tip = sql`${messageFact.direction} = 'inbound' and ${messageFact.isTip}`;
  const lastAt = max(messageFact.createdAt);
  const lastFanAt = sql<Date | null>`max(${messageFact.createdAt}) filter (where ${messageFact.direction} = 'inbound')`.mapWith(messageFact.createdAt);
  // The fan's details from the newest booked transaction with a name, else the newest (revenue.ts's top payers).
  const user = sql`${purchaseFact.raw}->'user'`;
  const newest = (expr: SQL) => sql`(array_agg(${expr} order by coalesce(nullif(${user}->>'name', ''), nullif(${user}->>'username', '')) is null, ${purchaseFact.createdAt} desc))[1]`;
  const inRange = sql`${purchaseFact.createdAt} >= ${scope.from} and ${purchaseFact.createdAt} < ${scope.to}`;
  const [chats, spends] = await Promise.all([
    db
      .select({
        accountId: messageFact.accountId,
        chatId: messageFact.chatId,
        fanUsername: chatCoverage.fanUsername,
        fanName: chatCoverage.fanName,
        fanCustomName: chatCoverage.fanCustomName,
        fanMessages: sql<number>`(count(*) filter (where ${messageFact.direction} = 'inbound'))::int`,
        dmMessages: sql<number>`(count(*) filter (where ${dm}))::int`,
        massMessages: sql<number>`(count(*) filter (where ${outbound} and ${messageFact.isMass}))::int`,
        automatedMessages: sql<number>`(count(*) filter (where ${outbound} and ${messageFact.isAutomated} and not ${messageFact.isMass}))::int`,
        ppvSent: sql<number>`(count(*) filter (where ${ppvDm}))::int`,
        ppvOpened: sql<number>`(count(*) filter (where ${ppvDm} and ${messageFact.isOpened}))::int`,
        tips: sql<number>`(count(*) filter (where ${tip}))::int`,
        tipCents: sql<number>`coalesce(sum(${messageFact.tipCents}) filter (where ${tip}), 0)::int`,
        firstAt: min(messageFact.createdAt),
        lastAt,
        lastFanAt,
      })
      .from(messageFact)
      .leftJoin(chatCoverage, coverage)
      .where(inScope(messageFact, scope))
      .groupBy(messageFact.accountId, messageFact.chatId, chatCoverage.fanUsername, chatCoverage.fanName, chatCoverage.fanCustomName),
    // Every known fan's booked sales on the accounts in scope, any time.
    db
      .select({
        accountId: purchaseFact.accountId,
        fanId: purchaseFact.fanId,
        gross: sql<number>`coalesce(sum(${purchaseFact.grossCents}) filter (where ${inRange}), 0)::int`,
        grossAllTime: sql<number>`coalesce(sum(${purchaseFact.grossCents}), 0)::int`,
        paidInRange: sql<boolean>`bool_or(${inRange})`,
        username: sql<string | null>`${newest(sql`nullif(${user}->>'username', '')`)}`,
        name: sql<string | null>`${newest(sql`nullif(${user}->>'name', '')`)}`,
        isDeleted: sql<boolean>`${newest(sql`coalesce((${user}->>'isDeleted')::boolean, false)`)}`,
        hasChat: sql<boolean>`exists (select 1 from ${messageFact} where ${messageFact.teamId} = ${purchaseFact.teamId} and ${messageFact.accountId} = ${purchaseFact.accountId} and ${messageFact.chatId} = ${purchaseFact.fanId})`,
      })
      .from(purchaseFact)
      .where(
        and(eq(purchaseFact.teamId, scope.teamId), scope.accountIds ? inArray(purchaseFact.accountId, scope.accountIds) : undefined, booked, isNotNull(purchaseFact.fanId)),
      )
      .groupBy(purchaseFact.teamId, purchaseFact.accountId, purchaseFact.fanId),
  ]);
  // The where clause leaves out unknown fans.
  const spend = new Map(spends.map((p) => [`${p.accountId}:${p.fanId}`, { ...p, fanId: p.fanId! }]));
  const q = needle(search);
  const items: StatsFan[] = [];
  for (const { fanName, fanCustomName, ...r } of chats) {
    if (q && !matches(q, r.chatId, [r.fanUsername, fanName, fanCustomName])) continue;
    const p = spend.get(`${r.accountId}:${r.chatId}`);
    items.push({
      ...r,
      firstAt: r.firstAt!.toISOString(),
      lastAt: r.lastAt!.toISOString(),
      lastFanAt: r.lastFanAt?.toISOString() ?? null,
      gross: p?.gross ?? 0,
      grossAllTime: p?.grossAllTime ?? 0,
      isDeleted: p?.isDeleted ?? false,
      hasChat: true,
    });
  }
  for (const p of spend.values()) {
    if (!p.paidInRange || p.hasChat || (q && !matches(q, p.fanId, [p.username, p.name]))) continue;
    const none = { fanMessages: 0, dmMessages: 0, massMessages: 0, automatedMessages: 0, ppvSent: 0, ppvOpened: 0, tips: 0, tipCents: 0 };
    items.push({
      accountId: p.accountId,
      chatId: p.fanId,
      fanUsername: p.username,
      ...none,
      firstAt: null,
      lastAt: null,
      lastFanAt: null,
      gross: p.gross,
      grossAllTime: p.grossAllTime,
      isDeleted: p.isDeleted,
      hasChat: false,
    });
  }
  // ISO times sort as strings, newest first; null (no fan message, or no message) last.
  const newer = (a: string | null, b: string | null) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? 1 : -1);
  items.sort((a, b) => b.gross - a.gross || newer(a.lastFanAt, b.lastFanAt) || newer(a.lastAt, b.lastAt) || a.accountId - b.accountId || a.chatId - b.chatId);
  return { total: items.length, items: items.slice(0, limit) };
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
