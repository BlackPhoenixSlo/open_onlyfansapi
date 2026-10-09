import { and, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { messageFact, purchaseFact } from '../../db/schema.js';
import type { StatsRevenue } from '../../contracts.js';
import { booked, dm, fanSpends, inScope, ppvDm, txStatus, type Scope } from './messages.js';

// Revenue (`GET /v1/stats/revenue`): the workspace's stored booked transactions (`purchase_fact`) and PPV sends
// (`message_fact`) in a range.

type Sums = { gross: number; net: number; transactions: number };

const TOP_PAYERS = 50;

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
  const sales = and(inScope(purchaseFact, scope), booked);
  // Fans are counted only on accounts with a booked sale in the range: an account whose sales were never read would
  // count fans against no payers. DMs and PPVs count on every account.
  const salesAccount = sql`${messageFact.accountId} in (select distinct ${purchaseFact.accountId} from ${purchaseFact} where ${sales})`;
  const [groups, [messages], spends] = await Promise.all([
    // `day` is grouped by its output name: the timezone parameter would make a repeated expression differ.
    db
      .select({
        kind: purchaseFact.kind,
        day: sql<string>`to_char(${purchaseFact.createdAt} at time zone ${tz}, 'YYYY-MM-DD')`.as('day'),
        gross: sql<number>`coalesce(sum(${purchaseFact.grossCents}), 0)::int`,
        net: sql<number>`coalesce(sum(${purchaseFact.netCents}), 0)::int`,
        transactions: sql<number>`count(*)::int`,
        settled: sql<number>`coalesce(sum(${purchaseFact.grossCents}) filter (where ${txStatus} = 'done'), 0)::int`,
        pending: sql<number>`coalesce(sum(${purchaseFact.grossCents}) filter (where ${txStatus} = 'loading'), 0)::int`,
      })
      .from(purchaseFact)
      .where(sales)
      .groupBy(purchaseFact.kind, sql`"day"`),
    db
      .select({
        fansMessaged: sql<number>`(count(distinct (${messageFact.accountId}, ${messageFact.chatId})) filter (where ${messageFact.deletedAt} is null and ${salesAccount}))::int`,
        dmMessages: sql<number>`(count(*) filter (where ${dm}))::int`,
        dmPpvs: sql<number>`(count(*) filter (where ${dm} and ${messageFact.priceCents} > 0))::int`,
        ppvSent: sql<number>`(count(*) filter (where ${ppvDm}))::int`,
        ppvOpened: sql<number>`(count(*) filter (where ${ppvDm} and ${messageFact.isOpened}))::int`,
      })
      .from(messageFact)
      .where(inScope(messageFact, scope)),
    fanSpends(scope),
  ]);

  const totals = zero();
  let settledGross = 0;
  let pendingGross = 0;
  const kinds = new Map<string, Sums>();
  const byDay = new Map(days.map((d) => [d, zero()]));
  for (const g of groups) {
    add(totals, g);
    settledGross += g.settled;
    pendingGross += g.pending;
    const kind = g.kind ?? 'unknown';
    if (!kinds.has(kind)) kinds.set(kind, zero());
    add(kinds.get(kind)!, g);
    const day = byDay.get(g.day);
    if (day) add(day, g);
  }

  // The payers of the range (a booked sale in it has a `lastAt`), with the fan's details as on the fans list.
  const payers = spends.flatMap(({ lastAt, ...p }) => (lastAt ? [{ ...p, lastAt }] : []));
  const top = payers.sort((a, b) => b.gross - a.gross || a.accountId - b.accountId || a.fanId - b.fanId).slice(0, TOP_PAYERS);
  const withoutChat = { payers: 0, gross: 0 };
  for (const p of payers) {
    if (p.hasChat) continue;
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
      payers: payers.length,
      fansMessaged,
      fanCvr: percent(payers.length, fansMessaged),
      dmMessages,
      dmPpvs,
      goldenRatio: percent(dmPpvs, dmMessages),
    },
    byKind: [...kinds].map(([kind, s]) => ({ kind, ...s })).sort((a, b) => b.gross - a.gross || a.kind.localeCompare(b.kind)),
    byDay: [...byDay].map(([day, s]) => ({ day, ...s })),
    ppv: { sent: ppvSent, opened: ppvOpened, rate: percent(ppvOpened, ppvSent) },
    // The response schema drops the fields the contract does not name.
    topPayers: top.map(({ name, username, lastAt, ...p }) => ({ ...p, name: name ?? username, lastAt: lastAt.toISOString() })),
    withoutChat,
  };
}
