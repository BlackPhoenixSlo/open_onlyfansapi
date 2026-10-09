import { and, max, sql } from 'drizzle-orm';
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
      .where(sales)
      .groupBy(purchaseFact.accountId, purchaseFact.fanId, purchaseFact.kind, sql`"day"`),
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
  // Per payer, the name and isDeleted on the newest transaction of the range with a name (else the newest), and whether
  // the fan's chat is stored: `fanSpends`, as on the fans list. Every payer has a row: both read the range's booked sales.
  const detail = new Map(spends.map((d) => [`${d.accountId}:${d.fanId}`, d]));
  const withoutChat = { payers: 0, gross: 0 };
  for (const [key, p] of payers) {
    if (detail.get(key)!.hasChat) continue;
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
      const { name, username, isDeleted, hasChat } = detail.get(`${p.accountId}:${p.fanId}`)!;
      return { ...p, name: name ?? username, isDeleted, lastAt: lastAt.toISOString(), hasChat };
    }),
    withoutChat,
  };
}
