import { and, asc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { messageFact, purchaseFact } from '../../db/schema.js';
import type { StatsRevenue } from '../../contracts.js';
import { zonedDay } from './metrics.js';

// Revenue (`GET /v1/stats/revenue`): the workspace's stored transactions (`purchase_fact`) and PPV sends
// (`message_fact`) in a range, summed in JS so days fall in the stats timezone as the metrics' do.

type Scope = { teamId: string; accountIds: number[] | null; from: Date; to: Date; fromDay: string; toDay: string };
type Sums = { gross: number; net: number; transactions: number };

const DAY_MS = 86_400_000;
const TOP_PAYERS = 50;

const inScope = (t: typeof messageFact | typeof purchaseFact, s: Scope) =>
  and(eq(t.teamId, s.teamId), s.accountIds ? inArray(t.accountId, s.accountIds) : undefined, gte(t.createdAt, s.from), lt(t.createdAt, s.to));

const zero = (): Sums => ({ gross: 0, net: 0, transactions: 0 });

/** Adds one transaction to `sums`; a missing amount counts as 0. */
function add(sums: Sums, p: { gross: number | null; net: number | null }) {
  sums.gross += p.gross ?? 0;
  sums.net += p.net ?? 0;
  sums.transactions += 1;
}

const rate = (part: number, whole: number) => (whole > 0 ? part / whole : null);

/** Every day from `from` to `to` (`YYYY-MM-DD`), both included. */
function days(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00.000Z`), end = Date.parse(`${to}T00:00:00.000Z`); t <= end; t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** Totals, by kind, by day (zeros included), PPV unlocks and the top payers of the range; see `statsRevenue`. */
export async function scopedRevenue(scope: Scope, tz: string): Promise<Pick<StatsRevenue, 'totals' | 'byKind' | 'byDay' | 'ppv' | 'topPayers'>> {
  const priced = sql`${messageFact.direction} = 'outbound' and ${messageFact.priceCents} > 0`;
  const dm = sql`${priced} and not ${messageFact.isMass}`;
  const mass = sql`${priced} and ${messageFact.isMass}`;
  const user = sql`${purchaseFact.raw}->'user'`;
  const [purchases, [messages]] = await Promise.all([
    db
      .select({
        accountId: purchaseFact.accountId,
        fanId: purchaseFact.fanId,
        kind: purchaseFact.kind,
        gross: purchaseFact.grossCents,
        net: purchaseFact.netCents,
        createdAt: purchaseFact.createdAt,
        name: sql<string | null>`coalesce(nullif(${user}->>'name', ''), nullif(${user}->>'username', ''))`,
      })
      .from(purchaseFact)
      .where(inScope(purchaseFact, scope))
      .orderBy(asc(purchaseFact.createdAt), asc(purchaseFact.txId)),
    db
      .select({
        fansMessaged: sql<number>`count(distinct (${messageFact.accountId}, ${messageFact.chatId}))::int`,
        dmSent: sql<number>`(count(*) filter (where ${dm}))::int`,
        dmOpened: sql<number>`(count(*) filter (where ${dm} and ${messageFact.isOpened}))::int`,
        massSent: sql<number>`(count(*) filter (where ${mass}))::int`,
        massOpened: sql<number>`(count(*) filter (where ${mass} and ${messageFact.isOpened}))::int`,
      })
      .from(messageFact)
      .where(and(inScope(messageFact, scope), isNull(messageFact.deletedAt))),
  ]);

  const totals = zero();
  const kinds = new Map<string, Sums>();
  const byDay = new Map(days(scope.fromDay, scope.toDay).map((d) => [d, zero()]));
  const payers = new Map<string, Sums & { accountId: number; fanId: number; name: string | null; lastAt: Date }>();
  // Oldest first, so the last name seen is the newest.
  for (const p of purchases) {
    add(totals, p);
    const kind = p.kind ?? 'unknown';
    if (!kinds.has(kind)) kinds.set(kind, zero());
    add(kinds.get(kind)!, p);
    const day = byDay.get(zonedDay(p.createdAt, tz));
    if (day) add(day, p);
    if (p.fanId === null) continue;
    const key = `${p.accountId}:${p.fanId}`;
    let payer = payers.get(key);
    if (!payer) payers.set(key, (payer = { accountId: p.accountId, fanId: p.fanId, name: null, lastAt: p.createdAt, ...zero() }));
    add(payer, p);
    payer.lastAt = p.createdAt;
    payer.name = p.name ?? payer.name;
  }

  const top = [...payers.values()]
    .sort((a, b) => b.gross - a.gross || a.accountId - b.accountId || a.fanId - b.fanId)
    .slice(0, TOP_PAYERS);
  const chats = top.length
    ? await db
        .selectDistinct({ accountId: messageFact.accountId, chatId: messageFact.chatId })
        .from(messageFact)
        .where(
          and(
            eq(messageFact.teamId, scope.teamId),
            inArray(messageFact.accountId, [...new Set(top.map((p) => p.accountId))]),
            inArray(messageFact.chatId, top.map((p) => p.fanId)),
          ),
        )
    : [];
  const withChat = new Set(chats.map((c) => `${c.accountId}:${c.chatId}`));

  // An aggregate without GROUP BY always returns one row.
  const { fansMessaged, dmSent, dmOpened, massSent, massOpened } = messages!;
  return {
    totals: { ...totals, payers: payers.size, fansMessaged, goldenRatio: rate(payers.size, fansMessaged) },
    byKind: [...kinds].map(([kind, s]) => ({ kind, ...s })).sort((a, b) => b.gross - a.gross || a.kind.localeCompare(b.kind)),
    byDay: [...byDay].map(([day, s]) => ({ day, ...s })),
    ppv: [
      { scope: 'dm', sent: dmSent, opened: dmOpened, rate: rate(dmOpened, dmSent) },
      { scope: 'mass', sent: massSent, opened: massOpened, rate: rate(massOpened, massSent) },
    ],
    topPayers: top.map(({ lastAt, ...p }) => ({ ...p, lastAt: lastAt.toISOString(), hasChat: withChat.has(`${p.accountId}:${p.fanId}`) })),
  };
}
