import type { Account } from '@api/contracts';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { MoreHorizontal } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ConnectDialog } from '@/features/accounts/ConnectDialog';
import { EditAccountDialog } from '@/features/accounts/EditAccountDialog';
import { ProxiesCard } from '@/features/accounts/ProxiesCard';
import { RunAnalytics } from '@/features/accounts/RunAnalytics';
import { SessionExpiredBadge } from '@/features/accounts/status-badge';
import { ApiError, accountsQuery } from '@/lib/api';

export const Route = createFileRoute('/_app/accounts')({ component: Accounts });

function Accounts() {
  const accounts = useQuery(accountsQuery);
  const [connecting, setConnecting] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const unlinked = accounts.error instanceof ApiError && accounts.error.code === 'team_not_linked';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Accounts</h1>
        {!unlinked && <Button onClick={() => setConnecting(true)}>Connect account</Button>}
      </div>
      {accounts.isPending ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : accounts.isError ? (
        unlinked ? (
          <Empty title="Workspace not linked">
            This workspace isn't linked to the upstream yet. The operator links it with{' '}
            <code className="rounded bg-muted px-1 py-0.5">
              docker compose exec gateway node dist/db/link-team.js &lt;slug&gt;
            </code>{' '}
            (local dev:{' '}
            <code className="rounded bg-muted px-1 py-0.5">pnpm --filter @gateway/api link-team &lt;slug&gt;</code>).
            The slug is shown in Settings.
          </Empty>
        ) : (
          <p className="text-destructive">{accounts.error.message}</p>
        )
      ) : accounts.data.items.length === 0 ? (
        <Empty title="No accounts yet">Use Connect account to add an OnlyFans account; it shows up in this list.</Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12" />
              <TableHead>Display name</TableHead>
              <TableHead>Username</TableHead>
              <TableHead>Label</TableHead>
              <TableHead>ID</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Analytics</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.data.items.map((a) => (
              <TableRow key={a.id}>
                <TableCell>
                  {a.avatarUrl ? (
                    <img src={a.avatarUrl} alt="" className="size-8 rounded-full object-cover" />
                  ) : (
                    <div className="size-8 rounded-full bg-muted" />
                  )}
                </TableCell>
                <TableCell>{a.displayName ?? '—'}</TableCell>
                <TableCell>{a.username ? `@${a.username}` : '—'}</TableCell>
                <TableCell>{a.label ?? '—'}</TableCell>
                <TableCell className="font-mono">{a.id}</TableCell>
                <TableCell>
                  {a.status === 'session_expired' ? (
                    <SessionExpiredBadge title="OnlyFans refused this account's session. Use Connect account with a fresh cURL for the same account." />
                  ) : (
                    <Badge variant="secondary">{a.status}</Badge>
                  )}
                </TableCell>
                {/* Only an active account can run; a session_expired one shows no Run analytics until it is re-connected. */}
                <TableCell>{a.status === 'active' && <RunAnalytics accountId={a.id} />}</TableCell>
                <TableCell>
                  <DropdownMenu modal={false}>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label={`Actions for ${a.label ?? a.id}`}>
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => setEditing(a)}>Edit</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {accounts.isSuccess && <ProxiesCard accounts={accounts.data.items} />}
      {editing && <EditAccountDialog key={editing.id} account={editing} onClose={() => setEditing(null)} />}
      {/* Mounted only while open: closing it drops the cURL (live cookies) from React state. */}
      {connecting && <ConnectDialog onClose={() => setConnecting(false)} />}
    </div>
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
