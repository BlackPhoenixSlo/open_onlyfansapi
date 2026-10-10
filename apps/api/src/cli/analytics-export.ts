// Reads one account's backfilled range from the analytics tables (or from a dry run's rows) and writes the step 0 CSVs (analytics-csv.ts).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, asc, eq, gte, lt } from 'drizzle-orm';
import { db } from '../db/index.js';
import { chatCoverage, messageFact, purchaseFact } from '../db/schema.js';
import { accountOwner } from '../modules/accounts/ownership.js';
import type { BackfillRows } from '../modules/analytics/backfill.js';
import { fanTurns, replyTimes } from '../modules/analytics/turns.js';
import { exportFiles, type ExportData } from './analytics-csv.js';

/** The client's automation texts (`analytics:backfill --automation`): one per line, blank lines ignored. */
export async function readAutomationTexts(file: string): Promise<string[]> {
  return (await readFile(file, 'utf8')).split(/\r?\n/).filter((line) => line.trim() !== '');
}

/** `team` when given, else the workspace that owns the account (`analytics:claim` records it). */
export async function accountTeam(accountId: number, team?: string): Promise<string> {
  if (team) return team;
  const owner = await accountOwner(accountId);
  if (!owner) throw new Error(`account ${accountId} belongs to no workspace: pass --team <teamId> or run analytics:claim first`);
  return owner.teamId;
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
  return writeFiles(opts.outDir, { messages, chats, transactions, turns });
}

/**
 * The same four CSVs from the rows a dry run read (`analytics:backfill --dry-run`) instead of the database: chats
 * are this run's walks only, and reply times see only the messages walked (back to each chat's boundary page).
 */
export async function writeRowsExport(opts: { rows: BackfillRows; from: Date; to: Date; outDir: string; asOf?: Date }) {
  const { rows, from, to } = opts;
  const inRange = (t: Date) => t >= from && t < to;
  const messages = rows.messages.filter((m) => inRange(m.createdAt)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.messageId - b.messageId);
  const chats = [...rows.chats].sort((a, b) => a.chatId - b.chatId);
  const transactions = rows.transactions
    .filter((t) => inRange(t.createdAt))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.txId < b.txId ? -1 : a.txId > b.txId ? 1 : 0));
  const turns = fanTurns(rows.messages, { asOf: opts.asOf ?? new Date() }).filter((t) => inRange(t.inboundAt));
  return writeFiles(opts.outDir, { messages, chats, transactions, turns });
}

async function writeFiles(outDir: string, data: ExportData) {
  await mkdir(outDir, { recursive: true });
  for (const [name, content] of Object.entries(exportFiles(data))) {
    await writeFile(join(outDir, name), content);
  }
  return { messages: data.messages.length, chats: data.chats.length, transactions: data.transactions.length, replyTimes: data.turns.length };
}
