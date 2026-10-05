import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { messageFact } from '../../db/schema.js';
import type { StatsConfig, StatsGroupBy, StatsMetric, StatsMetricRow, StatsSample } from '../../contracts.js';
import { fanTurns, turnMessages, type FanTurn } from './turns.js';

// Reply time and reply SLA over fan turns (spec §2, step 1), computed at query time from `message_fact` with the
// workspace's config windows. Nothing is stored.

export type AccountTurn = FanTurn & { accountId: number };

type Definition = Omit<StatsMetric, 'id' | 'groupings' | 'verified'> & {
  /** Substantive variant: only a DM of `minReplyChars`+ ends a turn. */
  substantive: boolean;
  /** The value of a group and the number of turns behind it. */
  value: (turns: AccountTurn[], cfg: StatsConfig) => { value: number | null; n: number };
  /** The turns behind the value, for samples. */
  behind: (t: AccountTurn) => boolean;
};

const replied = (t: FanTurn) => t.dmAt !== null;
const inCap = (t: FanTurn) => t.status === 'in_cap';
const decided = (t: FanTurn) => t.status !== 'pending';
const waitFromLast = (t: FanTurn) => (t.dmAt ? (t.dmAt.getTime() - t.lastInboundAt.getTime()) / 1000 : null);
const slaMet = (t: FanTurn, cfg: StatsConfig) => t.waitSeconds !== null && t.waitSeconds <= cfg.slaSeconds;

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = (s.length - 1) / 2;
  return (s[Math.floor(mid)]! + s[Math.ceil(mid)]!) / 2;
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

const medianInCap = (turns: AccountTurn[]) => {
  const waits = turns.filter(inCap).map((t) => t.waitSeconds!);
  return { value: median(waits), n: waits.length };
};

const DEFINITIONS = {
  reply_time: {
    name: 'Reply time (median)',
    description:
      'Median seconds from the first fan message of a fan turn to the DM that ends it, among turns replied within reply_cap. Mass and automated messages do not end a turn. Late, breached and pending turns are counted beside it.',
    unit: 'seconds',
    windows: ['reply_cap', 'sla'],
    substantive: false,
    value: medianInCap,
    behind: inCap,
  },
  reply_time_mean: {
    name: 'Reply time (mean, Infloww-comparable)',
    description:
      'Mean seconds from the first fan message of a fan turn to the DM that ends it, over every replied turn (within reply_cap or late); unreplied turns are left out. Comparable to Infloww\'s reply time.',
    unit: 'seconds',
    windows: ['reply_cap', 'sla'],
    substantive: false,
    value: (turns) => {
      const waits = turns.filter(replied).map((t) => t.waitSeconds!);
      return { value: mean(waits), n: waits.length };
    },
    behind: replied,
  },
  reply_time_mean_last: {
    name: 'Reply time from the last fan message (mean, Infloww-comparable)',
    description:
      'Mean seconds from the last fan message before the reply to the DM that ends the fan turn, over every replied turn; unreplied turns are left out. The other turn-start variant of Infloww\'s reply time.',
    unit: 'seconds',
    windows: ['reply_cap', 'sla'],
    substantive: false,
    value: (turns) => {
      const waits = turns.filter(replied).map((t) => waitFromLast(t)!);
      return { value: mean(waits), n: waits.length };
    },
    behind: replied,
  },
  reply_sla: {
    name: 'Reply SLA',
    description:
      'Percent of fan turns replied within sla, of the turns that are not pending (replied, or unreplied with reply_cap elapsed). Breached turns are the unanswered ones.',
    unit: 'percent',
    windows: ['reply_cap', 'sla'],
    substantive: false,
    value: (turns, cfg) => {
      const n = turns.filter(decided).length;
      return { value: n ? (turns.filter((t) => slaMet(t, cfg)).length / n) * 100 : null, n };
    },
    behind: decided,
  },
  reply_time_substantive: {
    name: 'Substantive reply time (median)',
    description:
      'As reply_time, but only a DM of min_reply_chars or more (text after tag strip) ends a fan turn, so "one sec babe" does not stop the clock.',
    unit: 'seconds',
    windows: ['reply_cap', 'sla', 'min_reply_chars'],
    substantive: true,
    value: medianInCap,
    behind: inCap,
  },
} satisfies Record<string, Definition>;

export type MetricId = keyof typeof DEFINITIONS;
const GROUPINGS: StatsGroupBy[] = ['day', 'hour', 'account'];

export const METRICS: StatsMetric[] = Object.entries(DEFINITIONS).map(([id, d]) => ({
  id,
  name: d.name,
  description: d.description,
  unit: d.unit,
  groupings: GROUPINGS,
  windows: d.windows,
  // Not yet checked by hand in OF or against an Infloww export (spec §6 step 0).
  verified: false,
}));

export const isMetricId = (id: string): id is MetricId => Object.hasOwn(DEFINITIONS, id);

// Timezone buckets, via Intl (no dependency).

const formatters = new Map<string, Intl.DateTimeFormat>();
function zoned(t: Date, tz: string): { day: string; hour: string; offsetMs: number } {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    formatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(t).map((x) => [x.type, x.value]));
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: p.hour!, offsetMs: wall - Math.floor(t.getTime() / 1000) * 1000 };
}

/** The instant midnight of `day` (`YYYY-MM-DD`) begins in `tz`. */
export function zonedMidnight(day: string, tz: string): Date {
  const guess = Date.parse(`${day}T00:00:00.000Z`);
  const first = guess - zoned(new Date(guess), tz).offsetMs;
  return new Date(guess - zoned(new Date(first), tz).offsetMs);
}

/** Today in `tz`, as `YYYY-MM-DD`. */
export const zonedToday = (tz: string, now = new Date()) => zoned(now, tz).day;

export function groupKey(t: AccountTurn, groupBy: StatsGroupBy, tz: string): string {
  if (groupBy === 'account') return String(t.accountId);
  const z = zoned(t.inboundAt, tz);
  return groupBy === 'day' ? z.day : z.hour;
}

/**
 * The fan turns of workspace `teamId` that start in `[from, to)`, over `accountIds` (null = every account the
 * workspace has rows for), with the config's reply cap and, for a substantive metric, its `min_reply_chars`.
 */
export async function scopedTurns(
  teamId: string,
  accountIds: number[] | null,
  metric: MetricId,
  cfg: StatsConfig,
  range: { from: Date; to: Date; asOf: Date },
): Promise<AccountTurn[]> {
  const accounts = await db
    .selectDistinct({ accountId: messageFact.accountId })
    .from(messageFact)
    .where(and(eq(messageFact.teamId, teamId), accountIds ? inArray(messageFact.accountId, accountIds) : undefined));
  const opts = {
    asOf: range.asOf,
    replyCapMs: cfg.replyCapSeconds * 1000,
    minReplyChars: DEFINITIONS[metric].substantive ? cfg.minReplyChars : 0,
  };
  const turns: AccountTurn[] = [];
  for (const { accountId } of accounts) {
    for (const t of fanTurns(await turnMessages(teamId, accountId), opts)) {
      if (t.inboundAt >= range.from && t.inboundAt < range.to) turns.push({ ...t, accountId });
    }
  }
  return turns.sort((a, b) => a.inboundAt.getTime() - b.inboundAt.getTime() || a.accountId - b.accountId || a.chatId - b.chatId);
}

/** One row per group with at least one turn, sorted by group. */
export function metricRows(metric: MetricId, turns: AccountTurn[], groupBy: StatsGroupBy, cfg: StatsConfig): StatsMetricRow[] {
  const groups = new Map<string, AccountTurn[]>();
  for (const t of turns) {
    const key = groupKey(t, groupBy, cfg.timezone);
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const count = (list: AccountTurn[], status: FanTurn['status']) => list.filter((t) => t.status === status).length;
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))
    .map(([group, list]) => ({
      group,
      ...DEFINITIONS[metric].value(list, cfg),
      turns: list.length,
      inCap: count(list, 'in_cap'),
      late: count(list, 'late'),
      breached: count(list, 'breached'),
      pending: count(list, 'pending'),
      slaMet: list.filter((t) => slaMet(t, cfg)).length,
    }));
}

/** Up to `limit` turns behind the metric's value, oldest turn start first. */
export function metricSamples(metric: MetricId, turns: AccountTurn[], cfg: StatsConfig, limit: number): StatsSample[] {
  return turns
    .filter(DEFINITIONS[metric].behind)
    .slice(0, limit)
    .map((t) => ({
      accountId: t.accountId,
      chatId: t.chatId,
      fanMessageId: t.inboundMessageId,
      fanAt: t.inboundAt.toISOString(),
      lastFanMessageId: t.lastInboundMessageId,
      lastFanAt: t.lastInboundAt.toISOString(),
      replyMessageId: t.dmMessageId,
      replyAt: t.dmAt?.toISOString() ?? null,
      waitSeconds: t.waitSeconds,
      waitFromLastSeconds: waitFromLast(t),
      status: t.status,
      slaMet: slaMet(t, cfg),
    }));
}

export const METRIC_CSV_COLUMNS = ['group', 'value', 'n', 'turns', 'in_cap', 'late', 'breached', 'pending', 'sla_met'] as const;
