import { and, eq, getTableColumns, inArray, isNotNull, sql, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { db } from '../../db/index.js';
import { accountWorkspace, chatCoverage, messageFact, purchaseFact } from '../../db/schema.js';
import type { BackfillRows, BackfillStore } from './backfill.js';
import type { DerivedMessage } from './derive.js';
import { inScope, owned } from './facts.js';
import { syncScripts } from './scripts.js';

// Where a backfill puts what it reads (`BackfillStore`): the analytics tables, or a dry run's memory.

/**
 * The account's chats one queue id must reach to be a bulk send, stored as mass though the mass history a run read
 * does not list it; a DM goes to one chat (the counts behind it: derive.ts `deriveMessage`).
 */
const BULK_CHATS = 8;

/** `set` for an upsert: every column not named in `keep` (the primary key, and any column to keep) takes the incoming row's value. */
function updateAll(table: PgTable, keep: string[]): Record<string, SQL> {
  return Object.fromEntries(
    Object.entries(getTableColumns(table))
      .filter(([name]) => !keep.includes(name))
      .map(([name, col]) => [name, sql.raw(`excluded."${col.name}"`)]),
  );
}

/**
 * The analytics tables of workspace `teamId`, which must own the account (`claimAccount` first).
 * Messages from `massFrom` on upsert every column on `(account_id, message_id)` (`updateAll`, which clears
 * `deleted_at` too: the derived rows have none). Older ones were derived without their mass history, so on conflict
 * they update every column but `is_mass`, `is_automated` and `automated_reason`: the flags a run that read the mass
 * history derived are not undone. A message read again exists upstream, so either way its `deleted_at` is cleared.
 * In the page's transaction, the stored outbound messages of a bulk send (a queue id of the page's in BULK_CHATS+
 * chats) are marked mass.
 * Coverage merges: it never moves back. Transactions upsert on `(account_id, tx_id)`. `finish` syncs the account's
 * script candidates and, for a run that ran to its end, moves `account_workspace.refreshed_at` forward (never back).
 */
export function dbStore(teamId: string, accountId: number): BackfillStore {
  return {
    async messages(covered, tail) {
      // One transaction: the covered upsert re-derives `is_mass` from the mass history, so a run that died before the
      // bulk mark would leave a bulk send's copies unmarked.
      await db.transaction(async (tx) => {
        if (covered.length) {
          await tx
            .insert(messageFact)
            .values(covered.map((r) => ({ teamId, accountId, ...r })))
            .onConflictDoUpdate({ target: [messageFact.accountId, messageFact.messageId], set: updateAll(messageFact, ['accountId', 'messageId']) });
        }
        if (tail.length) {
          await tx
            .insert(messageFact)
            .values(tail.map((r) => ({ teamId, accountId, ...r })))
            .onConflictDoUpdate({
              target: [messageFact.accountId, messageFact.messageId],
              set: updateAll(messageFact, ['accountId', 'messageId', 'isMass', 'isAutomated', 'automatedReason']),
            });
        }
        // Bulk sends, counted over the stored rows (not this run's only), so a narrower run that re-derives a row from
        // the mass history marks it again; the page's queue ids bound the count.
        const queueIds = [...new Set([...covered, ...tail].flatMap((r) => (r.direction === 'outbound' && r.queueId !== null ? [r.queueId] : [])))];
        if (!queueIds.length) return;
        const outbound = and(owned(messageFact, teamId, [accountId]), eq(messageFact.direction, 'outbound'));
        const bulk = tx
          .select({ queueId: messageFact.queueId })
          .from(messageFact)
          .where(and(outbound, inArray(messageFact.queueId, queueIds)))
          .groupBy(messageFact.queueId)
          .having(sql`count(distinct ${messageFact.chatId}) >= ${BULK_CHATS}`);
        await tx
          .update(messageFact)
          .set({ isMass: true })
          .where(and(outbound, eq(messageFact.isMass, false), inArray(messageFact.queueId, bulk)));
      });
    },
    async coverage(walk) {
      // A narrower walk keeps what an earlier one reached: the older oldest message (with its time) and reached_start.
      const older = sql`(${chatCoverage.oldestMessageId} is null or excluded.oldest_message_id < ${chatCoverage.oldestMessageId})`;
      const [merged] = await db
        .insert(chatCoverage)
        .values({ teamId, accountId, ...walk })
        .onConflictDoUpdate({
          target: [chatCoverage.accountId, chatCoverage.chatId],
          set: {
            teamId: sql`excluded.team_id`,
            fanUsername: sql`coalesce(excluded.fan_username, ${chatCoverage.fanUsername})`,
            fanName: sql`coalesce(excluded.fan_name, ${chatCoverage.fanName})`,
            fanCustomName: sql`coalesce(excluded.fan_custom_name, ${chatCoverage.fanCustomName})`,
            oldestMessageId: sql`least(excluded.oldest_message_id, ${chatCoverage.oldestMessageId})`,
            oldestAt: sql`case when ${older} then excluded.oldest_at else ${chatCoverage.oldestAt} end`,
            reachedStart: sql`excluded.reached_start or ${chatCoverage.reachedStart}`,
            walkedAt: sql`excluded.walked_at`,
          },
        })
        .returning({ oldestAt: chatCoverage.oldestAt, reachedStart: chatCoverage.reachedStart });
      if (!merged) throw new Error(`chat_coverage upsert returned no row for chat ${walk.chatId}`);
      return merged;
    },
    async transactions(rows) {
      if (!rows.length) return;
      await db
        .insert(purchaseFact)
        .values(rows.map((r) => ({ teamId, accountId, ...r })))
        .onConflictDoUpdate({ target: [purchaseFact.accountId, purchaseFact.txId], set: updateAll(purchaseFact, ['accountId', 'txId']) });
    },
    async chatIds() {
      const rows = await db
        .selectDistinct({ chatId: messageFact.chatId })
        .from(messageFact)
        .where(owned(messageFact, teamId, [accountId]));
      return rows.map((r) => r.chatId);
    },
    async payers(from, to) {
      const rows = await db
        .selectDistinct({ fanId: purchaseFact.fanId })
        .from(purchaseFact)
        .where(and(inScope(purchaseFact, { teamId, accountIds: [accountId], from, to }), isNotNull(purchaseFact.fanId)));
      return rows.flatMap((r) => (r.fanId !== null ? [r.fanId] : []));
    },
    async finish(refreshedAt) {
      await syncScripts(teamId, accountId);
      if (!refreshedAt) return;
      await db
        .update(accountWorkspace)
        .set({ refreshedAt: sql`greatest(${accountWorkspace.refreshedAt}, ${refreshedAt.toISOString()}::timestamptz)` })
        .where(and(eq(accountWorkspace.accountId, accountId), eq(accountWorkspace.teamId, teamId)));
    },
  };
}

/**
 * A dry run's store: adds what is read to `rows` (without OF's objects) and stores nothing, marking bulk sends mass
 * as `dbStore` does. Coverage is the walk's own; the stored chats are those of `rows`.
 */
export function memoryStore(rows: BackfillRows): BackfillStore {
  /** The outbound rows by queue id, with their chats. */
  const sends = new Map<number, { chats: Set<number>; rows: DerivedMessage[] }>();
  return {
    async messages(covered, tail) {
      const page = [...covered, ...tail].map(({ raw: _r, fetchedAt: _f, ...d }) => d);
      rows.messages.push(...page);
      const touched = new Set<{ chats: Set<number>; rows: DerivedMessage[] }>();
      for (const m of page) {
        if (m.direction !== 'outbound' || m.queueId === null) continue;
        const send = sends.get(m.queueId) ?? { chats: new Set<number>(), rows: [] };
        sends.set(m.queueId, send);
        send.chats.add(m.chatId);
        send.rows.push(m);
        touched.add(send);
      }
      for (const send of touched) if (send.chats.size >= BULK_CHATS) for (const m of send.rows) m.isMass = true;
    },
    async coverage(walk) {
      rows.chats.push(walk);
      return walk;
    },
    async transactions(list) {
      rows.transactions.push(...list.map(({ raw: _r, ...d }) => d));
    },
    async chatIds() {
      return rows.messages.map((m) => m.chatId);
    },
    async payers(from, to) {
      return rows.transactions.flatMap((t) => (t.fanId !== null && t.createdAt >= from && t.createdAt < to ? [t.fanId] : []));
    },
    async finish() {},
  };
}
