import type { StatsMetric, StatsMetricRow } from '@api/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import type { FormEvent, ReactNode } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ApiError, statsMetricPath, statsMetricQuery, statsMetricsQuery, statsScriptsQuery } from '@/lib/api';

type Search = { metric?: string; from?: string; to?: string };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (v: unknown) => (typeof v === 'string' && DAY.test(v) ? v : undefined);

export const Route = createFileRoute('/_app/stats')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    metric: typeof s.metric === 'string' && s.metric ? s.metric : undefined,
    from: day(s.from),
    to: day(s.to),
  }),
  component: Stats,
});

/** The last 30 days, `to` inclusive (the API's default, taken in UTC here). */
function defaultRange() {
  const to = new Date();
  const from = new Date(to.getTime() - 29 * 86_400_000);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
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
  if (value === null) return '—';
  if (unit === 'percent') return `${value.toFixed(1)}%`;
  if (unit !== 'seconds') return value.toLocaleString();
  const s = Math.round(value);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

const rate = (x: number | null) => (x === null ? '—' : `${x.toFixed(1)}%`);

function Stats() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const defaults = defaultRange();
  const range = { from: search.from ?? defaults.from, to: search.to ?? defaults.to };

  const catalogue = useQuery(statsMetricsQuery);
  const metric = search.metric ?? catalogue.data?.items[0]?.id;
  const meta = catalogue.data?.items.find((m) => m.id === metric);
  const params = { ...range, groupBy: 'day' as const };
  const series = useQuery({ ...statsMetricQuery(metric ?? '', params), enabled: metric !== undefined });
  const scripts = useQuery(statsScriptsQuery(range));

  const unlinked = [catalogue.error, series.error, scripts.error].some(
    (e) => e instanceof ApiError && e.code === 'team_not_linked',
  );

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    navigate({ search: (prev) => ({ ...prev, from: day(data.get('from')), to: day(data.get('to')) }) });
  }

  async function downloadCsv() {
    if (!metric) return;
    // A plain link would not send `x-dashboard`, so the session would not authorise it.
    const res = await fetch(statsMetricPath(metric, params, 'csv'), { headers: { 'x-dashboard': '1' }, credentials: 'include' });
    if (!res.ok) {
      toast.error(`CSV export failed (${res.status})`);
      return;
    }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = `${metric}-${range.from}-${range.to}-by-day.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url));
  }

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

  const columns = COUNT_COLUMNS.filter(([key]) => series.data?.rows.some((r) => r[key] !== undefined));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Stats</h1>
        <form key={`${range.from}|${range.to}`} onSubmit={onSubmit} className="flex items-center gap-2">
          <Input name="from" type="date" defaultValue={range.from} aria-label="From" className="w-40" />
          <span className="text-muted-foreground">to</span>
          <Input name="to" type="date" defaultValue={range.to} aria-label="To (inclusive)" className="w-40" />
          <Button type="submit" variant="secondary">
            Apply
          </Button>
        </form>
      </div>
      <p className="text-sm text-muted-foreground">
        Days are in the workspace's stats timezone; the end day is included. Numbers come from the analytics backfill,
        not live OF. Every metric is unverified.
      </p>

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
                {(catalogue.data?.items ?? []).map((m) => (
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
          {catalogue.isError ? (
            <p className="text-destructive">{catalogue.error.message}</p>
          ) : series.isPending ? (
            <p className="text-muted-foreground">Loading…</p>
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
          {series.data && (
            <p className="text-xs text-muted-foreground">
              As of {new Date(series.data.asOf).toLocaleString()} · timezone {series.data.timezone} · config v
              {series.data.configVersion}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Scripts</CardTitle>
          <CardDescription>DM texts sent 5+ times in 3+ chats, most sent in the range first.</CardDescription>
        </CardHeader>
        <CardContent>
          {scripts.isPending ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : scripts.isError ? (
            <p className="text-destructive">{scripts.error.message}</p>
          ) : scripts.data.items.length === 0 ? (
            <NoData />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Hash</TableHead>
                  <TableHead className="text-right">Sends</TableHead>
                  <TableHead className="text-right">Chats</TableHead>
                  <TableHead className="text-right">Reply rate</TableHead>
                  <TableHead>Top variant</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {scripts.data.items.map((s) => (
                  <TableRow key={s.hash}>
                    <TableCell className="font-mono">{s.hash}</TableCell>
                    <TableCell className="text-right">
                      {s.sends} <span className="text-muted-foreground">/ {s.sendsAll}</span>
                    </TableCell>
                    <TableCell className="text-right">
                      {s.chats} <span className="text-muted-foreground">/ {s.chatsAll}</span>
                    </TableCell>
                    <TableCell className="text-right">{rate(s.replyRate)}</TableCell>
                    <TableCell className="max-w-md whitespace-normal">
                      <span className="line-clamp-2" title={s.variants[0]?.text}>
                        {s.variants[0]?.text ?? '—'}
                      </span>
                      {s.variantCount > 1 && (
                        <span className="text-xs text-muted-foreground">{s.variantCount} variants</span>
                      )}
                    </TableCell>
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
          {catalogue.isPending ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : catalogue.isError ? (
            <p className="text-destructive">{catalogue.error.message}</p>
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
                {catalogue.data.items.map((m) => (
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
    </div>
  );
}

function NoData() {
  return (
    <p className="text-muted-foreground">
      No data in this range. Connect an account on{' '}
      <Link to="/accounts" className="underline">
        Accounts
      </Link>
      , claim it and run the analytics backfill for these days (docs/analytics-backfill.md).
    </p>
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
