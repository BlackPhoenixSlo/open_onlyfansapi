import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { messageFact } from '../../db/schema.js';
import { REPLY_CAP_MS } from './config.js';
import { normaliseText } from './derive.js';

export type TurnMessage = {
  chatId: number;
  messageId: number;
  createdAt: Date;
  direction: 'inbound' | 'outbound';
  isMass: boolean;
  isAutomated: boolean;
  /** Outbound text length in code points after `normaliseText` (as `isScriptEligible`); only read when `minReplyChars` is set. */
  textChars?: number;
};

/**
 * `in_cap`: replied within the reply cap; `late`: replied after it; `breached`: no reply and the cap has elapsed at
 * `asOf`; `pending`: no reply and the cap has not elapsed yet.
 */
export type TurnStatus = 'in_cap' | 'late' | 'breached' | 'pending';

export type FanTurn = {
  chatId: number;
  /** The turn's first inbound message. */
  inboundAt: Date;
  inboundMessageId: number;
  /** The turn's last inbound message before its reply (or so far, while open): Infloww's other turn start. */
  lastInboundAt: Date;
  lastInboundMessageId: number;
  /** The DM that ended the turn; null = still open. */
  dmAt: Date | null;
  dmMessageId: number | null;
  /** `dmAt - inboundAt`; null while open. */
  waitSeconds: number | null;
  status: TurnStatus;
  /** An automated message (welcome, automation) went out during the turn; it did not end it. */
  isAutomated: boolean;
};

export type TurnOptions = {
  asOf: Date;
  /** Default: the 12 h `REPLY_CAP_MS`. */
  replyCapMs?: number;
  /** Substantive variant: a DM shorter than this (`textChars`) does not end the turn. Default 0: any DM does. */
  minReplyChars?: number;
};

const byTime = (a: TurnMessage, b: TurnMessage) => a.createdAt.getTime() - b.createdAt.getTime() || a.messageId - b.messageId;

/**
 * Fan turns (spec §2): in each chat, ordered by `(createdAt, id)`, a turn runs from the first inbound after a DM to
 * the next DM. A DM is an outbound that is neither mass nor automated; mass and automated messages do not end a
 * turn. A turn still open at `asOf` breaches only once the cap has elapsed (before that it is pending).
 */
export function fanTurns(messages: TurnMessage[], opts: TurnOptions): FanTurn[] {
  const cap = opts.replyCapMs ?? REPLY_CAP_MS;
  const minChars = opts.minReplyChars ?? 0;
  const chats = new Map<number, TurnMessage[]>();
  for (const m of messages) {
    const list = chats.get(m.chatId) ?? [];
    list.push(m);
    chats.set(m.chatId, list);
  }
  const turns: FanTurn[] = [];
  for (const [chatId, list] of chats) {
    let open: Pick<FanTurn, 'inboundAt' | 'inboundMessageId' | 'lastInboundAt' | 'lastInboundMessageId' | 'isAutomated'> | null = null;
    for (const m of list.sort(byTime)) {
      if (m.direction === 'inbound') {
        open ??= { inboundAt: m.createdAt, inboundMessageId: m.messageId, lastInboundAt: m.createdAt, lastInboundMessageId: m.messageId, isAutomated: false };
        open.lastInboundAt = m.createdAt;
        open.lastInboundMessageId = m.messageId;
      } else if (open && m.isAutomated) {
        open.isAutomated = true;
      } else if (open && !m.isMass && (m.textChars ?? 0) >= minChars) {
        const wait = m.createdAt.getTime() - open.inboundAt.getTime();
        turns.push({ chatId, ...open, dmAt: m.createdAt, dmMessageId: m.messageId, waitSeconds: wait / 1000, status: wait > cap ? 'late' : 'in_cap' });
        open = null;
      }
    }
    if (open) {
      const status = opts.asOf.getTime() - open.inboundAt.getTime() > cap ? 'breached' : 'pending';
      turns.push({ chatId, ...open, dmAt: null, dmMessageId: null, waitSeconds: null, status });
    }
  }
  return turns.sort((a, b) => a.inboundAt.getTime() - b.inboundAt.getTime() || a.chatId - b.chatId);
}

export type TurnMessageRange = {
  /** Read each chat from its anchor before this instant (see `turnMessages`); default: the whole history. */
  from?: Date;
  /** Leave out messages at this instant or later; default: none. */
  to?: Date;
  /** Measure outbound text for `textChars` (the substantive variant only); default false. */
  text?: boolean;
};

/**
 * The stored messages of one account in workspace `teamId`, as turn input. With `from`, each chat is read from its
 * anchor instead of its whole history: the earlier of its latest fan message and its latest DM before `from`, or its
 * oldest stored message when it has neither, or `from` when nothing of it is stored before `from`. That lookback is
 * exact (not a fixed reply_cap or open_gap window): from the latest fan message on, a fan turn open at `from` is seen
 * open and starting before `from` (so it is never split into a turn in range), whatever DMs ended or did not end it;
 * from the latest fan message or DM on, an opener in range sees its previous fan message or DM and the mass and
 * automated messages since.
 */
export async function turnMessages(teamId: string, accountId: number, range: TurnMessageRange = {}): Promise<TurnMessage[]> {
  const scope = and(eq(messageFact.teamId, teamId), eq(messageFact.accountId, accountId));
  const anchor = range.from
    ? db
        .select({
          chatId: messageFact.chatId,
          at: sql<Date>`coalesce(least(
              max(${messageFact.createdAt}) filter (where ${messageFact.direction} = 'inbound'),
              max(${messageFact.createdAt}) filter (where ${messageFact.direction} = 'outbound' and not ${messageFact.isMass} and not ${messageFact.isAutomated})
            ), min(${messageFact.createdAt}))`.as('at'),
        })
        .from(messageFact)
        .where(and(scope, lt(messageFact.createdAt, range.from)))
        .groupBy(messageFact.chatId)
        .as('anchor')
    : null;
  const query = db
    .select({
      chatId: messageFact.chatId,
      messageId: messageFact.messageId,
      createdAt: messageFact.createdAt,
      direction: messageFact.direction,
      isMass: messageFact.isMass,
      isAutomated: messageFact.isAutomated,
      text: range.text ? sql<string | null>`case when ${messageFact.direction} = 'outbound' then ${messageFact.raw}->>'text' end` : sql<null>`null`,
    })
    .from(messageFact)
    .$dynamic();
  if (anchor) query.leftJoin(anchor, eq(anchor.chatId, messageFact.chatId));
  const rows = await query.where(
    and(
      scope,
      anchor ? gte(messageFact.createdAt, sql`coalesce(${anchor.at}, ${range.from!.toISOString()}::timestamptz)`) : undefined,
      range.to ? lt(messageFact.createdAt, range.to) : undefined,
    ),
  );
  return rows.map(({ text, ...m }) => (range.text ? { ...m, textChars: text ? [...normaliseText(text)].length : 0 } : m));
}

/** The fan turns of one account that start in `[from, to)`, read from `message_fact` of workspace `teamId` only. */
export async function replyTimes(teamId: string, accountId: number, from: Date, to: Date, asOf = new Date()): Promise<FanTurn[]> {
  return fanTurns(await turnMessages(teamId, accountId, { from }), { asOf }).filter((t) => t.inboundAt >= from && t.inboundAt < to);
}
