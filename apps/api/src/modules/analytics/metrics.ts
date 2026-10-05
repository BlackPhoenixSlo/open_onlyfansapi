import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { messageFact } from '../../db/schema.js';
import type { StatsConfig, StatsGroupBy, StatsMetric, StatsMetricRow, StatsOpenerSample, StatsSample } from '../../contracts.js';
import { chatOpeners, reachedStartChats, type Opener } from './openers.js';
import { fanTurns, turnMessages, type FanTurn } from './turns.js';

// Reply time and reply SLA over fan turns (spec §2, step 1) and openers (step 2), computed at query time from
// `message_fact` and `chat_coverage` with the workspace's config windows. Nothing is stored.

export type AccountTurn = FanTurn & { accountId: number };
export type AccountOpener = Opener & { accountId: number };

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

/**
 * The `q`-quantile (0 to 1) of `xs` by linear interpolation between closest ranks (Hyndman and Fan type 7, the default
 * of R and NumPy, Excel's PERCENTILE.INC): position `(n - 1) * q` in the sorted list, weighted between its two
 * neighbours. At 0.5 it is the usual median, the mean of the two middle values for an even n. null for no values.
 */
export function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const f = pos - lo;
  // Weighted form, so the median of two values is exactly (a + b) / 2.
  return f === 0 ? s[lo]! : s[lo]! * (1 - f) + s[lo + 1]! * f;
}
const median = (xs: number[]) => quantile(xs, 0.5);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

const quantileInCap = (q: number) => (turns: AccountTurn[]) => {
  const waits = turns.filter(inCap).map((t) => t.waitSeconds!);
  return { value: quantile(waits, q), n: waits.length };
};
const medianInCap = quantileInCap(0.5);

const TURN_DEFINITIONS = {
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
  reply_time_p90: {
    name: 'Reply time (90th percentile)',
    description:
      '90th percentile of the seconds from the first fan message of a fan turn to the DM that ends it, over the same turns as reply_time (replied within reply_cap); linear interpolation between closest ranks. Late, breached and pending turns are counted beside it.',
    unit: 'seconds',
    windows: ['reply_cap', 'sla'],
    substantive: false,
    value: quantileInCap(0.9),
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

type OpenerDefinition = Omit<StatsMetric, 'id' | 'groupings' | 'verified'> & {
  /** Substantive variant: only a fan message of `minReplyChars`+ is the fan's reply. */
  substantive: boolean;
  value: (openers: AccountOpener[]) => { value: number | null; n: number };
  /** The openers behind the value, for samples. */
  behind: (o: AccountOpener) => boolean;
};

const openerReplied = (o: Opener) => o.status === 'replied';
const openerDecided = (o: Opener) => o.status !== 'pending';
const openerReplyRate = (openers: AccountOpener[]) => {
  const n = openers.filter(openerDecided).length;
  return { value: n ? (openers.filter(openerReplied).length / n) * 100 : null, n };
};

const OPENER_DEFINITIONS = {
  openers: {
    name: 'Openers',
    description:
      'DMs sent with no fan message and no DM in the chat for open_gap before them; mass and automated messages do not reset the gap, and a fan message in it, or an unanswered fan message before it however old, makes the DM a reply, so the fan did not write first. Kind first_ever (the chat was walked to its start and holds no earlier fan message or DM), reactivation (an earlier fan message or DM is stored) or unknown (nothing earlier is stored and the walk did not reach the chat start), counted beside it.',
    unit: 'count',
    windows: ['open_gap', 'open_reply'],
    substantive: false,
    value: (openers) => ({ value: openers.length, n: openers.length }),
    behind: () => true,
  },
  opener_reply_rate: {
    name: 'Opener reply rate',
    description:
      'Percent of openers the fan answered (any fan message) within open_reply, of the openers whose open_reply has elapsed at as_of. Pending openers are counted beside it, not in the denominator.',
    unit: 'percent',
    windows: ['open_gap', 'open_reply'],
    substantive: false,
    value: openerReplyRate,
    behind: openerDecided,
  },
  opener_reply_rate_substantive: {
    name: 'Opener reply rate (substantive)',
    description:
      'As opener_reply_rate, but only a fan message of min_reply_chars or more (text after tag strip) is a reply, so "ok" is not: percent of openers with such a fan message within open_reply, of the openers whose open_reply has elapsed at as_of. Pending openers are counted beside it.',
    unit: 'percent',
    windows: ['open_gap', 'open_reply', 'min_reply_chars'],
    substantive: true,
    value: openerReplyRate,
    behind: openerDecided,
  },
  opener_fan_reply_time: {
    name: 'Time to fan reply after an opener (median)',
    description: "Median seconds from an opener to the fan's first message after it, among openers the fan answered within open_reply.",
    unit: 'seconds',
    windows: ['open_gap', 'open_reply'],
    substantive: false,
    value: (openers) => {
      const waits = openers.filter(openerReplied).map((o) => o.fanReplySeconds!);
      return { value: median(waits), n: waits.length };
    },
    behind: openerReplied,
  },
} satisfies Record<string, OpenerDefinition>;

export type TurnMetricId = keyof typeof TURN_DEFINITIONS;
export type OpenerMetricId = keyof typeof OPENER_DEFINITIONS;
export type MetricId = TurnMetricId | OpenerMetricId;
const DEFINITIONS: Record<MetricId, Omit<StatsMetric, 'id' | 'groupings' | 'verified'>> = { ...TURN_DEFINITIONS, ...OPENER_DEFINITIONS };
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
export const isOpenerMetric = (id: MetricId): id is OpenerMetricId => Object.hasOwn(OPENER_DEFINITIONS, id);

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

/** A turn's group by its start, an opener's by its send time. */
export function groupKey(t: AccountTurn | AccountOpener, groupBy: StatsGroupBy, tz: string): string {
  if (groupBy === 'account') return String(t.accountId);
  const z = zoned('sentAt' in t ? t.sentAt : t.inboundAt, tz);
  return groupBy === 'day' ? z.day : z.hour;
}

/**
 * The fan turns of workspace `teamId` that start in `[from, to)`, over `accountIds` (null = every account the
 * workspace has rows for), with the config's reply cap and, for a substantive metric, its `min_reply_chars`. Reads
 * each chat from its anchor before `from` (`turnMessages`: exact, so a turn started before `from` is not split) with
 * no upper bound, since a late reply ends a turn however long after the cap it comes; text only for the substantive
 * variant.
 */
export async function scopedTurns(
  teamId: string,
  accountIds: number[] | null,
  metric: TurnMetricId,
  cfg: StatsConfig,
  range: { from: Date; to: Date; asOf: Date },
): Promise<AccountTurn[]> {
  const opts = {
    asOf: range.asOf,
    replyCapMs: cfg.replyCapSeconds * 1000,
    minReplyChars: TURN_DEFINITIONS[metric].substantive ? cfg.minReplyChars : 0,
  };
  const turns: AccountTurn[] = [];
  for (const accountId of await workspaceAccounts(teamId, accountIds)) {
    for (const t of fanTurns(await turnMessages(teamId, accountId, { from: range.from, text: opts.minReplyChars > 0 }), opts)) {
      if (t.inboundAt >= range.from && t.inboundAt < range.to) turns.push({ ...t, accountId });
    }
  }
  return turns.sort((a, b) => a.inboundAt.getTime() - b.inboundAt.getTime() || a.accountId - b.accountId || a.chatId - b.chatId);
}

/** The accounts workspace `teamId` has rows for, narrowed to `accountIds` (null = all). */
export async function workspaceAccounts(teamId: string, accountIds: number[] | null): Promise<number[]> {
  const rows = await db
    .selectDistinct({ accountId: messageFact.accountId })
    .from(messageFact)
    .where(and(eq(messageFact.teamId, teamId), accountIds ? inArray(messageFact.accountId, accountIds) : undefined));
  return rows.map((r) => r.accountId);
}

/**
 * The openers of workspace `teamId` sent in `[from, to)`, over `accountIds` (null = every account the workspace has
 * rows for), with the config's `open_gap` and `open_reply` and, for a substantive metric, its `min_reply_chars` (only
 * a fan message that long is the reply; text is read for it only then). Messages before `from` still close or open the gap: each
 * chat is read from its anchor before `from` (`turnMessages`, exact), up to `to + open_reply`, which decides every
 * opener's status; a fan reply after that is not read, so a no-reply opener's `fanReply*` stays null.
 */
export async function scopedOpeners(
  teamId: string,
  accountIds: number[] | null,
  metric: OpenerMetricId,
  cfg: StatsConfig,
  range: { from: Date; to: Date; asOf: Date },
): Promise<AccountOpener[]> {
  const opts = {
    asOf: range.asOf,
    openGapMs: cfg.openGapSeconds * 1000,
    openReplyMs: cfg.openReplySeconds * 1000,
    minReplyChars: OPENER_DEFINITIONS[metric].substantive ? cfg.minReplyChars : 0,
  };
  const openers: AccountOpener[] = [];
  for (const accountId of await workspaceAccounts(teamId, accountIds)) {
    const to = new Date(range.to.getTime() + opts.openReplyMs);
    const messages = await turnMessages(teamId, accountId, { from: range.from, to, text: opts.minReplyChars > 0 });
    const found = chatOpeners(messages, await reachedStartChats(teamId, accountId), opts);
    for (const o of found) {
      if (o.sentAt >= range.from && o.sentAt < range.to) openers.push({ ...o, accountId });
    }
  }
  return openers.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime() || a.accountId - b.accountId || a.chatId - b.chatId);
}

function grouped<T extends AccountTurn | AccountOpener>(items: T[], groupBy: StatsGroupBy, tz: string): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const x of items) {
    const key = groupKey(x, groupBy, tz);
    const list = groups.get(key);
    if (list) list.push(x);
    else groups.set(key, [x]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }));
}

/** One row per group with at least one turn, sorted by group. */
export function metricRows(metric: TurnMetricId, turns: AccountTurn[], groupBy: StatsGroupBy, cfg: StatsConfig): StatsMetricRow[] {
  const count = (list: AccountTurn[], status: FanTurn['status']) => list.filter((t) => t.status === status).length;
  return grouped(turns, groupBy, cfg.timezone).map(([group, list]) => ({
    group,
    ...TURN_DEFINITIONS[metric].value(list, cfg),
    turns: list.length,
    inCap: count(list, 'in_cap'),
    late: count(list, 'late'),
    breached: count(list, 'breached'),
    pending: count(list, 'pending'),
    slaMet: list.filter((t) => slaMet(t, cfg)).length,
  }));
}

/** Up to `limit` turns behind the metric's value, oldest turn start first. */
export function metricSamples(metric: TurnMetricId, turns: AccountTurn[], cfg: StatsConfig, limit: number): StatsSample[] {
  return turns
    .filter(TURN_DEFINITIONS[metric].behind)
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

/** One row per group with at least one opener, sorted by group. */
export function openerRows(metric: OpenerMetricId, openers: AccountOpener[], groupBy: StatsGroupBy, cfg: StatsConfig): StatsMetricRow[] {
  const count = (list: AccountOpener[], keep: (o: Opener) => boolean) => list.filter(keep).length;
  return grouped(openers, groupBy, cfg.timezone).map(([group, list]) => ({
    group,
    ...OPENER_DEFINITIONS[metric].value(list),
    openers: list.length,
    firstEver: count(list, (o) => o.kind === 'first_ever'),
    reactivation: count(list, (o) => o.kind === 'reactivation'),
    unknownKind: count(list, (o) => o.kind === 'unknown'),
    replied: count(list, openerReplied),
    noReply: count(list, (o) => o.status === 'no_reply'),
    pending: count(list, (o) => o.status === 'pending'),
    massOrAutomatedGap: count(list, (o) => o.ignoredInGap > 0),
  }));
}

/** Up to `limit` openers behind the metric's value, oldest first. */
export function openerSamples(metric: OpenerMetricId, openers: AccountOpener[], limit: number): StatsOpenerSample[] {
  return openers
    .filter(OPENER_DEFINITIONS[metric].behind)
    .slice(0, limit)
    .map((o) => ({
      accountId: o.accountId,
      chatId: o.chatId,
      openerMessageId: o.messageId,
      sentAt: o.sentAt.toISOString(),
      kind: o.kind,
      previousMessageId: o.previousMessageId,
      previousAt: o.previousAt?.toISOString() ?? null,
      gapSeconds: o.previousAt ? (o.sentAt.getTime() - o.previousAt.getTime()) / 1000 : null,
      massOrAutomatedInGap: o.ignoredInGap,
      fanReplyMessageId: o.fanReplyMessageId,
      fanReplyAt: o.fanReplyAt?.toISOString() ?? null,
      fanReplySeconds: o.fanReplySeconds,
      status: o.status,
    }));
}

/** CSV columns: the row's fields in snake_case. */
export const METRIC_CSV_COLUMNS = ['group', 'value', 'n', 'turns', 'in_cap', 'late', 'breached', 'pending', 'sla_met'] as const;
export const OPENER_CSV_COLUMNS = ['group', 'value', 'n', 'openers', 'first_ever', 'reactivation', 'unknown_kind', 'replied', 'no_reply', 'pending', 'mass_or_automated_gap'] as const;
