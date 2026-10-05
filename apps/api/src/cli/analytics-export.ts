// Reads one account's backfilled range from the analytics tables and writes the step 0 CSVs (analytics-csv.ts).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, asc, eq, gte, lt } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accountWorkspace, chatCoverage, messageFact, purchaseFact } from '../db/schema.js';
import { replyTimes } from '../modules/analytics/turns.js';
import { exportFiles } from './analytics-csv.js';

/** The client's automation texts (`analytics:backfill --automation`): one per line, blank lines ignored. */
export async function readAutomationTexts(file: string): Promise<string[]> {
  return (await readFile(file, 'utf8')).split(/\r?\n/).filter((line) => line.trim() !== '');
}

/** `team` when given, else the workspace that owns the account (`analytics:claim` records it). */
export async function accountTeam(accountId: number, team?: string): Promise<string> {
  if (team) return team;
  const rows = await db.select({ teamId: accountWorkspace.teamId }).from(accountWorkspace).where(eq(accountWorkspace.accountId, accountId));
  if (rows.length !== 1) throw new Error(`account ${accountId} belongs to no workspace: pass --team <teamId> or run analytics:claim first`);
  return rows[0]!.teamId;
}

/** Writes messages.csv, chats.csv, transactions.csv and reply_times.csv for `[from, to)` to `outDir`; returns row counts. */
export async function writeExport(opts: { teamId: string; accountId: number; from: Date; to: Date; outDir: string; asOf?: Date }) {
  const { teamId, accountId, from, to } = opts;
  const messages = await db
    .select({
      messageId: messageFact.messageId,
      chatId: messageFact.chatId,
      createdAt: messageFact.createdAt,
      direction: messageFact.direction,
      isMass: messageFact.isMass,
      queueId: messageFact.queueId,
      isAutomated: messageFact.isAutomated,
      automatedReason: messageFact.automatedReason,
      priceCents: messageFact.priceCents,
      isTip: messageFact.isTip,
      mediaCount: messageFact.mediaCount,
      textHash: messageFact.textHash,
    })
    .from(messageFact)
    .where(and(eq(messageFact.teamId, teamId), eq(messageFact.accountId, accountId), gte(messageFact.createdAt, from), lt(messageFact.createdAt, to)))
    .orderBy(asc(messageFact.createdAt), asc(messageFact.messageId));
  const chats = await db
    .select({
      chatId: chatCoverage.chatId,
      fanUsername: chatCoverage.fanUsername,
      oldestMessageId: chatCoverage.oldestMessageId,
      oldestAt: chatCoverage.oldestAt,
      reachedStart: chatCoverage.reachedStart,
      walkedAt: chatCoverage.walkedAt,
    })
    .from(chatCoverage)
    .where(and(eq(chatCoverage.teamId, teamId), eq(chatCoverage.accountId, accountId)))
    .orderBy(asc(chatCoverage.chatId));
  const transactions = await db
    .select({
      txId: purchaseFact.txId,
      createdAt: purchaseFact.createdAt,
      kind: purchaseFact.kind,
      grossCents: purchaseFact.grossCents,
      netCents: purchaseFact.netCents,
      currency: purchaseFact.currency,
      fanId: purchaseFact.fanId,
      fanIdSource: purchaseFact.fanIdSource,
    })
    .from(purchaseFact)
    .where(and(eq(purchaseFact.teamId, teamId), eq(purchaseFact.accountId, accountId), gte(purchaseFact.createdAt, from), lt(purchaseFact.createdAt, to)))
    .orderBy(asc(purchaseFact.createdAt), asc(purchaseFact.txId));
  const turns = await replyTimes(teamId, accountId, from, to, opts.asOf);

  await mkdir(opts.outDir, { recursive: true });
  for (const [name, content] of Object.entries(exportFiles({ messages, chats, transactions, turns }))) {
    await writeFile(join(opts.outDir, name), content);
  }
  return { messages: messages.length, chats: chats.length, transactions: transactions.length, replyTimes: turns.length };
}
