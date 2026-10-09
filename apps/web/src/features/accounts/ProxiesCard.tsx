import type { Account, CreateProxyBody, ProxyInfo } from '@api/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatAgo } from '@/features/stats/series';
import { api, proxiesQuery } from '@/lib/api';

/** The last transport error is newer than the last response through the proxy (or it never answered). */
const failing = (p: ProxyInfo) =>
  p.stats.lastErrorAt !== null && (p.stats.lastOkAt === null || Date.parse(p.stats.lastErrorAt) > Date.parse(p.stats.lastOkAt));
/** Rows that need attention: failing traffic, or the last Test could not reach onlyfans.com. */
const attention = (p: ProxyInfo) => failing(p) || p.ofReachable === false;

const ago = (iso: string | null) => (iso ? <span title={new Date(iso).toLocaleString()}>{formatAgo(iso)}</span> : '—');

/** The upstream's proxies: endpoint (never credentials), bound accounts, last probed egress and traffic counters. */
export function ProxiesCard({ accounts }: { accounts: Account[] }) {
  const queryClient = useQueryClient();
  const proxies = useQuery(proxiesQuery);
  const [adding, setAdding] = useState(false);
  const probe = useMutation({
    mutationFn: (label: string) => api<{ proxy: ProxyInfo }>(`/api/proxies/${encodeURIComponent(label)}/probe`, { method: 'POST' }),
    onSuccess: ({ proxy }) => {
      const egress = `${proxy.label}: Egress ${proxy.verifiedIp ?? 'unknown'}${proxy.verifiedGeo ? ` (${proxy.verifiedGeo})` : ''}`;
      if (proxy.ofReachable === false) toast.error(`${egress}. OF blocked: ${proxy.ofError ?? 'unknown error'}`);
      else toast.success(proxy.ofReachable ? `${egress}, OF reachable` : egress);
    },
    onError: (e, label) => toast.error(`${label}: ${e.message}`),
    onSettled: () => queryClient.invalidateQueries({ queryKey: proxiesQuery.queryKey }),
  });
  const name = (id: number) => {
    const a = accounts.find((x) => x.id === id);
    return a?.username ? `@${a.username}` : (a?.label ?? String(id));
  };
  const since = proxies.data?.items[0]?.since;
  // Failing or OF-blocked proxies first; otherwise the upstream's order (the sort is stable).
  const rows = [...(proxies.data?.items ?? [])].sort((a, b) => Number(attention(b)) - Number(attention(a)));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Proxies</CardTitle>
        <CardAction>
          <Button size="sm" onClick={() => setAdding(true)}>
            Add proxy
          </Button>
        </CardAction>
        <CardDescription>
          Optional if you self-host for a single account. OK counts responses through each proxy, Blocked those OnlyFans answered 403 or 429, and Failed every
          failed attempt
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
            No proxies yet. They are optional if you self-host for a single account. Add one here, when you connect an
            account, or with Edit → New proxy URL… on an account.
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
                <TableHead className="text-right">Blocked</TableHead>
                <TableHead className="text-right">Failed</TableHead>
                <TableHead>Last error</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((p) => (
                <TableRow key={p.label}>
                  <TableCell className="font-mono text-xs">
                    {p.label}
                    {failing(p) && (
                      <Badge variant="destructive" className="ml-2">
                        failing
                      </Badge>
                    )}
                  </TableCell>
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
                    {p.ofReachable === false && (
                      <Badge variant="destructive" className="mt-1 flex w-fit" title={p.ofError ?? undefined}>
                        OF blocked
                      </Badge>
                    )}
                    {p.ofReachable === true && (
                      <Badge className="mt-1 flex w-fit bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">OF ok</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{p.stats.ok}</TableCell>
                  <TableCell className="text-right tabular-nums">{p.stats.blocked}</TableCell>
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
      {/* Mounted only while open: closing it drops the proxy URL (its password) from React state. */}
      {adding && <AddProxyDialog onClose={() => setAdding(false)} />}
    </Card>
  );
}

/** Why `label` can't name a new proxy (the API's rules), or null. */
function labelProblem(label: string): string | null {
  if (label.includes('/') || label.startsWith('.')) return 'No "/" and no leading ".".';
  if (/^acct-\d+$/.test(label)) return 'acct-<id> labels are reserved for per-account proxies.';
  return null;
}

/** Register a proxy bound to no account; it then shows up in every account's Edit dialog. */
function AddProxyDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState('');
  const problem = labelProblem(label.trim());

  const create = useMutation({
    mutationFn: (body: CreateProxyBody) => api<{ proxy: ProxyInfo }>('/api/proxies', { method: 'POST', body }),
    // The variables hold the proxy password: don't keep them once the dialog is gone.
    gcTime: 0,
    onSuccess: ({ proxy }) => {
      toast.success(`Added ${proxy.label}; press Test to check it`);
      onClose();
      void queryClient.invalidateQueries({ queryKey: proxiesQuery.queryKey });
    },
    onError: (e) => toast.error(e.message),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (problem) return;
    create.mutate({ label: label.trim(), url: url.trim() });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !create.isPending && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={onSubmit} className="min-w-0 space-y-4">
          <DialogHeader>
            <DialogTitle>Add proxy</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="proxy-label">Label</Label>
            <Input
              id="proxy-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="residential-1"
              maxLength={200}
              aria-invalid={problem !== null}
              required
            />
            {problem && <p className="text-sm text-destructive">{problem}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="proxy-url">Proxy URL</Label>
            <Input
              id="proxy-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://user:pass@host:port or socks5h://…"
              className="font-mono"
              spellCheck={false}
              autoComplete="off"
              maxLength={2048}
              required
            />
            <p className="text-xs text-muted-foreground">
              Schemes: http, https, socks5, socks5h. It is added unassigned; pick it in an account's Edit dialog.
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={create.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || problem !== null}>
              {create.isPending && <LoaderCircle className="animate-spin" />}
              Add
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
