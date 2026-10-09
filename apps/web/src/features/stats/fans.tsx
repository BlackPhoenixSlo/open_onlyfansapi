import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { NoData, Skeleton } from '@/features/stats/cards';
import { type StatsRange, statsFansQuery, statsMessagesCsvPath } from '@/lib/api';
import { useCsvDownload } from '@/lib/download';
import { fanFileName, fanName, formatMoney } from '@/lib/utils';

/** The fans with messages in the range and the payers without a stored chat, most spend first, and their stored messages as CSV. */
export function FansCard({ range }: { range?: StatsRange }) {
  const fans = useQuery({ ...statsFansQuery(range ?? {}), enabled: range !== undefined });
  const csv = useCsvDownload();
  const span = `${fans.data?.from ?? range?.from}-${fans.data?.to ?? range?.to}`;
  const download = (direction: 'in' | 'all', name: string, scope: { accountId?: number; chatId?: number } = {}) =>
    csv.download(statsMessagesCsvPath({ ...range, ...scope, direction }), `${name}-${span}.csv`);
  const disabled = csv.downloading || !fans.data?.items.length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Fans</CardTitle>
        <CardDescription>
          Messages are stored per fan for the backfilled ranges and for live events received while the gateway is
          connected; media is kept as metadata only. The downloads hold every stored message in the range for the account
          filter. Most spend in the range first (booked sales), then latest fan message; payers of the range with no
          stored chat are listed too.
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
                  <TableHead className="text-right" title="Booked gross in the range">
                    Spend
                  </TableHead>
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
                    <TableCell className="font-medium">
                      {f.hasChat ? (
                        <Link
                          to="/conversations"
                          search={{ range: 'custom', from: fans.data.from, to: fans.data.to, chatAccountId: f.accountId, chatId: f.chatId }}
                          className="underline-offset-4 hover:underline"
                          title="Read the conversation"
                        >
                          {fanName(f)}
                        </Link>
                      ) : (
                        <span title="A payer of the range with no stored messages">{fanName(f)}</span>
                      )}
                      {f.isDeleted && <span className="ml-2 text-xs font-normal text-muted-foreground">deleted account</span>}
                    </TableCell>
                    <TableCell className="text-right">{f.gross ? formatMoney(f.gross) : '—'}</TableCell>
                    <TableCell className="text-right">{f.fanMessages}</TableCell>
                    <TableCell className="text-right">{f.dmMessages}</TableCell>
                    <TableCell className="text-right">{f.ppvSent ? `${f.ppvOpened}/${f.ppvSent}` : '—'}</TableCell>
                    <TableCell className="text-right">{f.tips ? `${f.tips} · ${formatMoney(f.tipCents)}` : '—'}</TableCell>
                    <TableCell>{f.lastFanAt ? new Date(f.lastFanAt).toLocaleString() : '—'}</TableCell>
                    <TableCell className="text-right">
                      {f.lastAt !== null && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={csv.downloading}
                          onClick={() => download('all', `messages-${fanFileName(f)}`, { accountId: f.accountId, chatId: f.chatId })}
                        >
                          CSV
                        </Button>
                      )}
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
