import type { Usage, UsageGroupBy } from '@api/contracts';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useMemo } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { usageQuery } from '@/lib/api';
import { formatBytes } from '@/lib/utils';

const RANGE_DAYS = { '24h': 1, '7d': 7, '30d': 30 } as const;
type Range = keyof typeof RANGE_DAYS;
const RANGES = Object.keys(RANGE_DAYS) as Range[];
const GROUPS: UsageGroupBy[] = ['day', 'key', 'account', 'endpoint'];

export const Route = createFileRoute('/_app/usage')({
  validateSearch: (s: Record<string, unknown>): { range?: Range; groupBy?: UsageGroupBy } => ({
    range: RANGES.find((r) => r === s.range),
    groupBy: GROUPS.find((g) => g === s.groupBy),
  }),
  component: UsagePage,
});

type Row = Usage['rows'][number];

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const errorRate = (r: Row) => (r.requests ? r.errors / r.requests : 0);

function UsagePage() {
  const { range = '7d', groupBy = 'day' } = Route.useSearch();
  const navigate = Route.useNavigate();
  // Pinned per range so the query key stays stable across renders.
  const span = useMemo(() => {
    const to = new Date();
    return { from: new Date(to.getTime() - RANGE_DAYS[range] * 86_400_000).toISOString(), to: to.toISOString() };
  }, [range]);
  const usage = useQuery(usageQuery({ ...span, groupBy }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Usage</h1>
        <Segmented
          options={RANGES}
          value={range}
          onChange={(range) => navigate({ search: (prev) => ({ ...prev, range }) })}
        />
      </div>

      {usage.isPending ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : usage.isError ? (
        <p className="text-destructive">{usage.error.message}</p>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Requests per day (UTC)</CardTitle>
            </CardHeader>
            <CardContent>
              <UsageChart series={usage.data.series} />
            </CardContent>
          </Card>

          <div className="flex items-center justify-between gap-4">
            <Segmented
              options={GROUPS}
              value={groupBy}
              onChange={(groupBy) => navigate({ search: (prev) => ({ ...prev, groupBy }) })}
            />
            <Button
              variant="outline"
              disabled={usage.data.rows.length === 0}
              onClick={() => exportCsv(usage.data.rows, `usage-${range}-by-${groupBy}.csv`)}
            >
              Export CSV
            </Button>
          </div>

          {usage.data.rows.length === 0 ? (
            <p className="text-muted-foreground">No requests in this range.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="capitalize">{groupBy}</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                  <TableHead className="text-right">Errors</TableHead>
                  <TableHead className="text-right">Error %</TableHead>
                  <TableHead className="text-right">Avg ms</TableHead>
                  <TableHead className="text-right">Bytes</TableHead>
                  <TableHead className="text-right">Share</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {usage.data.rows.map((r) => (
                  <TableRow key={r.key}>
                    <TableCell className="font-medium">{r.label || '—'}</TableCell>
                    <TableCell className="text-right">{r.requests.toLocaleString()}</TableCell>
                    <TableCell className="text-right">{r.errors.toLocaleString()}</TableCell>
                    <TableCell className="text-right">{pct(errorRate(r))}</TableCell>
                    <TableCell className="text-right">{Math.round(r.avgMs)}</TableCell>
                    <TableCell className="text-right">{formatBytes(r.bytes)}</TableCell>
                    <TableCell className="text-right">{pct(r.share)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </>
      )}
    </div>
  );
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex gap-1">
      {options.map((o) => (
        <Button
          key={o}
          size="sm"
          variant={o === value ? 'default' : 'ghost'}
          aria-pressed={o === value}
          className="capitalize"
          onClick={() => onChange(o)}
        >
          {o}
        </Button>
      ))}
    </div>
  );
}

const tick = { fill: 'var(--muted-foreground)', fontSize: 12 };

function UsageChart({ series }: { series: Usage['series'] }) {
  const data = series.map((d) => ({ day: d.day, ok: d.requests - d.errors, errors: d.errors }));
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis dataKey="day" tick={tick} tickLine={false} axisLine={false} tickFormatter={(d: string) => d.slice(5)} />
        <YAxis tick={tick} tickLine={false} axisLine={false} allowDecimals={false} width={40} />
        <Tooltip
          cursor={{ fill: 'var(--muted)' }}
          contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}
        />
        <Bar dataKey="ok" name="OK" stackId="requests" fill="var(--chart-2)" />
        <Bar dataKey="errors" name="Errors" stackId="requests" fill="var(--destructive)" />
      </BarChart>
    </ResponsiveContainer>
  );
}

function exportCsv(rows: Row[], filename: string) {
  const cell = (v: string | number) => `"${String(v).replaceAll('"', '""')}"`;
  const lines = [
    ['key', 'label', 'requests', 'errors', 'error_rate', 'avg_ms', 'bytes', 'share'],
    ...rows.map((r) => [r.key, r.label, r.requests, r.errors, errorRate(r), Math.round(r.avgMs), r.bytes, r.share]),
  ].map((row) => row.map(cell).join(','));
  const url = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url));
}
