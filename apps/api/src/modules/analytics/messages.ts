import { and, asc, eq, isNotNull, max, min, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { chatCoverage, messageFact, purchaseFact } from '../../db/schema.js';
import type { StatsFan, StatsMessage } from '../../contracts.js';
import { cursorTime, keysetCursor } from '../../lib/cursor.js';
import { messageDetail, plainText } from './derive.js';
import { booked, dm, inScope, owned, ppvDm, type Scope } from './facts.js';

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

const coverage = and(
  eq(chatCoverage.teamId, messageFact.teamId),
  eq(chatCoverage.accountId, messageFact.accountId),
  eq(chatCoverage.chatId, messageFact.chatId),
);

/** One known fan's booked sales on an account (`fanSpends`). */
export type FanSpend = {
  accountId: number;
  fanId: number;
  /** Booked gross in the range, and over every stored transaction, in cents. */
  gross: number;
  grossAllTime: number;
  /** Booked net and transactions in the range. */
  net: number;
  transactions: number;
  /** A booked sale in the range, and the newest one's time (null with none). */
  paidInRange: boolean;
  lastAt: Date | null;
  /** OF's `user` name, username and `isDeleted` on the newest booked transaction in the range with a name (else the newest in the range); null / false with none. */
  name: string | null;
  username: string | null;
  isDeleted: boolean;
  /** A message of the fan's chat on the account is stored, any time. */
  hasChat: boolean;
};

/**
 * Per (account, fan) with a booked sale on the accounts of `scope`, any time (the fan known): spend in the range and
 * all time, the fan's details from the range's transactions, and whether the chat is stored. Shared by
 * `GET /v1/stats/fans` and `GET /v1/stats/revenue`.
 */
export async function fanSpends(scope: Scope): Promise<FanSpend[]> {
  const user = sql`${purchaseFact.raw}->'user'`;
  const inRange = sql`${purchaseFact.createdAt} >= ${scope.from} and ${purchaseFact.createdAt} < ${scope.to}`;
  const unnamed = sql`coalesce(nullif(${user}->>'name', ''), nullif(${user}->>'username', '')) is null`;
  const newest = (expr: SQL) => sql`(array_agg(${expr} order by ${unnamed}, ${purchaseFact.createdAt} desc, ${purchaseFact.txId}) filter (where ${inRange}))[1]`;
  const rows = await db
    .select({
      accountId: purchaseFact.accountId,
      fanId: purchaseFact.fanId,
      gross: sql<number>`coalesce(sum(${purchaseFact.grossCents}) filter (where ${inRange}), 0)::int`,
      grossAllTime: sql<number>`coalesce(sum(${purchaseFact.grossCents}), 0)::int`,
      net: sql<number>`coalesce(sum(${purchaseFact.netCents}) filter (where ${inRange}), 0)::int`,
      transactions: sql<number>`(count(*) filter (where ${inRange}))::int`,
      paidInRange: sql<boolean>`coalesce(bool_or(${inRange}), false)`,
      lastAt: sql<Date | null>`max(${purchaseFact.createdAt}) filter (where ${inRange})`.mapWith(purchaseFact.createdAt),
      name: sql<string | null>`${newest(sql`nullif(${user}->>'name', '')`)}`,
      username: sql<string | null>`${newest(sql`nullif(${user}->>'username', '')`)}`,
      isDeleted: sql<boolean>`coalesce(${newest(sql`coalesce((${user}->>'isDeleted')::boolean, false)`)}, false)`,
      hasChat: sql<boolean>`exists (select 1 from ${messageFact} where ${messageFact.teamId} = ${purchaseFact.teamId} and ${messageFact.accountId} = ${purchaseFact.accountId} and ${messageFact.chatId} = ${purchaseFact.fanId})`,
    })
    .from(purchaseFact)
    .where(and(owned(purchaseFact, scope.teamId, scope.accountIds), booked, isNotNull(purchaseFact.fanId)))
    .groupBy(purchaseFact.teamId, purchaseFact.accountId, purchaseFact.fanId);
  return rows.flatMap(({ fanId, ...r }) => (fanId !== null ? [{ ...r, fanId }] : []));
}

/** Per fan (chat) with a message in the range: the message counts and times, and the chat list's names. */
async function fanMessages(scope: Scope) {
  const outbound = sql`${messageFact.direction} = 'outbound'`;
  const tip = sql`${messageFact.direction} = 'inbound' and ${messageFact.isTip}`;
  return db
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
      lastAt: max(messageFact.createdAt),
      lastFanAt: sql<Date | null>`max(${messageFact.createdAt}) filter (where ${messageFact.direction} = 'inbound')`.mapWith(messageFact.createdAt),
    })
    .from(messageFact)
    .leftJoin(chatCoverage, coverage)
    .where(inScope(messageFact, scope))
    .groupBy(messageFact.accountId, messageFact.chatId, chatCoverage.fanUsername, chatCoverage.fanName, chatCoverage.fanCustomName);
}

const NO_MESSAGES = { fanMessages: 0, dmMessages: 0, massMessages: 0, automatedMessages: 0, ppvSent: 0, ppvOpened: 0, tips: 0, tipCents: 0 };
/** Newest first by ISO time (they sort as strings); null (no fan message, or no message) last. */
const newer = (a: string | null, b: string | null) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? 1 : -1);

/**
 * One row per fan with a message in `[from, to)`, plus each other payer of the range (a booked sale with a known fan;
 * message counts 0, times null), with `fanSpends`'s spend and details. Most gross in the range first, then the latest
 * fan message (fans who wrote nothing in the range last), then the latest message; at most `limit`; `total` counts
 * them all. `search` (trimmed, a leading `@` dropped, any case) keeps the fans whose username, name, custom name or
 * chat id contains it. Deleted (unsent) messages count.
 */
export async function scopedFans(scope: Scope, limit: number, search = ''): Promise<{ total: number; items: StatsFan[] }> {
  const [chats, spends] = await Promise.all([fanMessages(scope), fanSpends(scope)]);
  const spend = new Map(spends.map((p) => [`${p.accountId}:${p.fanId}`, p]));
  const items: (StatsFan & { names: (string | null)[] })[] = chats.map(({ fanName, fanCustomName, ...r }) => {
    const p = spend.get(`${r.accountId}:${r.chatId}`);
    return {
      ...r,
      name: fanName ?? p?.name ?? null,
      firstAt: r.firstAt!.toISOString(),
      lastAt: r.lastAt!.toISOString(),
      lastFanAt: r.lastFanAt?.toISOString() ?? null,
      gross: p?.gross ?? 0,
      grossAllTime: p?.grossAllTime ?? 0,
      isDeleted: p?.isDeleted ?? false,
      hasChat: true,
      names: [r.fanUsername, fanName, fanCustomName],
    };
  });
  const listed = new Set(items.map((f) => `${f.accountId}:${f.chatId}`));
  for (const p of spends) {
    if (!p.paidInRange || listed.has(`${p.accountId}:${p.fanId}`)) continue;
    const { accountId, fanId, username, name, gross, grossAllTime, isDeleted, hasChat } = p;
    const times = { firstAt: null, lastAt: null, lastFanAt: null };
    items.push({ accountId, chatId: fanId, fanUsername: username, name, ...NO_MESSAGES, ...times, gross, grossAllTime, isDeleted, hasChat, names: [username, name] });
  }
  const q = search.trim().replace(/^@/, '').toLowerCase();
  const shown = items.filter((f) => !q || f.names.some((n) => n?.toLowerCase().includes(q)) || String(f.chatId).includes(q));
  shown.sort((a, b) => b.gross - a.gross || newer(a.lastFanAt, b.lastFanAt) || newer(a.lastAt, b.lastAt) || a.accountId - b.accountId || a.chatId - b.chatId);
  return { total: shown.length, items: shown.slice(0, limit).map(({ names: _names, ...f }) => f) };
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
