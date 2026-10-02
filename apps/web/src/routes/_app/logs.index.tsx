import type { LogStatus } from '@api/contracts';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import type { FormEvent } from 'react';
import { FilterSelect } from '@/components/filter-select';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { type LogFilters, accountsQuery, keysQuery, logsQuery } from '@/lib/api';

const STATUSES: LogStatus[] = ['2xx', '4xx', '5xx', 'error'];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** Search values arrive JSON-parsed, so ids can come back as numbers. */
function str(v: unknown) {
  return v === undefined || v === null || v === '' ? undefined : String(v);
}

export const Route = createFileRoute('/_app/logs/')({
  validateSearch: (s: Record<string, unknown>): LogFilters => ({
    status: STATUSES.find((x) => x === s.status),
    keyId: str(s.keyId),
    accountId: Number(s.accountId) || undefined,
    method: str(s.method),
    endpoint: str(s.endpoint),
    q: str(s.q),
    from: str(s.from),
    to: str(s.to),
  }),
  component: Logs,
});

function Logs() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const logs = useInfiniteQuery(logsQuery(search));
  const keys = useQuery(keysQuery);
  const accounts = useQuery(accountsQuery);

  const setFilter = (patch: LogFilters) => navigate({ search: (prev) => ({ ...prev, ...patch }) });
  const filtered = Object.values(search).some((v) => v !== undefined);
  const accountName = new Map(accounts.data?.items.map((a) => [a.id, a.label ?? a.username ?? String(a.id)]));
  const items = logs.data?.pages.flatMap((p) => p.items) ?? [];

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const text = (name: string) => String(data.get(name) ?? '').trim() || undefined;
    setFilter({ endpoint: text('endpoint'), q: text('q') });
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Logs</h1>

      <div className="flex flex-wrap items-center gap-2">
        <FilterSelect
          all="All statuses"
          value={search.status}
          options={STATUSES.map((s) => ({ value: s, label: s === 'error' ? 'Any error (4xx+5xx)' : s }))}
          onChange={(v) => setFilter({ status: STATUSES.find((s) => s === v) })}
        />
        <FilterSelect
          all="All methods"
          value={search.method}
          options={METHODS.map((m) => ({ value: m, label: m }))}
          onChange={(method) => setFilter({ method })}
        />
        <FilterSelect
          all="All keys"
          value={search.keyId}
          options={(keys.data?.items ?? []).map((k) => ({ value: k.id, label: k.name }))}
          onChange={(keyId) => setFilter({ keyId })}
        />
        <FilterSelect
          all="All accounts"
          value={search.accountId === undefined ? undefined : String(search.accountId)}
          options={(accounts.data?.items ?? []).map((a) => ({ value: String(a.id), label: accountName.get(a.id) ?? String(a.id) }))}
          onChange={(v) => setFilter({ accountId: v === undefined ? undefined : Number(v) })}
        />
        <form key={`${search.endpoint}|${search.q}`} onSubmit={onSubmit} className="flex gap-2">
          <Input name="endpoint" defaultValue={search.endpoint} placeholder="Endpoint contains…" className="w-48" />
          <Input name="q" defaultValue={search.q} placeholder="Request ID or path…" className="w-48 font-mono" />
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>
        {filtered && (
          <Button variant="ghost" onClick={() => navigate({ search: {} })}>
            Clear
          </Button>
        )}
      </div>

      {logs.isPending ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : logs.isError ? (
        <p className="text-destructive">{logs.error.message}</p>
      ) : items.length === 0 ? (
        <p className="text-muted-foreground">{filtered ? 'No requests match these filters.' : 'No requests yet.'}</p>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Method</TableHead>
                <TableHead>Endpoint</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Duration</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Account</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((l) => (
                <TableRow key={l.id} className="relative">
                  <TableCell>
                    {/* Stretched link: the whole row is clickable. */}
                    <Link to="/logs/$id" params={{ id: l.id }} className="after:absolute after:inset-0">
                      {new Date(l.createdAt).toLocaleString()}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono">{l.method}</TableCell>
                  <TableCell>
                    <div className="font-mono text-xs">{l.path}</div>
                    <div className="text-xs text-muted-foreground">{l.endpoint}</div>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={l.statusCode} />
                  </TableCell>
                  <TableCell className="text-right">{l.durationMs} ms</TableCell>
                  <TableCell>{l.keyId === null ? 'Dashboard' : (l.keyName ?? l.keyId)}</TableCell>
                  <TableCell>{l.accountId === null ? '—' : (accountName.get(l.accountId) ?? l.accountId)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {logs.hasNextPage && (
            <Button variant="outline" onClick={() => logs.fetchNextPage()} disabled={logs.isFetchingNextPage}>
              {logs.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
