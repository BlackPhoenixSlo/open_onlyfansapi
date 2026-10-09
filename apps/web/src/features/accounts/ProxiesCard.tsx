import type { Account, ProxyInfo } from '@api/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatAgo } from '@/features/stats/series';
import { api, proxiesQuery } from '@/lib/api';

const ago = (iso: string | null) => (iso ? <span title={new Date(iso).toLocaleString()}>{formatAgo(iso)}</span> : '—');

/** The upstream's proxies: endpoint (never credentials), bound accounts, last probed egress and traffic counters. */
export function ProxiesCard({ accounts }: { accounts: Account[] }) {
  const queryClient = useQueryClient();
  const proxies = useQuery(proxiesQuery);
  const probe = useMutation({
    mutationFn: (label: string) => api<{ proxy: ProxyInfo }>(`/api/proxies/${encodeURIComponent(label)}/probe`, { method: 'POST' }),
    onSuccess: ({ proxy }) =>
      toast.success(`${proxy.label}: egress ${proxy.verifiedIp ?? 'unknown'}${proxy.verifiedGeo ? ` (${proxy.verifiedGeo})` : ''}`),
    onError: (e, label) => toast.error(`${label}: ${e.message}`),
    onSettled: () => queryClient.invalidateQueries({ queryKey: proxiesQuery.queryKey }),
  });
  const name = (id: number) => {
    const a = accounts.find((x) => x.id === id);
    return a?.username ? `@${a.username}` : (a?.label ?? String(id));
  };
  const since = proxies.data?.items[0]?.since;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Proxies</CardTitle>
        <CardDescription>
          OK and Failed count OF calls made through each proxy
          {since ? ` since ${new Date(since).toLocaleString()}` : ''}; they reset when the upstream restarts. Test
          checks the proxy's egress IP.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {proxies.isPending ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : proxies.isError ? (
          <p className="text-destructive">{proxies.error.message}</p>
        ) : proxies.data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No proxies yet. Add one when you connect an account, or with Edit → New proxy URL… on an account.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Label</TableHead>
                <TableHead>Endpoint</TableHead>
                <TableHead>Accounts</TableHead>
                <TableHead>Egress</TableHead>
                <TableHead className="text-right">OK</TableHead>
                <TableHead className="text-right">Failed</TableHead>
                <TableHead>Last error</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {proxies.data.items.map((p) => (
                <TableRow key={p.label}>
                  <TableCell className="font-mono text-xs">{p.label}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {p.scheme}://{p.host}:{p.port}
                  </TableCell>
                  <TableCell>{p.assignedAccountIds.length ? p.assignedAccountIds.map(name).join(', ') : '—'}</TableCell>
                  <TableCell title={p.verifiedAt ? `Probed ${new Date(p.verifiedAt).toLocaleString()}` : undefined}>
                    {p.verifiedIp ? (
                      <>
                        <span className="font-mono text-xs">{p.verifiedIp}</span>
                        {p.verifiedGeo && <div className="text-xs text-muted-foreground">{p.verifiedGeo}</div>}
                      </>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{p.stats.ok}</TableCell>
                  <TableCell className="text-right tabular-nums">{p.stats.failed}</TableCell>
                  <TableCell className="max-w-64">
                    {p.stats.lastError ? (
                      <>
                        <div className="truncate text-xs text-destructive" title={p.stats.lastError}>
                          {p.stats.lastError}
                        </div>
                        <div className="text-xs text-muted-foreground">{ago(p.stats.lastErrorAt)}</div>
                      </>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell>{ago(p.stats.lastUsedAt)}</TableCell>
                  <TableCell>
                    <Button size="sm" variant="outline" disabled={probe.isPending} onClick={() => probe.mutate(p.label)}>
                      {probe.isPending && probe.variables === p.label && <LoaderCircle className="animate-spin" />}
                      Test
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
