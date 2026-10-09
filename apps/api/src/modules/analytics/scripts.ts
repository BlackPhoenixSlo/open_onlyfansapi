import { and, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { chatCoverage, messageFact, script } from '../../db/schema.js';
import type { StatsConfig, StatsScript } from '../../contracts.js';
import { fanNames, messageFanNames, NORMALISER_VERSION, normaliseText, scriptHash } from './derive.js';
import { statusAsOf, workspaceAccounts } from './metrics.js';

// Script candidates (spec §2 "Script", "Script sends", "Script reply rate"; §6 step 3): auto-detected DM text
// hashes with their exact variants, sends and reply rate. No money.

const DAY_MS = 86_400_000;
export const SCRIPT_MIN_SENDS = 5;
export const SCRIPT_MIN_CHATS = 3;
export const SCRIPT_WINDOW_MS = 30 * DAY_MS;
/** Exact variants listed per script, most sent first. */
export const MAX_VARIANTS = 5;
const CHUNK = 500;

type Send = { at: Date; chatId: number };

/** A script (§2): 5+ sends in 3+ chats within 30 days of each other. */
export function isScript(sends: Send[]): boolean {
  const list = [...sends].sort((a, b) => a.at.getTime() - b.at.getTime());
  const chats = new Map<number, number>();
  let start = 0;
  for (const [end, s] of list.entries()) {
    chats.set(s.chatId, (chats.get(s.chatId) ?? 0) + 1);
    while (s.at.getTime() - list[start]!.at.getTime() > SCRIPT_WINDOW_MS) {
      const c = list[start++]!.chatId;
      const n = chats.get(c)! - 1;
      if (n) chats.set(c, n);
      else chats.delete(c);
    }
    if (end - start + 1 >= SCRIPT_MIN_SENDS && chats.size >= SCRIPT_MIN_CHATS) return true;
  }
  return false;
}

const scoped = (teamId: string, accountId: number) => and(eq(messageFact.teamId, teamId), eq(messageFact.accountId, accountId));
/** The sends `isScript` decides on: DMs (outbound, not mass, not automated) hashed by the current normaliser version. */
const scriptSends = and(
  eq(messageFact.direction, 'outbound'),
  eq(messageFact.isMass, false),
  eq(messageFact.isAutomated, false),
  isNotNull(messageFact.textHash),
  eq(messageFact.normaliserVersion, NORMALISER_VERSION),
);
const rawText = sql<string | null>`${messageFact.raw}->>'text'`;

// Only `message_fact` rows hashed by the current `NORMALISER_VERSION` count: hashes of other versions are not
// comparable. Rows stored before migration 0010 have no version (and no name replacement), so after deploying it run
// `analytics:rehash` per account to bring them in; until then they are left out of scripts.

/**
 * Upserts the `script` rows of one account's DMs (outbound, not mass, not automated, with a script hash of the
 * current normaliser version) in workspace `teamId`: every hash that is a script on this account. Rows are never
 * deleted. Returns the scripts found.
 */
export async function syncScripts(teamId: string, accountId: number): Promise<number> {
  const rows = await db
    .select({ hash: messageFact.textHash, chatId: messageFact.chatId, at: messageFact.createdAt })
    .from(messageFact)
    .where(and(scoped(teamId, accountId), scriptSends));
  const byHash = new Map<string, Send[]>();
  for (const r of rows) {
    const sends = byHash.get(r.hash!);
    if (sends) sends.push(r);
    else byHash.set(r.hash!, [r]);
  }
  const values = [...byHash].filter(([, sends]) => isScript(sends)).map(([hash]) => ({ teamId, hash, normaliserVersion: NORMALISER_VERSION }));
  for (let i = 0; i < values.length; i += CHUNK) {
    await db
      .insert(script)
      .values(values.slice(i, i + CHUNK))
      .onConflictDoUpdate({ target: [script.teamId, script.hash], set: { normaliserVersion: sql`excluded.normaliser_version` } });
  }
  return values.length;
}

/**
 * Rebuilds `text_hash` and `normaliser_version` of one account's outbound rows in workspace `teamId` from the stored
 * raw text, with the fan's names from `chat_coverage` and the message, then syncs its scripts. Only rows whose hash
 * or version changes are written, so a second run updates nothing.
 */
export async function rehashAccount(teamId: string, accountId: number): Promise<{ outbound: number; updated: number; scripts: number }> {
  const coverage = await db
    .select({ chatId: chatCoverage.chatId, username: chatCoverage.fanUsername, name: chatCoverage.fanName, displayName: chatCoverage.fanCustomName })
    .from(chatCoverage)
    .where(and(eq(chatCoverage.teamId, teamId), eq(chatCoverage.accountId, accountId)));
  const names = new Map(coverage.map(({ chatId, ...user }) => [chatId, fanNames(user)]));
  const rows = await db
    .select({
      messageId: messageFact.messageId,
      chatId: messageFact.chatId,
      textHash: messageFact.textHash,
      normaliserVersion: messageFact.normaliserVersion,
      text: rawText,
      fromUser: sql<unknown>`${messageFact.raw}->'fromUser'`,
      toUser: sql<unknown>`${messageFact.raw}->'toUser'`,
    })
    .from(messageFact)
    .where(and(scoped(teamId, accountId), eq(messageFact.direction, 'outbound')));
  const changed = rows.flatMap((r) => {
    const hash = scriptHash(r.text, [...(names.get(r.chatId) ?? []), ...messageFanNames({ fromUser: r.fromUser, toUser: r.toUser }, r.chatId)]);
    return hash === r.textHash && r.normaliserVersion === NORMALISER_VERSION ? [] : [{ messageId: r.messageId, hash }];
  });
  for (let i = 0; i < changed.length; i += CHUNK) {
    const list = sql.join(
      changed.slice(i, i + CHUNK).map((c) => sql`(${c.messageId}::bigint, ${c.hash}::text)`),
      sql`, `,
    );
    await db.execute(sql`
      update message_fact set text_hash = v.hash, normaliser_version = ${NORMALISER_VERSION}
      from (values ${list}) as v(message_id, hash)
      where message_fact.team_id = ${teamId} and message_fact.account_id = ${accountId} and message_fact.message_id = v.message_id`);
  }
  return { outbound: rows.length, updated: changed.length, scripts: await syncScripts(teamId, accountId) };
}

type Row = {
  messageId: number;
  chatId: number;
  createdAt: Date;
  direction: 'inbound' | 'outbound';
  isMass: boolean;
  isAutomated: boolean;
  textHash: string | null;
  normaliserVersion: number | null;
  /** Inbound and hashed outbound rows only. */
  text: string | null;
};
type Status = 'replied' | 'no_reply' | 'pending';
type Tally = {
  hash: string;
  origin: 'auto';
  sends: number;
  chats: Set<string>;
  first: Date;
  last: Date;
  variants: Map<string, number>;
  status: Record<Status, number>;
  substantive: Record<Status, number>;
};

const byTime = (a: Row, b: Row) => a.createdAt.getTime() - b.createdAt.getTime() || a.messageId - b.messageId;
const isDm = (m: Row) => m.direction === 'outbound' && !m.isMass && !m.isAutomated;
const rate = (s: Record<Status, number>) => (s.replied + s.no_reply ? (s.replied / (s.replied + s.no_reply)) * 100 : null);

/**
 * The scripts of workspace `teamId` (its `script` rows of the current normaliser version) sent in `[from, to)` over
 * `accountIds` (null = every account the workspace has rows for), most sent first. Being a script is decided over the
 * whole history (`syncScripts`); `sends`, `chats`, the first and last send and the variants count every send of the
 * hash in range, and `sendsAll`/`chatsAll` all stored DM sends of it over the same accounts (the population script
 * detection reads), in range or not. Reply rate is per outbound sequence (consecutive DMs with no fan message between; mass and automated
 * messages neither join nor end it): a sequence holding a send of the script in range counts once, replied when a fan
 * message arrives within `open_reply` after its last DM, pending while that window has not elapsed at the account's
 * `statusAsOf` (`asOf` when it has none), as for openers. The
 * substantive variant counts only a fan message of `min_reply_chars`+ (normalised text, code points).
 *
 * Reads `[from, to + open_reply)` per account: a sequence's DMs before `from` are not sends in range and do not move
 * its last DM, so `from` needs no lookback; `to + open_reply` decides every sequence whose last DM is by `to`. A
 * sequence still running past `to` is judged on its DMs read (one past `to + open_reply` and its fan reply are not).
 */
export async function scopedScripts(
  teamId: string,
  accountIds: number[] | null,
  cfg: StatsConfig,
  range: { from: Date; to: Date; asOf: Date },
): Promise<StatsScript[]> {
  const known = new Map(
    (
      await db
        .select({ hash: script.hash, origin: script.origin })
        .from(script)
        .where(and(eq(script.teamId, teamId), eq(script.normaliserVersion, NORMALISER_VERSION)))
    ).map((s) => [s.hash, s.origin]),
  );
  if (!known.size) return [];
  const openReplyMs = cfg.openReplySeconds * 1000;
  const tallies = new Map<string, Tally>();
  const accounts = await workspaceAccounts(teamId, accountIds);
  const judgedAt = await statusAsOf(teamId, accountIds, range.asOf);
  const inRange = (m: Row) =>
    m.textHash !== null && m.normaliserVersion === NORMALISER_VERSION && known.has(m.textHash) && m.createdAt >= range.from && m.createdAt < range.to;

  for (const accountId of accounts) {
    const asOf = judgedAt(accountId).getTime();
    const rows: Row[] = await db
      .select({
        messageId: messageFact.messageId,
        chatId: messageFact.chatId,
        createdAt: messageFact.createdAt,
        direction: messageFact.direction,
        isMass: messageFact.isMass,
        isAutomated: messageFact.isAutomated,
        textHash: messageFact.textHash,
        normaliserVersion: messageFact.normaliserVersion,
        text: sql<string | null>`case when ${messageFact.direction} = 'inbound' or ${messageFact.textHash} is not null then ${rawText} end`,
      })
      .from(messageFact)
      .where(
        and(
          scoped(teamId, accountId),
          gte(messageFact.createdAt, range.from),
          lt(messageFact.createdAt, new Date(range.to.getTime() + openReplyMs)),
        ),
      );
    const chats = new Map<number, Row[]>();
    for (const m of rows) {
      const list = chats.get(m.chatId);
      if (list) list.push(m);
      else chats.set(m.chatId, [m]);
    }

    for (const [chatId, list] of chats) {
      list.sort(byTime);
      // Each sequence: its DMs and the index of its last DM.
      const sequences: { dms: Row[]; end: number }[] = [];
      let open: Row[] = [];
      for (const [i, m] of list.entries()) {
        if (isDm(m)) {
          open.push(m);
          if (open.length === 1) sequences.push({ dms: open, end: i });
          sequences[sequences.length - 1]!.end = i;
        } else if (m.direction === 'inbound') open = [];
      }
      for (const { dms, end } of sequences) {
        const sends = dms.filter(inRange);
        if (!sends.length) continue;
        const lastAt = list[end]!.createdAt.getTime();
        const within = list.slice(end + 1).filter((m) => m.direction === 'inbound' && m.createdAt.getTime() - lastAt <= openReplyMs && m.createdAt.getTime() <= asOf);
        const status = (found: boolean): Status => (found ? 'replied' : asOf - lastAt <= openReplyMs ? 'pending' : 'no_reply');
        const replied = status(within.length > 0);
        const substantive = status(within.some((m) => [...normaliseText(m.text ?? '')].length >= cfg.minReplyChars));
        for (const hash of new Set(sends.map((s) => s.textHash!))) {
          const own = sends.filter((x) => x.textHash === hash);
          let t = tallies.get(hash);
          if (!t) {
            // From this hash's own first send: the sequence may open with another script's send.
            const at = own[0]!.createdAt;
            t = { hash, origin: known.get(hash)!, sends: 0, chats: new Set(), first: at, last: at, variants: new Map(), status: { replied: 0, no_reply: 0, pending: 0 }, substantive: { replied: 0, no_reply: 0, pending: 0 } };
            tallies.set(hash, t);
          }
          for (const s of own) {
            t.sends++;
            if (s.createdAt < t.first) t.first = s.createdAt;
            if (s.createdAt > t.last) t.last = s.createdAt;
            t.variants.set(s.text ?? '', (t.variants.get(s.text ?? '') ?? 0) + 1);
          }
          t.chats.add(`${accountId}:${chatId}`);
          t.status[replied]++;
          t.substantive[substantive]++;
        }
      }
    }
  }

  // All-history totals of the hashes sent in range; chat ids are fan ids and repeat across accounts, so count pairs.
  const all = new Map<string, { sends: number; chats: number }>();
  if (tallies.size) {
    const totals = await db
      .select({
        hash: messageFact.textHash,
        sends: sql<number>`count(*)::int`,
        chats: sql<number>`count(distinct (${messageFact.accountId}, ${messageFact.chatId}))::int`,
      })
      .from(messageFact)
      .where(and(eq(messageFact.teamId, teamId), inArray(messageFact.accountId, accounts), scriptSends, inArray(messageFact.textHash, [...tallies.keys()])))
      .groupBy(messageFact.textHash);
    for (const r of totals) all.set(r.hash!, { sends: r.sends, chats: r.chats });
  }

  return [...tallies.values()]
    .sort((a, b) => b.sends - a.sends || a.hash.localeCompare(b.hash))
    .map((t) => ({
      hash: t.hash,
      origin: t.origin,
      sends: t.sends,
      chats: t.chats.size,
      sendsAll: all.get(t.hash)?.sends ?? 0,
      chatsAll: all.get(t.hash)?.chats ?? 0,
      firstSentAt: t.first.toISOString(),
      lastSentAt: t.last.toISOString(),
      sequences: t.status.replied + t.status.no_reply + t.status.pending,
      replied: t.status.replied,
      noReply: t.status.no_reply,
      pending: t.status.pending,
      replyRate: rate(t.status),
      substantiveReplied: t.substantive.replied,
      substantiveNoReply: t.substantive.no_reply,
      substantivePending: t.substantive.pending,
      substantiveReplyRate: rate(t.substantive),
      variantCount: t.variants.size,
      variants: [...t.variants]
        .sort(([ta, a], [tb, b]) => b - a || ta.localeCompare(tb))
        .slice(0, MAX_VARIANTS)
        .map(([text, count]) => ({ text, count })),
    }));
}
