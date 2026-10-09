import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { accountWorkspace, messageFact, purchaseFact } from '../../db/schema.js';

/** A stats request's workspace, accounts (null = all of the workspace's) and instants `[from, to)`. */
export type Scope = { teamId: string; accountIds: number[] | null; from: Date; to: Date };

/** The rows of `table` in workspace `teamId`, on `accountIds` (null = all). */
export const owned = (table: typeof messageFact | typeof purchaseFact | typeof accountWorkspace, teamId: string, accountIds: number[] | null) =>
  and(eq(table.teamId, teamId), accountIds ? inArray(table.accountId, accountIds) : undefined);

/** The rows of `table` (`message_fact` or `purchase_fact`) created in `[from, to)`. */
export const during = (table: typeof messageFact | typeof purchaseFact, from: Date, to: Date) => and(gte(table.createdAt, from), lt(table.createdAt, to));

/** The rows of `table` (`message_fact` or `purchase_fact`) in `s`. */
export const inScope = (table: typeof messageFact | typeof purchaseFact, s: Scope) => and(owned(table, s.teamId, s.accountIds), during(table, s.from, s.to));

export const txStatus = sql`${purchaseFact.raw}->>'status'`;
/** A booked sale: OF's status `done` (settled) or `loading` (pending); `undo` (refunded) and `pending_return` (being reversed) are not. */
export const booked = sql`${txStatus} in ('done', 'loading')`;

/** A DM: outbound, not mass, not automated (welcome message or automation). Unsent ones count. */
export const dm = sql`${messageFact.direction} = 'outbound' and not ${messageFact.isMass} and not ${messageFact.isAutomated}`;

/** A PPV DM: outbound, not mass, priced. Unsent ones count. */
export const ppvDm = sql`${messageFact.direction} = 'outbound' and not ${messageFact.isMass} and ${messageFact.priceCents} > 0`;
