import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { NoData, Skeleton } from '@/features/stats/cards';
import { type StatsRange, statsFansQuery, statsMessagesCsvPath } from '@/lib/api';

/** Saves a CSV from the API as `filename`. A plain link would not send `x-dashboard`, so the session would not authorise it. */
export async function downloadCsv(path: string, filename: string) {
  let blob: Blob;
  try {
    const res = await fetch(path, { headers: { 'x-dashboard': '1' }, credentials: 'include' });
    if (!res.ok) {
      toast.error(`CSV export failed (${res.status})`);
      return;
    }
    blob = await res.blob();
  } catch {
    toast.error('CSV export failed (network error)');
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url));
}

/** OF amounts are US dollars. */
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** The fans with messages in the range, latest fan message first, and their stored messages as CSV. */
export function FansCard({ range }: { range?: StatsRange }) {
  const fans = useQuery({ ...statsFansQuery(range ?? {}), enabled: range !== undefined });
  const [downloading, setDownloading] = useState(false);
  const span = `${fans.data?.from ?? range?.from}-${fans.data?.to ?? range?.to}`;
  async function download(direction: 'in' | 'all', name: string, scope: { accountId?: number; chatId?: number } = {}) {
    setDownloading(true);
    try {
      await downloadCsv(statsMessagesCsvPath({ ...range, ...scope, direction }), `${name}-${span}.csv`);
    } finally {
      setDownloading(false);
    }
  }
  const disabled = downloading || !fans.data?.items.length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Fans</CardTitle>
        <CardDescription>
          Messages are stored per fan for the backfilled ranges and for live events received while the gateway is
          connected; media is kept as metadata only. The downloads hold every stored message in the range for the account
          filter. Latest fan message first.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" disabled={disabled} onClick={() => download('in', 'fan-replies')}>
            Download fan replies (CSV)
          </Button>
          <Button variant="outline" disabled={disabled} onClick={() => download('all', 'messages')}>
            Download all messages (CSV)
          </Button>
        </div>
        {fans.isPending ? (
          <Skeleton className="h-40" />
        ) : fans.isError ? (
          <p className="text-destructive">{fans.error.message}</p>
        ) : fans.data.items.length === 0 ? (
          <NoData />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Fan</TableHead>
                  <TableHead className="text-right">Fan msgs</TableHead>
                  <TableHead className="text-right">DMs</TableHead>
                  <TableHead className="text-right" title="PPVs bought / sent (not mass)">PPV</TableHead>
                  <TableHead className="text-right">Tips</TableHead>
                  <TableHead>Last fan msg</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {fans.data.items.map((f) => (
                  <TableRow key={`${f.accountId}:${f.chatId}`}>
                    <TableCell className="font-medium">{f.fanUsername ? `@${f.fanUsername}` : f.chatId}</TableCell>
                    <TableCell className="text-right">{f.fanMessages}</TableCell>
                    <TableCell className="text-right">{f.dmMessages}</TableCell>
                    <TableCell className="text-right">{f.ppvSent ? `${f.ppvOpened}/${f.ppvSent}` : '—'}</TableCell>
                    <TableCell className="text-right">{f.tips ? `${f.tips} · ${money(f.tipCents)}` : '—'}</TableCell>
                    <TableCell>{f.lastFanAt ? new Date(f.lastFanAt).toLocaleString() : '—'}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={downloading}
                        onClick={() => download('all', `messages-${f.fanUsername ?? f.chatId}`, { accountId: f.accountId, chatId: f.chatId })}
                      >
                        CSV
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {fans.data.total > fans.data.items.length && (
              <p className="text-xs text-muted-foreground">
                Showing {fans.data.items.length} of {fans.data.total} fans.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
