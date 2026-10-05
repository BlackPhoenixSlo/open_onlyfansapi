import { and, eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { chatCoverage } from '../../db/schema.js';
import type { TurnMessage } from './turns.js';

/**
 * `first_ever`: nothing but mass or automated messages is stored before it and the chat was walked to its start;
 * `reactivation`: an earlier fan message or DM is stored, `open_gap` or more before it; `unknown`: nothing earlier is
 * stored and the walk did not reach the chat's start, so the gap runs off our coverage.
 */
export type OpenerKind = 'first_ever' | 'reactivation' | 'unknown';

/**
 * `replied`: a fan message within `open_reply`; `no_reply`: none within it and it has elapsed at `asOf`;
 * `pending`: none yet and the window has not elapsed.
 */
export type OpenerStatus = 'replied' | 'no_reply' | 'pending';

export type Opener = {
  chatId: number;
  messageId: number;
  sentAt: Date;
  kind: OpenerKind;
  /** The last fan message or DM before it (a reactivation); null when none is stored. */
  previousMessageId: number | null;
  previousAt: Date | null;
  previousDirection: 'inbound' | 'outbound' | null;
  /** Mass and automated messages since the previous fan message or DM (or the oldest stored message): they do not reset the gap. */
  ignoredInGap: number;
  /** The fan's first message after it (up to `asOf`), within the window or not; null when none. */
  fanReplyMessageId: number | null;
  fanReplyAt: Date | null;
  /** `fanReplyAt - sentAt`; null with no fan message. */
  fanReplySeconds: number | null;
  status: OpenerStatus;
};

export type OpenerOptions = { asOf: Date; openGapMs: number; openReplyMs: number };

const byTime = (a: TurnMessage, b: TurnMessage) => a.createdAt.getTime() - b.createdAt.getTime() || a.messageId - b.messageId;
const isDm = (m: TurnMessage) => m.direction === 'outbound' && !m.isMass && !m.isAutomated;

/**
 * Openers (spec §2): in each chat, ordered by `(createdAt, id)`, a DM with no fan message and no DM in the
 * `open_gap` before it. Mass and automated messages do not reset the gap, and a fan message in the gap makes the DM
 * a reply, so the fan never wrote first. `reachedStart` holds the chats whose walk reached their first message
 * (`chat_coverage.reached_start`).
 */
export function chatOpeners(messages: TurnMessage[], reachedStart: Set<number>, opts: OpenerOptions): Opener[] {
  const chats = new Map<number, TurnMessage[]>();
  for (const m of messages) chats.set(m.chatId, [...(chats.get(m.chatId) ?? []), m]);
  const openers: Opener[] = [];
  for (const [chatId, list] of chats) {
    list.sort(byTime);
    let previous: TurnMessage | null = null;
    let ignored = 0;
    for (const [i, m] of list.entries()) {
      if (m.direction === 'outbound' && !isDm(m)) {
        ignored++;
        continue;
      }
      const gapClear = previous === null || m.createdAt.getTime() - previous.createdAt.getTime() >= opts.openGapMs;
      if (isDm(m) && gapClear) {
        const kind: OpenerKind = previous ? 'reactivation' : reachedStart.has(chatId) ? 'first_ever' : 'unknown';
        const reply = list.slice(i + 1).find((x) => x.direction === 'inbound' && x.createdAt <= opts.asOf) ?? null;
        const wait = reply ? reply.createdAt.getTime() - m.createdAt.getTime() : null;
        const status: OpenerStatus =
          wait !== null && wait <= opts.openReplyMs ? 'replied' : opts.asOf.getTime() - m.createdAt.getTime() <= opts.openReplyMs ? 'pending' : 'no_reply';
        openers.push({
          chatId,
          messageId: m.messageId,
          sentAt: m.createdAt,
          kind,
          previousMessageId: previous?.messageId ?? null,
          previousAt: previous?.createdAt ?? null,
          previousDirection: previous?.direction ?? null,
          ignoredInGap: ignored,
          fanReplyMessageId: reply?.messageId ?? null,
          fanReplyAt: reply?.createdAt ?? null,
          fanReplySeconds: wait === null ? null : wait / 1000,
          status,
        });
      }
      previous = m;
      ignored = 0;
    }
  }
  return openers.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime() || a.chatId - b.chatId);
}

/** The chats of one account in workspace `teamId` whose walk reached their first message. */
export async function reachedStartChats(teamId: string, accountId: number): Promise<Set<number>> {
  const rows = await db
    .select({ chatId: chatCoverage.chatId })
    .from(chatCoverage)
    .where(and(eq(chatCoverage.teamId, teamId), eq(chatCoverage.accountId, accountId), eq(chatCoverage.reachedStart, true)));
  return new Set(rows.map((r) => r.chatId));
}
