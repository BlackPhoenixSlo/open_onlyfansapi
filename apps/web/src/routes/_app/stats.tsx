import type { StatsGroupBy } from '@api/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { ChevronDown } from 'lucide-react';
import { useMemo, useState } from 'react';
import { FilterSelect } from '@/components/filter-select';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartCard, Empty, ErrorCard, Kpi, NoData, Skeleton } from '@/features/stats/cards';
import { COLORS, Chart } from '@/features/stats/chart';
import { BackfillNotice } from '@/features/stats/BackfillNotice';
import { HowToRead } from '@/features/stats/explainers';
import { CustomRange, Segmented, day } from '@/features/stats/range';
import { RawData } from '@/features/stats/raw-data';
import { ScriptCard } from '@/features/stats/scripts';
import {
  addDays,
  combineAccounts,
  daysBetween,
  formatPercent,
  formatWait,
  formatWindow,
  hourSeries,
  liveLine,
  openerSeries,
  percent,
  replySeries,
  slaSeries,
  sum,
  todayIn,
} from '@/features/stats/series';
import {
  ApiError,
  type StatsRange,
  accountsQuery,
  statsConfigQuery,
  statsMetricQuery,
  statsMetricsQuery,
  statsScriptsQuery,
} from '@/lib/api';

const PRESET_DAYS = { '7d': 7, '30d': 30 } as const;
type Preset = keyof typeof PRESET_DAYS | 'custom';
const PRESETS: Preset[] = ['7d', '30d', 'custom'];

type Search = { range?: Preset; from?: string; to?: string; accountId?: number; metric?: string };

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
          ), then connect the account in{' '}
          <Link to="/accounts" className="underline">
            Accounts
          </Link>{' '}
          and press Run analytics.
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

  const replyData = replySeries(span, replyDay.data?.rows, p90Day.data?.rows);
  const slaData = slaSeries(span, slaDay.data?.rows);
  const openerData = openerSeries(span, openersDay.data?.rows);
  const hourData = hourSeries(replyHour.data?.rows);

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
        {preset === 'custom' && (
          <CustomRange
            from={range?.from}
            to={range?.to}
            onApply={(from, to) => navigate({ search: (prev) => ({ ...prev, range: 'custom', from, to }) })}
          />
        )}
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
        {search.accountId !== undefined && <BackfillNotice accountId={search.accountId} />}
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
        {showRaw && (
          <RawData
            metric={search.metric}
            onMetricChange={(metric) => navigate({ search: (prev) => ({ ...prev, metric }) })}
            range={range}
            catalogue={catalogue.data?.items}
            catalogueError={catalogue.error?.message}
          />
        )}
      </div>
    </div>
  );
}
