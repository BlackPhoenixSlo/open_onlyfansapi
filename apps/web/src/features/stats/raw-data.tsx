import type { StatsMetric, StatsMetricRow } from '@api/contracts';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { NoData, Skeleton } from '@/features/stats/cards';
import { downloadCsv } from '@/lib/download';
import { formatPercent, formatWait } from '@/features/stats/series';
import { type StatsRange, statsMetricPath, statsMetricQuery } from '@/lib/api';

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

/** The metric-by-day table, its CSV export, and the metric catalogue; `metric` defaults to the catalogue's first. */
export function RawData({
  metric: picked,
  onMetricChange,
  range,
  catalogue,
  catalogueError,
}: {
  metric?: string;
  onMetricChange: (metric: string) => void;
  range?: StatsRange;
  catalogue?: StatsMetric[];
  catalogueError?: string;
}) {
  const metric = picked ?? catalogue?.[0]?.id;
  const meta = catalogue?.find((m) => m.id === metric);
  const series = useQuery({
    ...statsMetricQuery(metric ?? '', { ...range, groupBy: 'day' }),
    enabled: metric !== undefined && range !== undefined,
  });
  const columns = COUNT_COLUMNS.filter(([key]) => series.data?.rows.some((r) => r[key] !== undefined));

  function exportCsv() {
    if (!metric || !range) return;
    const name = `${metric}-${series.data?.from ?? range.from}-${series.data?.to ?? range.to}-by-day.csv`;
    void downloadCsv(statsMetricPath(metric, { ...range, groupBy: 'day' }, 'csv'), name);
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
            <Select value={metric ?? ''} onValueChange={onMetricChange}>
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
            <Button variant="outline" disabled={!series.data?.rows.length} onClick={exportCsv}>
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
