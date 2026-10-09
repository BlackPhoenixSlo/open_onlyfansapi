import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ChartCard, ErrorCard, Kpi, NoData, Skeleton, WorkspaceNotLinked, isTeamNotLinked } from '@/features/stats/cards';
import { COLORS, Chart } from '@/features/stats/chart';
import { RevenueTerms } from '@/features/stats/explainers';
import { RangeControls, type RangeSearch, rangeSearch, useStatsRange } from '@/features/stats/range';
import { formatPercent } from '@/features/stats/series';
import { statsRevenueQuery } from '@/lib/api';
import { formatMoney } from '@/lib/utils';

export const Route = createFileRoute('/_app/revenue')({
  validateSearch: (s: Record<string, unknown>): RangeSearch => rangeSearch(s),
  component: Revenue,
});

const shortDay = (d: string) => d.slice(5);

/** A 0..1 rate as a percent; `—` when null. */
const ratePercent = (r: number | null | undefined) => formatPercent(r === null || r === undefined ? r : r * 100);

/** A card holding a table, with the query's loading, error and empty states. */
function TableCard({
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
        {state.isPending ? <Skeleton className="h-32" /> : state.isError ? <p className="text-destructive">{state.error?.message}</p> : empty ? <NoData /> : children}
      </CardContent>
    </Card>
  );
}

function Revenue() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const stats = useStatsRange(search);
  const { config, tz, range } = stats;
  const revenue = useQuery({ ...statsRevenueQuery(range ?? {}), enabled: range !== undefined });

  if (isTeamNotLinked([config, revenue])) return <WorkspaceNotLinked title="Revenue" subject="revenue, payers and PPV unlocks" />;

  const data = revenue.data;
  const totals = data?.totals;
  const dm = data?.ppv.find((p) => p.scope === 'dm');
  const state = { loading: revenue.isPending, error: revenue.error?.message };
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

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Kpi title="Gross" {...state} empty={noSales} value={formatMoney(totals?.gross ?? 0)}>
          What fans paid, before OF's fee.
        </Kpi>
        <Kpi title="Net" {...state} empty={noSales} value={formatMoney(totals?.net ?? 0)}>
          What the creator earns after OF's fee.
        </Kpi>
        <Kpi title="Transactions" {...state} empty={noSales} value={(totals?.transactions ?? 0).toLocaleString()}>
          PPVs bought, tips, subscriptions and paid posts.
        </Kpi>
        <Kpi title="Payers" {...state} empty={noSales} value={(totals?.payers ?? 0).toLocaleString()}>
          Fans who paid in this range.
        </Kpi>
        <Kpi
          title="Golden ratio"
          {...state}
          empty={totals?.goldenRatio === null || totals?.goldenRatio === undefined}
          value={ratePercent(totals?.goldenRatio)}
          sub={`${totals?.payers ?? 0} payers / ${totals?.fansMessaged ?? 0} fans messaged`}
        >
          Payers divided by the fans with a message in this range.
        </Kpi>
        <Kpi title="PPV unlock (DM)" {...state} empty={!dm?.sent} value={ratePercent(dm?.rate)} sub={`${dm?.opened ?? 0} opened / ${dm?.sent ?? 0} sent`}>
          Priced DMs opened over those sent. Upper bound: opened counts as bought.
        </Kpi>
      </div>

      <ChartCard title="Gross by day" description={`What fans paid each day (${tz ?? 'stats timezone'}).`} state={revenue} empty={noSales}>
        <Chart
          data={data?.byDay ?? []}
          x="day"
          xFormat={shortDay}
          xLabel="day"
          yLabel="gross"
          format={formatMoney}
          series={[{ key: 'gross', label: 'Gross', color: COLORS.primary, type: 'bar' }]}
        />
      </ChartCard>

      <div className="grid gap-4 lg:grid-cols-2">
        <TableCard title="By kind" description="OF's transaction type, most gross first." state={revenue} empty={noSales}>
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
        </TableCard>

        <TableCard
          title="PPV by scope"
          description="Priced messages sent and not unsent; opened counts as bought."
          state={revenue}
          empty={!data?.ppv.some((p) => p.sent > 0)}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Scope</TableHead>
                <TableHead className="text-right">Sent</TableHead>
                <TableHead className="text-right">Opened</TableHead>
                <TableHead className="text-right">Rate</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.ppv.map((p) => (
                <TableRow key={p.scope}>
                  <TableCell className="font-medium">{p.scope === 'dm' ? 'DM' : 'Mass'}</TableCell>
                  <TableCell className="text-right">{p.sent.toLocaleString()}</TableCell>
                  <TableCell className="text-right">{p.opened.toLocaleString()}</TableCell>
                  <TableCell className="text-right">{ratePercent(p.rate)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableCard>
      </div>

      <TableCard title="Top payers" description="The 50 fans who paid the most in this range." state={revenue} empty={!data?.topPayers.length}>
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
      </TableCard>

      <details className="group rounded-xl border bg-card p-4">
        <summary className="flex cursor-pointer list-none items-center gap-2 font-medium">
          <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
          How to read this
        </summary>
        <div className="mt-4">
          <RevenueTerms />
        </div>
      </details>
    </div>
  );
}
