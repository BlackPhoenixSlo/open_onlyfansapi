import { and, eq, sql } from 'drizzle-orm';
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
  /** Outbound text length after tag strip (the script normaliser); only read when `minReplyChars` is set. */
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

/** Every stored message of one account in workspace `teamId`, as turn input; outbound text measured for `textChars`. */
export async function turnMessages(teamId: string, accountId: number): Promise<TurnMessage[]> {
  const rows = await db
    .select({
      chatId: messageFact.chatId,
      messageId: messageFact.messageId,
      createdAt: messageFact.createdAt,
      direction: messageFact.direction,
      isMass: messageFact.isMass,
      isAutomated: messageFact.isAutomated,
      text: sql<string | null>`case when ${messageFact.direction} = 'outbound' then ${messageFact.raw}->>'text' end`,
    })
    .from(messageFact)
    .where(and(eq(messageFact.teamId, teamId), eq(messageFact.accountId, accountId)));
  return rows.map(({ text, ...m }) => ({ ...m, textChars: text ? normaliseText(text).length : 0 }));
}

/** The fan turns of one account that start in `[from, to)`, read from `message_fact` of workspace `teamId` only. */
export async function replyTimes(teamId: string, accountId: number, from: Date, to: Date, asOf = new Date()): Promise<FanTurn[]> {
  return fanTurns(await turnMessages(teamId, accountId), { asOf }).filter((t) => t.inboundAt >= from && t.inboundAt < to);
}
