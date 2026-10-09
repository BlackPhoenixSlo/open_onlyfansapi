import type { StatsGroupBy } from '@api/contracts';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { DataCard, ErrorCard, Kpi, NoData, WorkspaceNotLinked, isTeamNotLinked } from '@/features/stats/cards';
import { COLORS, Chart } from '@/features/stats/chart';
import { BackfillNotice } from '@/features/stats/BackfillNotice';
import { HowToRead, HowToReadDetails } from '@/features/stats/explainers';
import { FansCard } from '@/features/stats/fans';
import { RangeControls, type RangeSearch, rangeSearch, useStatsRange } from '@/features/stats/range';
import { RawData } from '@/features/stats/raw-data';
import { ScriptCard } from '@/features/stats/scripts';
import {
  combineAccounts,
  daysBetween,
  formatPercent,
  formatWait,
  formatWindow,
  hourSeries,
  openerSeries,
  percent,
  replySeries,
  shortDay,
  slaSeries,
  sum,
} from '@/features/stats/series';
import { type StatsRange, statsMetricQuery, statsMetricsQuery, statsScriptsQuery } from '@/lib/api';
import { nonEmpty } from '@/lib/search';

type Search = RangeSearch & { metric?: string };

export const Route = createFileRoute('/_app/stats')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    ...rangeSearch(s),
    metric: nonEmpty(s.metric),
  }),
  component: Stats,
});

/** Scripts asked for; a full page shows "50+". */
const SCRIPT_LIMIT = 50;

/** A metric over the page's range and account; idle until the range is known (it needs the config timezone). */
function useMetric(id: string, groupBy: StatsGroupBy, range: StatsRange | undefined) {
  return useQuery({ ...statsMetricQuery(id, { ...range, groupBy }), enabled: range !== undefined });
}

function Stats() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [showRaw, setShowRaw] = useState(false);
  const stats = useStatsRange(search);
  const { config, tz, range } = stats;
  const catalogue = useQuery(statsMetricsQuery);

  const replyDay = useMetric('reply_time', 'day', range);
  const p90Day = useMetric('reply_time_p90', 'day', range);
  const slaDay = useMetric('reply_sla', 'day', range);
  const openersDay = useMetric('openers', 'day', range);
  const replyHour = useMetric('reply_time', 'hour', range);
  const replyAccount = useMetric('reply_time', 'account', range);
  const scripts = useQuery({ ...statsScriptsQuery(range ?? {}), enabled: range !== undefined });

  const queries = [config, catalogue, replyDay, p90Day, slaDay, openersDay, replyHour, replyAccount, scripts];
  if (isTeamNotLinked(queries)) return <WorkspaceNotLinked title="Stats" subject="reply times, openers and scripts" />;

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
      <RangeControls
        title="Stats"
        search={search}
        stats={stats}
        served={replyDay.data}
      >
        {search.accountId !== undefined && <BackfillNotice accountId={search.accountId} />}
      </RangeControls>

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
          Half of fan turns answered within {cfg ? formatWindow(cfg.replyCapSeconds) : 'the cap'} got a reply
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
          Fan turns answered within {cfg ? formatWindow(cfg.slaSeconds) : 'the SLA'}.
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
        <DataCard
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
        </DataCard>
        <DataCard
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
        </DataCard>
        <DataCard
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
        </DataCard>
        <DataCard
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
        </DataCard>
      </div>

      <DataCard
        title="Scripts"
        description="DM texts sent 5+ times in 3+ chats, most sent in this range first. Muted numbers are all-time."
        state={scripts}
        empty={scriptCount === 0}
        skeletonClassName="h-36"
        emptyContent={<NoData />}
      >
        <div className="grid gap-3 md:grid-cols-2">
          {scripts.data?.items.map((s) => (
            <ScriptCard key={s.hash} script={s} />
          ))}
        </div>
      </DataCard>

      <FansCard range={range} />

      <HowToReadDetails>
        <HowToRead config={cfg} />
      </HowToReadDetails>

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
