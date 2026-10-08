import type { StatsFreshness, StatsMetricRow } from '@api/contracts';

const DAY_MS = 86_400_000;

/** `day` (`YYYY-MM-DD`) plus `n` days. */
export const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** Today in the IANA timezone `tz`, as `YYYY-MM-DD` (en-CA formats as ISO). */
export const todayIn = (tz: string, now = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

/** Every day from `from` to `to`, both included. */
export function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (let d = from; d <= to && days.length < 400; d = addDays(d, 1)) days.push(d);
  return days;
}

export const HOURS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));

/** Rows by their `group`, for filling the gaps of a sparse series. */
export const byGroup = (rows: StatsMetricRow[] | undefined) => new Map((rows ?? []).map((r) => [r.group, r]));

type Rows = StatsMetricRow[] | undefined;

/** Median and 90th percentile reply time for each day of `span`; null on a day without data. */
export function replySeries(span: string[], median: Rows, p90: Rows) {
  const m = byGroup(median);
  const p = byGroup(p90);
  return span.map((d) => ({ day: d, median: m.get(d)?.value ?? null, p90: p.get(d)?.value ?? null }));
}

/** The SLA percent for each day of `span`; null on a day without data. */
export function slaSeries(span: string[], rows: Rows) {
  const sla = byGroup(rows);
  return span.map((d) => ({ day: d, sla: sla.get(d)?.value ?? null }));
}

/** Opener outcomes for each day of `span`; 0 on a day without data. */
export function openerSeries(span: string[], rows: Rows) {
  const op = byGroup(rows);
  return span.map((d) => ({ day: d, replied: op.get(d)?.replied ?? 0, noReply: op.get(d)?.noReply ?? 0, pending: op.get(d)?.pending ?? 0 }));
}

/** The median for each of the 24 hours; null on an hour without data. */
export function hourSeries(rows: Rows) {
  const hour = byGroup(rows);
  return HOURS.map((h) => ({ hour: h, median: hour.get(h)?.value ?? null }));
}

type CountKey = { [K in keyof StatsMetricRow]-?: StatsMetricRow[K] extends number | undefined ? K : never }[keyof StatsMetricRow];

export const sum = (rows: StatsMetricRow[] | undefined, key: CountKey) =>
  (rows ?? []).reduce((total, r) => total + (r[key] ?? 0), 0);

/** `part / whole` in percent; null when `whole` is 0. */
export const percent = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : null);

/**
 * One value from per-account rows of a median metric. Exact for a single account; for several it is the mean of the
 * account medians weighted by `n` (a median cannot be merged exactly), so `exact` is false.
 */
export function combineAccounts(rows: StatsMetricRow[] | undefined): { value: number | null; n: number; exact: boolean } {
  const withValue = (rows ?? []).flatMap((r) => (r.value !== null && r.n > 0 ? [{ value: r.value, n: r.n }] : []));
  const n = withValue.reduce((t, r) => t + r.n, 0);
  if (!n) return { value: null, n: 0, exact: true };
  const value = withValue.reduce((t, r) => t + r.value * r.n, 0) / n;
  return { value, n, exact: withValue.length === 1 };
}

/** A wait: `42s`, `4m 12s`, `2h 5m`. */
export function formatWait(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const part = (n: number, unit: string) => (n ? ` ${n}${unit}` : '');
  if (s < 3600) return `${Math.floor(s / 60)}m${part(s % 60, 's')}`;
  return `${Math.floor(s / 3600)}h${part(Math.floor((s % 3600) / 60), 'm')}`;
}

/** A config window in plain words: `7 days`, `24 h`, `15 min`. */
export function formatWindow(seconds: number): string {
  if (seconds % 86_400 === 0 && seconds >= 2 * 86_400) return `${seconds / 86_400} days`;
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

export const formatPercent = (x: number | null | undefined) => (x === null || x === undefined ? '—' : `${x.toFixed(1)}%`);

/** How long ago an ISO time was: `just now`, `5m ago`, `2h ago`, `3d ago`. */
export function formatAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

/** The Stats page's live line: the newest message event and the count of the last 24 hours. */
export const liveLine = (f: StatsFreshness, now = Date.now()) =>
  f.lastLiveAt ? `Live: last message event ${formatAgo(f.lastLiveAt, now)} · ${f.liveEvents24h} events last 24h` : 'Live: no events yet';
