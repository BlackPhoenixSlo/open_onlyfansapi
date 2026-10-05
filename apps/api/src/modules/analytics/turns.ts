import { and, eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { messageFact } from '../../db/schema.js';
import { REPLY_CAP_MS } from './config.js';

export type TurnMessage = {
  chatId: number;
  messageId: number;
  createdAt: Date;
  direction: 'inbound' | 'outbound';
  isMass: boolean;
  isAutomated: boolean;
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
  /** The DM that ended the turn; null = still open. */
  dmAt: Date | null;
  /** `dmAt - inboundAt`; null while open. */
  waitSeconds: number | null;
  status: TurnStatus;
  /** An automated message (welcome, automation) went out during the turn; it did not end it. */
  isAutomated: boolean;
};

const byTime = (a: TurnMessage, b: TurnMessage) => a.createdAt.getTime() - b.createdAt.getTime() || a.messageId - b.messageId;

/**
 * Fan turns (spec §2): in each chat, ordered by `(createdAt, id)`, a turn runs from the first inbound after a DM to
 * the next DM. A DM is an outbound that is neither mass nor automated; mass and automated messages do not end a
 * turn. A turn still open at `asOf` breaches only once the cap has elapsed (before that it is pending).
 */
export function fanTurns(messages: TurnMessage[], opts: { asOf: Date }): FanTurn[] {
  const chats = new Map<number, TurnMessage[]>();
  for (const m of messages) {
    const list = chats.get(m.chatId) ?? [];
    list.push(m);
    chats.set(m.chatId, list);
  }
  const turns: FanTurn[] = [];
  for (const [chatId, list] of chats) {
    let open: { inboundAt: Date; isAutomated: boolean } | null = null;
    for (const m of list.sort(byTime)) {
      if (m.direction === 'inbound') {
        open ??= { inboundAt: m.createdAt, isAutomated: false };
      } else if (open && m.isAutomated) {
        open.isAutomated = true;
      } else if (open && !m.isMass) {
        const wait = m.createdAt.getTime() - open.inboundAt.getTime();
        turns.push({ chatId, inboundAt: open.inboundAt, dmAt: m.createdAt, waitSeconds: wait / 1000, status: wait > REPLY_CAP_MS ? 'late' : 'in_cap', isAutomated: open.isAutomated });
        open = null;
      }
    }
    if (open) {
      const status = opts.asOf.getTime() - open.inboundAt.getTime() > REPLY_CAP_MS ? 'breached' : 'pending';
      turns.push({ chatId, inboundAt: open.inboundAt, dmAt: null, waitSeconds: null, status, isAutomated: open.isAutomated });
    }
  }
  return turns.sort((a, b) => a.inboundAt.getTime() - b.inboundAt.getTime() || a.chatId - b.chatId);
}

/** The fan turns of one account that start in `[from, to)`, read from `message_fact` of workspace `teamId` only. */
export async function replyTimes(teamId: string, accountId: number, from: Date, to: Date, asOf = new Date()): Promise<FanTurn[]> {
  const rows = await db
    .select({
      chatId: messageFact.chatId,
      messageId: messageFact.messageId,
      createdAt: messageFact.createdAt,
      direction: messageFact.direction,
      isMass: messageFact.isMass,
      isAutomated: messageFact.isAutomated,
    })
    .from(messageFact)
    .where(and(eq(messageFact.teamId, teamId), eq(messageFact.accountId, accountId)));
  return fanTurns(rows, { asOf }).filter((t) => t.inboundAt >= from && t.inboundAt < to);
}
