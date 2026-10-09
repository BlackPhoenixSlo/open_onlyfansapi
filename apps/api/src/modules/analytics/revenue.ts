import { and, desc, inArray, isNotNull, max, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { messageFact, purchaseFact } from '../../db/schema.js';
import type { StatsRevenue } from '../../contracts.js';
import { inScope, ppvDm, type Scope } from './messages.js';

// Revenue (`GET /v1/stats/revenue`): the workspace's stored booked transactions (`purchase_fact`) and PPV sends
// (`message_fact`) in a range.

type Sums = { gross: number; net: number; transactions: number };

const TOP_PAYERS = 50;

const txStatus = sql`${purchaseFact.raw}->>'status'`;
/** A booked transaction: not refunded or reversed (OF's status `undo` or `pending_return`); a missing status counts. */
const booked = sql`coalesce(${txStatus}, '') not in ('undo', 'pending_return')`;

const zero = (): Sums => ({ gross: 0, net: 0, transactions: 0 });

function add(sums: Sums, s: Sums) {
  sums.gross += s.gross;
  sums.net += s.net;
  sums.transactions += s.transactions;
}

/** `part / whole` in percent; null when `whole` is 0. */
const percent = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : null);

/**
 * Totals, by kind, by day (each of `days`, the range's days in `tz`, zeros included), PPV unlocks and the top payers
 * of the range; see `statsRevenue`.
 */
export async function scopedRevenue(scope: Scope, days: string[], tz: string): Promise<Pick<StatsRevenue, 'totals' | 'byKind' | 'byDay' | 'ppv' | 'topPayers' | 'withoutChat'>> {
  // A DM as Infloww's golden ratio counts it: outbound, not mass, not automated (welcome message or automation).
  const dm = sql`${messageFact.direction} = 'outbound' and not ${messageFact.isMass} and not ${messageFact.isAutomated}`;
  const [groups, [messages]] = await Promise.all([
    // `day` is grouped by its output name: the timezone parameter would make a repeated expression differ.
    db
      .select({
        accountId: purchaseFact.accountId,
        fanId: purchaseFact.fanId,
        kind: purchaseFact.kind,
        day: sql<string>`to_char(${purchaseFact.createdAt} at time zone ${tz}, 'YYYY-MM-DD')`.as('day'),
        gross: sql<number>`coalesce(sum(${purchaseFact.grossCents}), 0)::int`,
        net: sql<number>`coalesce(sum(${purchaseFact.netCents}), 0)::int`,
        transactions: sql<number>`count(*)::int`,
        settled: sql<number>`coalesce(sum(${purchaseFact.grossCents}) filter (where ${txStatus} = 'done'), 0)::int`,
        pending: sql<number>`coalesce(sum(${purchaseFact.grossCents}) filter (where ${txStatus} = 'loading'), 0)::int`,
        lastAt: max(purchaseFact.createdAt),
      })
      .from(purchaseFact)
      .where(and(inScope(purchaseFact, scope), booked))
      .groupBy(purchaseFact.accountId, purchaseFact.fanId, purchaseFact.kind, sql`"day"`),
    db
      .select({
        fansMessaged: sql<number>`(count(distinct (${messageFact.accountId}, ${messageFact.chatId})) filter (where ${messageFact.deletedAt} is null))::int`,
        dmMessages: sql<number>`(count(*) filter (where ${dm}))::int`,
        dmPpvs: sql<number>`(count(*) filter (where ${dm} and ${messageFact.priceCents} > 0))::int`,
        ppvSent: sql<number>`(count(*) filter (where ${ppvDm}))::int`,
        ppvOpened: sql<number>`(count(*) filter (where ${ppvDm} and ${messageFact.isOpened}))::int`,
      })
      .from(messageFact)
      // Only accounts with a booked transaction in the range: messages of an account whose sales were never read
      // would count fans and PPVs against no revenue.
      .where(
        and(
          inScope(messageFact, scope),
          inArray(
            messageFact.accountId,
            db.selectDistinct({ accountId: purchaseFact.accountId }).from(purchaseFact).where(and(inScope(purchaseFact, scope), booked)),
          ),
        ),
      ),
  ]);

  const totals = zero();
  let settledGross = 0;
  let pendingGross = 0;
  const kinds = new Map<string, Sums>();
  const byDay = new Map(days.map((d) => [d, zero()]));
  const payers = new Map<string, Sums & { accountId: number; fanId: number; lastAt: Date }>();
  for (const g of groups) {
    add(totals, g);
    settledGross += g.settled;
    pendingGross += g.pending;
    const kind = g.kind ?? 'unknown';
    if (!kinds.has(kind)) kinds.set(kind, zero());
    add(kinds.get(kind)!, g);
    const day = byDay.get(g.day);
    if (day) add(day, g);
    if (g.fanId === null) continue;
    const key = `${g.accountId}:${g.fanId}`;
    let payer = payers.get(key);
    if (!payer) payers.set(key, (payer = { accountId: g.accountId, fanId: g.fanId, lastAt: g.lastAt!, ...zero() }));
    add(payer, g);
    if (g.lastAt! > payer.lastAt) payer.lastAt = g.lastAt!;
  }

  const top = [...payers.values()].sort((a, b) => b.gross - a.gross || a.accountId - b.accountId || a.fanId - b.fanId).slice(0, TOP_PAYERS);
  // Per payer, the newest transaction with a name (else the newest), with OF's isDeleted on it, and whether the fan's
  // chat is stored.
  const user = sql`${purchaseFact.raw}->'user'`;
  const name = sql<string | null>`coalesce(nullif(${user}->>'name', ''), nullif(${user}->>'username', ''))`;
  const details = await db
    .selectDistinctOn([purchaseFact.accountId, purchaseFact.fanId], {
      accountId: purchaseFact.accountId,
      fanId: purchaseFact.fanId,
      name,
      isDeleted: sql<boolean>`coalesce((${user}->>'isDeleted')::boolean, false)`,
      hasChat: sql<boolean>`exists (select 1 from ${messageFact} where ${messageFact.teamId} = ${purchaseFact.teamId} and ${messageFact.accountId} = ${purchaseFact.accountId} and ${messageFact.chatId} = ${purchaseFact.fanId})`,
    })
    .from(purchaseFact)
    .where(and(inScope(purchaseFact, scope), booked, isNotNull(purchaseFact.fanId)))
    .orderBy(purchaseFact.accountId, purchaseFact.fanId, sql`${name} is null`, desc(purchaseFact.createdAt));
  const detail = new Map(details.map((d) => [`${d.accountId}:${d.fanId}`, d]));
  const withoutChat = { payers: 0, gross: 0 };
  for (const [key, p] of payers) {
    if (detail.get(key)?.hasChat) continue;
    withoutChat.payers++;
    withoutChat.gross += p.gross;
  }

  // An aggregate without GROUP BY always returns one row.
  const { fansMessaged, dmMessages, dmPpvs, ppvSent, ppvOpened } = messages!;
  return {
    totals: {
      ...totals,
      settledGross,
      pendingGross,
      payers: payers.size,
      fansMessaged,
      fanCvr: percent(payers.size, fansMessaged),
      dmMessages,
      dmPpvs,
      goldenRatio: percent(dmPpvs, dmMessages),
    },
    byKind: [...kinds].map(([kind, s]) => ({ kind, ...s })).sort((a, b) => b.gross - a.gross || a.kind.localeCompare(b.kind)),
    byDay: [...byDay].map(([day, s]) => ({ day, ...s })),
    ppv: { sent: ppvSent, opened: ppvOpened, rate: percent(ppvOpened, ppvSent) },
    topPayers: top.map(({ lastAt, ...p }) => {
      const d = detail.get(`${p.accountId}:${p.fanId}`);
      return { ...p, name: d?.name ?? null, isDeleted: d?.isDeleted ?? false, lastAt: lastAt.toISOString(), hasChat: d?.hasChat ?? false };
    }),
    withoutChat,
  };
}
