import type { StatsRevenue } from '@api/contracts';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ConversationLink, FanLabel } from '@/features/conversations/fan';
import { formatMoney } from '@/features/conversations/format';
import { DataCard, ErrorCard, Kpi, NoData, Skeleton, WorkspaceNotLinked, isTeamNotLinked } from '@/features/stats/cards';
import { COLORS, Chart } from '@/features/stats/chart';
import { HowToReadDetails, RevenueTerms } from '@/features/stats/explainers';
import { RangeControls, type RangeSearch, rangeSearch, useStatsRange } from '@/features/stats/range';
import { formatPercent, shortDay } from '@/features/stats/series';
import { statsRevenueQuery } from '@/lib/api';

export const Route = createFileRoute('/_app/revenue')({
  validateSearch: (s: Record<string, unknown>): RangeSearch => rangeSearch(s),
  component: Revenue,
});

function Revenue() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const stats = useStatsRange(search);
  const { config, tz, range } = stats;
  const revenue = useQuery({ ...statsRevenueQuery(range ?? {}), enabled: range !== undefined });

  if (isTeamNotLinked([config, revenue])) return <WorkspaceNotLinked title="Revenue" subject="revenue, payers and PPV unlocks" />;

  return (
    <div className="space-y-6">
      <RangeControls
        title="Revenue"
        search={search}
        stats={stats}
        served={revenue.data}
        onChange={(next) => navigate({ search: (prev) => ({ ...prev, ...next }) })}
      />

      {config.isError && <ErrorCard message={config.error.message} />}

      {revenue.isPending ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 7 }, (_, i) => <Skeleton key={i} className="h-32" />)}
        </div>
      ) : revenue.isError ? (
        <ErrorCard message={revenue.error.message} />
      ) : (
        <>
          <RevenueKpis totals={revenue.data.totals} ppv={revenue.data.ppv} />

          <DataCard title="Gross by day" description={`What fans paid each day (${tz ?? 'stats timezone'}).`} state={revenue} empty={!revenue.data.totals.transactions}>
            <Chart
              data={revenue.data.byDay}
              x="day"
              xFormat={shortDay}
              xLabel="day"
              yLabel="gross"
              format={formatMoney}
              series={[{ key: 'gross', label: 'Gross', color: COLORS.primary, type: 'bar' }]}
            />
          </DataCard>

          <DataCard title="By kind" description="OF's transaction type, most gross first." state={revenue} empty={!revenue.data.totals.transactions} emptyContent={<NoData />}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Kind</TableHead>
                  <TableHead className="text-right">Transactions</TableHead>
                  <TableHead className="text-right">Gross</TableHead>
                  <TableHead className="text-right">Net</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {revenue.data.byKind.map((k) => (
                  <TableRow key={k.kind}>
                    <TableCell className="font-medium">{k.kind}</TableCell>
                    <TableCell className="text-right">{k.transactions.toLocaleString()}</TableCell>
                    <TableCell className="text-right">{formatMoney(k.gross)}</TableCell>
                    <TableCell className="text-right">{formatMoney(k.net)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </DataCard>

          <DataCard title="Top payers" description="The 50 fans who paid the most in this range." state={revenue} empty={!revenue.data.topPayers.length} emptyContent={<NoData />}>
            <TopPayersTable data={revenue.data} />
          </DataCard>
        </>
      )}

      <HowToReadDetails>
        <RevenueTerms />
      </HowToReadDetails>
    </div>
  );
}

/** The Revenue page's tiles; a money tile is blank when the range has no sale, a rate when it has nothing to divide by. */
function RevenueKpis({ totals, ppv }: Pick<StatsRevenue, 'totals' | 'ppv'>) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Kpi
        title="Gross"
        empty={!totals.transactions}
        value={formatMoney(totals.gross)}
        sub={`settled ${formatMoney(totals.settledGross)} · pending ${formatMoney(totals.pendingGross)}`}
      >
        What fans paid, before OF's fee; refunds and reversals left out.
      </Kpi>
      <Kpi title="Net" empty={!totals.transactions} value={formatMoney(totals.net)}>
        What the creator earns after OF's fee.
      </Kpi>
      <Kpi title="Transactions" empty={!totals.transactions} value={totals.transactions.toLocaleString()}>
        PPVs bought, tips, subscriptions and paid posts.
      </Kpi>
      <Kpi title="Payers" empty={!totals.transactions} value={totals.payers.toLocaleString()}>
        Fans who paid in this range.
      </Kpi>
      <Kpi title="Fan CVR" empty={totals.fanCvr === null} value={formatPercent(totals.fanCvr)} sub={`${totals.payers} payers / ${totals.fansMessaged} fans messaged`}>
        Payers divided by the fans with a message in this range.
      </Kpi>
      <Kpi title="Golden ratio" empty={totals.goldenRatio === null} value={formatPercent(totals.goldenRatio)} sub={`${totals.dmPpvs} PPVs / ${totals.dmMessages} DMs`}>
        PPV DMs divided by all DMs sent (Infloww's formula).
      </Kpi>
      <Kpi title="PPV unlock (DM)" empty={!ppv.sent} value={formatPercent(ppv.rate)} sub={`${ppv.opened} bought / ${ppv.sent} sent`}>
        Priced DMs bought over those sent. Upper bound: an unsent PPV nobody bought vanishes from OF's history.
      </Kpi>
    </div>
  );
}

/** The top payers of `data`, each linked to their thread when a chat is stored, after a count of the range's payers without one. */
function TopPayersTable({ data }: { data: StatsRevenue }) {
  const payers = data.topPayers.map((p) => ({ ...p, chatId: p.fanId }));
  return (
    <>
      {data.withoutChat.payers ? (
        <p className="mb-2 text-sm text-muted-foreground">
          {data.withoutChat.payers} of {data.totals.payers} payers in this range without a stored chat ({formatMoney(data.withoutChat.gross)})
        </p>
      ) : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Fan</TableHead>
            <TableHead className="text-right">Gross</TableHead>
            <TableHead className="text-right">Net</TableHead>
            <TableHead className="text-right">Transactions</TableHead>
            <TableHead>Last purchase</TableHead>
            <TableHead>Chat</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {payers.map((p) => (
            <TableRow key={`${p.accountId}:${p.chatId}`}>
              <TableCell className="font-medium" title={`Fan ${p.chatId}`}>
                <FanLabel fan={p} />
              </TableCell>
              <TableCell className="text-right">{formatMoney(p.gross)}</TableCell>
              <TableCell className="text-right">{formatMoney(p.net)}</TableCell>
              <TableCell className="text-right">{p.transactions}</TableCell>
              <TableCell>{new Date(p.lastAt).toLocaleString()}</TableCell>
              <TableCell>
                {p.hasChat ? (
                  <ConversationLink fan={p} range={data}>
                    yes
                  </ConversationLink>
                ) : (
                  <span className="text-muted-foreground">no</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}
