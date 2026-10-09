import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DataCard, ErrorCard, Kpi, NoData, WorkspaceNotLinked, isTeamNotLinked } from '@/features/stats/cards';
import { COLORS, Chart } from '@/features/stats/chart';
import { HowToReadDetails, RevenueTerms } from '@/features/stats/explainers';
import { RangeControls, type RangeSearch, rangeSearch, useStatsRange } from '@/features/stats/range';
import { formatPercent, shortDay } from '@/features/stats/series';
import { statsRevenueQuery } from '@/lib/api';
import { formatMoney } from '@/lib/utils';

export const Route = createFileRoute('/_app/revenue')({
  validateSearch: (s: Record<string, unknown>): RangeSearch => rangeSearch(s),
  component: Revenue,
});

/** A table card's loading and empty states. */
const TABLE_CARD = { skeletonClassName: 'h-32', emptyContent: <NoData /> };

function Revenue() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const stats = useStatsRange(search);
  const { config, tz, range } = stats;
  const revenue = useQuery({ ...statsRevenueQuery(range ?? {}), enabled: range !== undefined });

  if (isTeamNotLinked([config, revenue])) return <WorkspaceNotLinked title="Revenue" subject="revenue, payers and PPV unlocks" />;

  const data = revenue.data;
  const totals = data?.totals;
  const dm = data?.ppv;
  const kpiState = { loading: revenue.isPending, error: revenue.error?.message };
  const noSales = !totals?.transactions;

  return (
    <div className="space-y-6">
      <RangeControls
        title="Revenue"
        search={search}
        stats={stats}
        served={data}
        onChange={(next) => navigate({ search: (prev) => ({ ...prev, ...next }) })}
      />

      {config.isError && <ErrorCard message={config.error.message} />}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi
          title="Gross"
          {...kpiState}
          empty={noSales}
          value={formatMoney(totals?.gross ?? 0)}
          sub={`settled ${formatMoney(totals?.settledGross ?? 0)} · pending ${formatMoney(totals?.pendingGross ?? 0)}`}
        >
          What fans paid, before OF's fee; refunds and reversals left out.
        </Kpi>
        <Kpi title="Net" {...kpiState} empty={noSales} value={formatMoney(totals?.net ?? 0)}>
          What the creator earns after OF's fee.
        </Kpi>
        <Kpi title="Transactions" {...kpiState} empty={noSales} value={(totals?.transactions ?? 0).toLocaleString()}>
          PPVs bought, tips, subscriptions and paid posts.
        </Kpi>
        <Kpi title="Payers" {...kpiState} empty={noSales} value={(totals?.payers ?? 0).toLocaleString()}>
          Fans who paid in this range.
        </Kpi>
        <Kpi
          title="Fan CVR"
          {...kpiState}
          empty={totals?.fanCvr === null || totals?.fanCvr === undefined}
          value={formatPercent(totals?.fanCvr)}
          sub={`${totals?.payers ?? 0} payers / ${totals?.fansMessaged ?? 0} fans messaged`}
        >
          Payers divided by the fans with a message in this range.
        </Kpi>
        <Kpi
          title="Golden ratio"
          {...kpiState}
          empty={totals?.goldenRatio === null || totals?.goldenRatio === undefined}
          value={formatPercent(totals?.goldenRatio)}
          sub={`${totals?.dmPpvs ?? 0} PPVs / ${totals?.dmMessages ?? 0} DMs`}
        >
          PPV DMs divided by all DMs sent (Infloww's formula).
        </Kpi>
        <Kpi title="PPV unlock (DM)" {...kpiState} empty={!dm?.sent} value={formatPercent(dm?.rate)} sub={`${dm?.opened ?? 0} bought / ${dm?.sent ?? 0} sent`}>
          Priced DMs bought over those sent. Upper bound: an unsent PPV nobody bought vanishes from OF's history.
        </Kpi>
      </div>

      <DataCard title="Gross by day" description={`What fans paid each day (${tz ?? 'stats timezone'}).`} state={revenue} empty={noSales}>
        <Chart
          data={data?.byDay ?? []}
          x="day"
          xFormat={shortDay}
          xLabel="day"
          yLabel="gross"
          format={formatMoney}
          series={[{ key: 'gross', label: 'Gross', color: COLORS.primary, type: 'bar' }]}
        />
      </DataCard>

      <DataCard title="By kind" description="OF's transaction type, most gross first." state={revenue} empty={noSales} {...TABLE_CARD}>
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
            {data?.byKind.map((k) => (
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

      <DataCard title="Top payers" description="The 50 fans who paid the most in this range." state={revenue} empty={!data?.topPayers.length} {...TABLE_CARD}>
        {data?.withoutChat.payers ? (
          <p className="mb-2 text-sm text-muted-foreground">
            {data.withoutChat.payers} of {totals?.payers ?? 0} payers in this range without a stored chat ({formatMoney(data.withoutChat.gross)})
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
            {data?.topPayers.map((p) => (
              <TableRow key={`${p.accountId}:${p.fanId}`}>
                <TableCell className="font-medium" title={`Fan ${p.fanId}`}>
                  {p.name ?? `fan ${p.fanId}`}
                  {p.isDeleted && <span className="ml-2 text-xs font-normal text-muted-foreground">deleted account</span>}
                </TableCell>
                <TableCell className="text-right">{formatMoney(p.gross)}</TableCell>
                <TableCell className="text-right">{formatMoney(p.net)}</TableCell>
                <TableCell className="text-right">{p.transactions}</TableCell>
                <TableCell>{new Date(p.lastAt).toLocaleString()}</TableCell>
                <TableCell>
                  {p.hasChat ? (
                    <Link
                      to="/conversations"
                      search={{ range: 'custom', from: data.from, to: data.to, chatAccountId: p.accountId, chatId: p.fanId }}
                      className="underline-offset-4 hover:underline"
                      title="Read the conversation"
                    >
                      yes
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">no</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DataCard>

      <HowToReadDetails>
        <RevenueTerms />
      </HowToReadDetails>
    </div>
  );
}
