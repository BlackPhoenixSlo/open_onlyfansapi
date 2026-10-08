import type { StatsGroupBy, StatsMetric, StatsMetricRow, StatsScript } from '@api/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { ChevronDown, Copy } from 'lucide-react';
import { type FormEvent, type ReactNode, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { FilterSelect } from '@/components/filter-select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { COLORS, Chart } from '@/features/stats/chart';
import { HowToRead } from '@/features/stats/explainers';
import {
  HOURS,
  addDays,
  byGroup,
  combineAccounts,
  daysBetween,
  formatPercent,
  formatWait,
  formatWindow,
  liveLine,
  percent,
  sum,
  todayIn,
} from '@/features/stats/series';
import {
  ApiError,
  type StatsRange,
  accountsQuery,
  statsConfigQuery,
  statsMetricPath,
  statsMetricQuery,
  statsMetricsQuery,
  statsScriptsQuery,
} from '@/lib/api';

const PRESET_DAYS = { '7d': 7, '30d': 30 } as const;
type Preset = keyof typeof PRESET_DAYS | 'custom';
const PRESETS: Preset[] = ['7d', '30d', 'custom'];

type Search = { range?: Preset; from?: string; to?: string; accountId?: number; metric?: string };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (v: unknown) => (typeof v === 'string' && DAY.test(v) ? v : undefined);

export const Route = createFileRoute('/_app/stats')({
  validateSearch: (s: Record<string, unknown>): Search => {
    const accountId = Number(s.accountId);
    return {
      range: PRESETS.find((p) => p === s.range),
      from: day(s.from),
      to: day(s.to),
      accountId: Number.isInteger(accountId) && accountId > 0 ? accountId : undefined,
      metric: typeof s.metric === 'string' && s.metric ? s.metric : undefined,
    };
  },
  component: Stats,
});

/** Scripts asked for; a full page shows "50+". */
const SCRIPT_LIMIT = 50;

const shortDay = (d: string) => d.slice(5);

/** A metric over the page's range and account; idle until the range is known (it needs the config timezone). */
function useMetric(id: string, groupBy: StatsGroupBy, range: StatsRange | undefined, enabled = true) {
  return useQuery({ ...statsMetricQuery(id, { ...range, groupBy }), enabled: enabled && range !== undefined });
}

function Stats() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const preset = search.range ?? '30d';
  const [showRaw, setShowRaw] = useState(false);

  const config = useQuery(statsConfigQuery);
  const catalogue = useQuery(statsMetricsQuery);
  const accounts = useQuery(accountsQuery);
  const tz = config.data?.config.timezone;

  // Presets end today in the stats timezone; a custom range without days falls back to the API default (30 days).
  const range = useMemo((): StatsRange | undefined => {
    if (preset === 'custom') return { from: search.from, to: search.to, accountId: search.accountId };
    // Without the config (an error shown below), let the API pick its default range.
    if (!tz) return config.isError ? { accountId: search.accountId } : undefined;
    const to = todayIn(tz);
    return { from: addDays(to, -(PRESET_DAYS[preset] - 1)), to, accountId: search.accountId };
  }, [preset, search.from, search.to, search.accountId, tz, config.isError]);

  const replyDay = useMetric('reply_time', 'day', range);
  const p90Day = useMetric('reply_time_p90', 'day', range);
  const slaDay = useMetric('reply_sla', 'day', range);
  const openersDay = useMetric('openers', 'day', range);
  const replyHour = useMetric('reply_time', 'hour', range);
  const replyAccount = useMetric('reply_time', 'account', range);
  const scripts = useQuery({ ...statsScriptsQuery(range ?? {}), enabled: range !== undefined });

  const queries = [config, catalogue, replyDay, p90Day, slaDay, openersDay, replyHour, replyAccount, scripts];
  const unlinked = queries.some((q) => q.error instanceof ApiError && q.error.code === 'team_not_linked');

  if (unlinked) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">Stats</h1>
        <Empty title="Workspace not linked">
          Stats read what the analytics backfill stored for this workspace. Link the workspace (
          <code className="rounded bg-muted px-1 py-0.5">pnpm --filter @gateway/api link-team &lt;slug&gt;</code>
          ), connect an account on <Link to="/accounts" className="underline">Accounts</Link>, then claim it and run the
          backfill (<code className="rounded bg-muted px-1 py-0.5">analytics:claim</code>,{' '}
          <code className="rounded bg-muted px-1 py-0.5">analytics:backfill</code>; see docs/analytics-backfill.md).
        </Empty>
      </div>
    );
  }

  const cfg = config.data?.config;
  const verified = (id: string) => catalogue.data?.items.find((m) => m.id === id)?.verified;
  const span = replyDay.data ? daysBetween(replyDay.data.from, replyDay.data.to) : [];

  // KPIs: counts and rates sum exactly over days; a median does not, so it comes from per-account rows.
  const median = combineAccounts(replyAccount.data?.rows);
  const turns = sum(replyDay.data?.rows, 'turns');
  const sla = percent(sum(slaDay.data?.rows, 'slaMet'), sum(slaDay.data?.rows, 'n'));
  const openers = sum(openersDay.data?.rows, 'openers');
  const openerRate = percent(sum(openersDay.data?.rows, 'replied'), sum(openersDay.data?.rows, 'replied') + sum(openersDay.data?.rows, 'noReply'));
  const scriptCount = scripts.data?.items.length ?? 0;

  const rt = byGroup(replyDay.data?.rows);
  const p90 = byGroup(p90Day.data?.rows);
  const slaRows = byGroup(slaDay.data?.rows);
  const op = byGroup(openersDay.data?.rows);
  const hour = byGroup(replyHour.data?.rows);
  const replyData = span.map((d) => ({ day: d, median: rt.get(d)?.value ?? null, p90: p90.get(d)?.value ?? null }));
  const slaData = span.map((d) => ({ day: d, sla: slaRows.get(d)?.value ?? null }));
  const openerData = span.map((d) => ({
    day: d,
    replied: op.get(d)?.replied ?? 0,
    noReply: op.get(d)?.noReply ?? 0,
    pending: op.get(d)?.pending ?? 0,
  }));
  const hourData = HOURS.map((h) => ({ hour: h, median: hour.get(h)?.value ?? null }));

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold">Stats</h1>
          <div className="flex flex-wrap items-center gap-2">
            <FilterSelect
              all="All accounts"
              className="w-48"
              value={search.accountId === undefined ? undefined : String(search.accountId)}
              options={(accounts.data?.items ?? []).map((a) => ({
                value: String(a.id),
                label: a.username ? `@${a.username}` : (a.label ?? String(a.id)),
              }))}
              onChange={(v) => navigate({ search: (prev) => ({ ...prev, accountId: v ? Number(v) : undefined }) })}
            />
            <Segmented
              options={PRESETS}
              value={preset}
              onChange={(next) =>
                navigate({
                  search: (prev) =>
                    next === 'custom'
                      ? { ...prev, range: next, from: range?.from ?? replyDay.data?.from, to: range?.to ?? replyDay.data?.to }
                      : { ...prev, range: next, from: undefined, to: undefined },
                })
              }
            />
          </div>
        </div>
        {preset === 'custom' && <CustomRange from={range?.from} to={range?.to} />}
        <p className="text-xs text-muted-foreground">
          {replyDay.data ? `${replyDay.data.from} to ${replyDay.data.to} · ` : ''}
          {cfg ? `timezone ${cfg.timezone} · config v${cfg.version}` : 'loading config…'}
          {replyDay.data && ` · as of ${new Date(replyDay.data.asOf).toLocaleString()}`}
        </p>
        {config.data && (
          <p className="text-xs text-muted-foreground" title={config.data.freshness.lastLiveAt ?? undefined}>
            {liveLine(config.data.freshness)}
          </p>
        )}
      </div>

      {config.isError && <ErrorCard message={config.error.message} />}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Kpi
          title="Median reply time"
          loading={replyAccount.isPending}
          error={replyAccount.error?.message}
          empty={median.n === 0}
          value={`${median.exact ? '' : '≈ '}${formatWait(median.value)}`}
          hint={!median.exact ? 'Several accounts: weighted mean of each account’s median.' : undefined}
          verified={verified('reply_time')}
        >
          Half of fan messages answered within {cfg ? formatWindow(cfg.replyCapSeconds) : 'the cap'} got a reply
          faster than this.
        </Kpi>
        <Kpi
          title="Reply SLA"
          loading={slaDay.isPending}
          error={slaDay.error?.message}
          empty={sla === null}
          value={formatPercent(sla)}
          verified={verified('reply_sla')}
        >
          Fan messages answered within {cfg ? formatWindow(cfg.slaSeconds) : 'the SLA'}.
        </Kpi>
        <Kpi
          title="Openers"
          loading={openersDay.isPending}
          error={openersDay.error?.message}
          empty={openers === 0}
          value={openers.toLocaleString()}
          sub={`${formatPercent(openerRate)} got a fan reply`}
          verified={verified('openers')}
        >
          Quiet chats a chatter restarted.
        </Kpi>
        <Kpi
          title="Scripts"
          loading={scripts.isPending}
          error={scripts.error?.message}
          empty={scriptCount === 0}
          value={`${scriptCount}${scriptCount >= SCRIPT_LIMIT ? '+' : ''}`}
          verified={false}
        >
          Repeated DM texts sent in this range.
        </Kpi>
        <Kpi
          title="Fan turns"
          loading={replyDay.isPending}
          error={replyDay.error?.message}
          empty={turns === 0}
          value={turns.toLocaleString()}
          sub={`${sum(replyDay.data?.rows, 'breached').toLocaleString()} unanswered`}
          verified={verified('reply_time')}
        >
          Times a fan wrote and waited for a reply.
        </Kpi>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard
          title="Reply time by day"
          description="Median and 90th percentile wait, replies within the cap only. Lower is better."
          state={replyDay}
          empty={!replyDay.data?.rows.length}
        >
          <Chart
            data={replyData}
            x="day"
            xFormat={shortDay}
            xLabel="day"
            yLabel="wait"
            format={formatWait}
            series={[
              { key: 'median', label: 'Median', color: COLORS.primary, type: 'line' },
              { key: 'p90', label: '90th percentile', color: COLORS.soft, type: 'line' },
            ]}
          />
        </ChartCard>
        <ChartCard
          title="Reply SLA by day"
          description={`Share of fan turns answered within ${cfg ? formatWindow(cfg.slaSeconds) : 'the SLA'}. Higher is better.`}
          state={slaDay}
          empty={!slaDay.data?.rows.some((r) => r.value !== null)}
        >
          <Chart
            data={slaData}
            x="day"
            xFormat={shortDay}
            xLabel="day"
            yLabel="% in SLA"
            yMax={100}
            format={(v) => `${Math.round(v)}%`}
            series={[{ key: 'sla', label: 'SLA met', color: COLORS.ok, type: 'bar' }]}
          />
        </ChartCard>
        <ChartCard
          title="Openers per day"
          description={`Whether the fan answered within ${cfg ? formatWindow(cfg.openReplySeconds) : 'the window'}; pending means the window is still open.`}
          state={openersDay}
          empty={!openersDay.data?.rows.length}
        >
          <Chart
            data={openerData}
            x="day"
            xFormat={shortDay}
            xLabel="day"
            yLabel="openers"
            format={(v) => v.toLocaleString()}
            series={[
              { key: 'replied', label: 'Replied', color: COLORS.ok, type: 'bar', stack: 'o' },
              { key: 'noReply', label: 'No reply', color: COLORS.bad, type: 'bar', stack: 'o' },
              { key: 'pending', label: 'Pending', color: COLORS.wait, type: 'bar', stack: 'o' },
            ]}
          />
        </ChartCard>
        <ChartCard
          title="Reply time by hour of day"
          description={`Median wait by the hour the fan wrote (${tz ?? 'stats timezone'}). Shows the slow shifts.`}
          state={replyHour}
          empty={!replyHour.data?.rows.length}
        >
          <Chart
            data={hourData}
            x="hour"
            xFormat={(h) => `${h}:00`}
            xLabel="hour the fan wrote"
            yLabel="median wait"
            format={formatWait}
            series={[{ key: 'median', label: 'Median', color: COLORS.primary, type: 'bar' }]}
          />
        </ChartCard>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Scripts</CardTitle>
          <CardDescription>
            DM texts sent 5+ times in 3+ chats, most sent in this range first. Muted numbers are all-time.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {scripts.isPending ? (
            <div className="grid gap-3 md:grid-cols-2">
              <Skeleton className="h-36" />
              <Skeleton className="h-36" />
            </div>
          ) : scripts.isError ? (
            <p className="text-destructive">{scripts.error.message}</p>
          ) : scripts.data.items.length === 0 ? (
            <NoData />
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {scripts.data.items.map((s) => (
                <ScriptCard key={s.hash} script={s} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <details className="group rounded-xl border bg-card p-4">
        <summary className="flex cursor-pointer list-none items-center gap-2 font-medium">
          <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
          How to read this
        </summary>
        <div className="mt-4">
          <HowToRead config={cfg} />
        </div>
      </details>

      <div className="space-y-4">
        <Button variant="ghost" onClick={() => setShowRaw((v) => !v)} aria-expanded={showRaw}>
          <ChevronDown className={`size-4 transition-transform ${showRaw ? 'rotate-180' : ''}`} />
          Raw data
        </Button>
        {showRaw && <RawData range={range} catalogue={catalogue.data?.items} catalogueError={catalogue.error?.message} />}
      </div>
    </div>
  );
}

function Segmented<T extends string>({ options, value, onChange }: { options: readonly T[]; value: T; onChange: (value: T) => void }) {
  return (
    <div className="flex gap-1">
      {options.map((o) => (
        <Button key={o} size="sm" variant={o === value ? 'default' : 'ghost'} aria-pressed={o === value} className="capitalize" onClick={() => onChange(o)}>
          {o}
        </Button>
      ))}
    </div>
  );
}

function CustomRange({ from, to }: { from?: string; to?: string }) {
  const navigate = Route.useNavigate();
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    navigate({ search: (prev) => ({ ...prev, range: 'custom', from: day(data.get('from')), to: day(data.get('to')) }) });
  }
  return (
    <form key={`${from}|${to}`} onSubmit={onSubmit} className="flex flex-wrap items-center justify-end gap-2">
      <Input name="from" type="date" defaultValue={from} aria-label="From" className="w-40" />
      <span className="text-muted-foreground">to</span>
      <Input name="to" type="date" defaultValue={to} aria-label="To (inclusive)" className="w-40" />
      <Button type="submit" variant="secondary">
        Apply
      </Button>
    </form>
  );
}

function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-muted ${className}`} />;
}

function Unverified() {
  return (
    <Badge variant="outline" className="border-amber-500/50 text-amber-700 dark:text-amber-400" title="Not yet checked by hand; see How to read this">
      unverified
    </Badge>
  );
}

function Kpi({
  title,
  value,
  sub,
  hint,
  loading,
  error,
  empty,
  verified,
  children,
}: {
  title: string;
  value: string;
  sub?: string;
  hint?: string;
  loading: boolean;
  error?: string;
  empty: boolean;
  verified?: boolean;
  children: ReactNode;
}) {
  if (loading) return <Skeleton className="h-32" />;
  const blank = empty && !error;
  return (
    <div className={`flex flex-col gap-1 rounded-xl border bg-card p-4 ${blank ? 'border-dashed bg-transparent' : ''}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-muted-foreground">{title}</span>
        {verified === false && !blank && <Unverified />}
      </div>
      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : blank ? (
        <>
          <span className="text-3xl font-semibold text-muted-foreground">—</span>
          <span className="text-xs text-muted-foreground">No data yet. Run the backfill for this range.</span>
        </>
      ) : (
        <>
          <span className="text-3xl font-semibold tabular-nums" title={hint}>
            {value}
          </span>
          {sub && <span className="text-sm">{sub}</span>}
          <span className="text-xs leading-snug text-muted-foreground">{children}</span>
        </>
      )}
    </div>
  );
}

function ChartCard({
  title,
  description,
  state,
  empty,
  children,
}: {
  title: string;
  description: string;
  state: { isPending: boolean; isError: boolean; error: Error | null };
  empty: boolean;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {state.isPending ? (
          <Skeleton className="h-[240px]" />
        ) : state.isError ? (
          <p className="text-destructive">{state.error?.message}</p>
        ) : empty ? (
          <div className="flex h-[240px] items-center justify-center rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No data in this range. Run the backfill for these days.
          </div>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}

function ScriptCard({ script: s }: { script: StatsScript }) {
  const decided = s.replied + s.noReply;
  async function copyHash() {
    try {
      await navigator.clipboard.writeText(s.hash);
      toast.success('Hash copied');
    } catch {
      toast.error('Could not copy the hash');
    }
  }
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      <blockquote className="line-clamp-3 border-l-2 pl-3 text-sm italic" title={s.variants[0]?.text}>
        {s.variants[0]?.text ?? '—'}
      </blockquote>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
        <span>
          <b className="tabular-nums">{s.sends}</b> sends <span className="text-muted-foreground">/ {s.sendsAll} all-time</span>
        </span>
        <span>
          <b className="tabular-nums">{s.chats}</b> chats <span className="text-muted-foreground">/ {s.chatsAll} all-time</span>
        </span>
        {s.variantCount > 1 && <span className="text-xs text-muted-foreground">{s.variantCount} variants</span>}
      </div>
      <div className="space-y-1">
        <div className="flex items-center justify-between text-xs">
          <span>Fan replied {formatPercent(s.replyRate)}</span>
          <span className="text-muted-foreground">
            {s.replied} of {decided}
            {s.pending ? ` · ${s.pending} pending` : ''}
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full" style={{ width: `${s.replyRate ?? 0}%`, background: COLORS.ok }} />
        </div>
      </div>
      <div className="mt-auto flex items-center justify-between gap-2">
        <code className="text-xs text-muted-foreground">{s.hash}</code>
        <Button size="sm" variant="ghost" onClick={copyHash}>
          <Copy className="size-3.5" />
          Copy hash
        </Button>
      </div>
    </div>
  );
}

/** Count columns shown when any row carries them (reply time metrics carry turns, opener metrics openers). */
const COUNT_COLUMNS: [keyof StatsMetricRow, string][] = [
  ['turns', 'Turns'],
  ['inCap', 'In cap'],
  ['late', 'Late'],
  ['breached', 'Breached'],
  ['slaMet', 'SLA met'],
  ['openers', 'Openers'],
  ['firstEver', 'First ever'],
  ['reactivation', 'Reactivation'],
  ['unknownKind', 'Unknown kind'],
  ['replied', 'Replied'],
  ['noReply', 'No reply'],
  ['massOrAutomatedGap', 'Mass/auto gap'],
  ['pending', 'Pending'],
];

function formatValue(value: number | null, unit: StatsMetric['unit'] | undefined) {
  if (unit === 'percent') return formatPercent(value);
  if (unit === 'seconds') return formatWait(value);
  return value === null ? '—' : value.toLocaleString();
}

/** The metric-by-day table, its CSV export, and the metric catalogue. */
function RawData({ range, catalogue, catalogueError }: { range?: StatsRange; catalogue?: StatsMetric[]; catalogueError?: string }) {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const metric = search.metric ?? catalogue?.[0]?.id;
  const meta = catalogue?.find((m) => m.id === metric);
  const series = useMetric(metric ?? '', 'day', range, metric !== undefined);
  const columns = COUNT_COLUMNS.filter(([key]) => series.data?.rows.some((r) => r[key] !== undefined));

  async function downloadCsv() {
    if (!metric || !range) return;
    // A plain link would not send `x-dashboard`, so the session would not authorise it.
    const res = await fetch(statsMetricPath(metric, { ...range, groupBy: 'day' }, 'csv'), {
      headers: { 'x-dashboard': '1' },
      credentials: 'include',
    });
    if (!res.ok) {
      toast.error(`CSV export failed (${res.status})`);
      return;
    }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = `${metric}-${series.data?.from ?? range.from}-${series.data?.to ?? range.to}-by-day.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url));
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Metric by day</CardTitle>
          {meta && <CardDescription className="leading-relaxed">{meta.description}</CardDescription>}
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={metric ?? ''} onValueChange={(v) => navigate({ search: (prev) => ({ ...prev, metric: v }) })}>
              <SelectTrigger className="w-72" aria-label="Metric">
                <SelectValue placeholder="Metric" />
              </SelectTrigger>
              <SelectContent>
                {(catalogue ?? []).map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" disabled={!series.data?.rows.length} onClick={downloadCsv}>
              Export CSV
            </Button>
          </div>
          {catalogueError ? (
            <p className="text-destructive">{catalogueError}</p>
          ) : series.isPending ? (
            <Skeleton className="h-40" />
          ) : series.isError ? (
            <p className="text-destructive">{series.error.message}</p>
          ) : series.data.rows.length === 0 ? (
            <NoData />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Day</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                  <TableHead className="text-right">n</TableHead>
                  {columns.map(([key, label]) => (
                    <TableHead key={key} className="text-right">
                      {label}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {series.data.rows.map((r) => (
                  <TableRow key={r.group}>
                    <TableCell className="font-medium">{r.group}</TableCell>
                    <TableCell className="text-right">{formatValue(r.value, meta?.unit)}</TableCell>
                    <TableCell className="text-right">{r.n}</TableCell>
                    {columns.map(([key]) => (
                      <TableCell key={key} className="text-right">
                        {r[key] ?? '—'}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Metric catalogue</CardTitle>
        </CardHeader>
        <CardContent>
          {catalogue === undefined ? (
            <Skeleton className="h-40" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Id</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Verified</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {catalogue.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="align-top font-mono">{m.id}</TableCell>
                    <TableCell className="max-w-2xl whitespace-normal text-muted-foreground">{m.description}</TableCell>
                    <TableCell className="align-top">
                      <Badge variant={m.verified ? 'default' : 'secondary'}>{m.verified ? 'yes' : 'no'}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function ErrorCard({ message }: { message: string }) {
  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <CardTitle className="text-destructive">Could not load stats</CardTitle>
        <CardDescription>{message}</CardDescription>
      </CardHeader>
    </Card>
  );
}

function NoData() {
  return (
    <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
      No data in this range. Connect an account on{' '}
      <Link to="/accounts" className="underline">
        Accounts
      </Link>
      , claim it and run the analytics backfill for these days (docs/analytics-backfill.md).
    </div>
  );
}

function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription className="leading-relaxed">{children}</CardDescription>
      </CardHeader>
      <CardContent />
    </Card>
  );
}
