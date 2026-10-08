import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { NoData, Skeleton } from '@/features/stats/cards';
import { type StatsRange, statsFansQuery, statsMessagesCsvPath } from '@/lib/api';

/** Saves a CSV from the API as `filename`. A plain link would not send `x-dashboard`, so the session would not authorise it. */
export async function downloadCsv(path: string, filename: string) {
  const res = await fetch(path, { headers: { 'x-dashboard': '1' }, credentials: 'include' });
  if (!res.ok) {
    toast.error(`CSV export failed (${res.status})`);
    return;
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url));
}

/** The fans with messages in the range, latest first, and their stored messages as CSV. */
export function FansCard({ range }: { range?: StatsRange }) {
  const fans = useQuery({ ...statsFansQuery(range ?? {}), enabled: range !== undefined });
  const span = `${fans.data?.from ?? range?.from}-${fans.data?.to ?? range?.to}`;
  const download = (direction: 'in' | 'all', name: string, scope: { accountId?: number; chatId?: number } = {}) =>
    void downloadCsv(statsMessagesCsvPath({ ...range, ...scope, direction }), `${name}-${span}.csv`);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Fans</CardTitle>
        <CardDescription>
          Every message is stored per fan in full. The downloads hold every message in the range for the account filter.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" disabled={!fans.data?.items.length} onClick={() => download('in', 'fan-replies')}>
            Download fan replies (CSV)
          </Button>
          <Button variant="outline" disabled={!fans.data?.items.length} onClick={() => download('all', 'messages')}>
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fan</TableHead>
                <TableHead className="text-right">Fan msgs</TableHead>
                <TableHead className="text-right">Creator msgs</TableHead>
                <TableHead>Last message</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {fans.data.items.map((f) => (
                <TableRow key={`${f.accountId}:${f.chatId}`}>
                  <TableCell className="font-medium">{f.fanUsername ? `@${f.fanUsername}` : f.chatId}</TableCell>
                  <TableCell className="text-right">{f.fanMessages}</TableCell>
                  <TableCell className="text-right">{f.creatorMessages}</TableCell>
                  <TableCell>{new Date(f.lastAt).toLocaleString()}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => download('all', `messages-${f.fanUsername ?? f.chatId}`, { accountId: f.accountId, chatId: f.chatId })}
                    >
                      CSV
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
