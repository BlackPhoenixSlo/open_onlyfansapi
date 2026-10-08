import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ConnectDialog } from '@/features/accounts/ConnectDialog';
import { RunAnalytics } from '@/features/accounts/RunAnalytics';
import { ApiError, accountsQuery } from '@/lib/api';

export const Route = createFileRoute('/_app/accounts')({ component: Accounts });

function Accounts() {
  const accounts = useQuery(accountsQuery);
  const [connecting, setConnecting] = useState(false);
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
                  <Badge variant="secondary">{a.status}</Badge>
                </TableCell>
                <TableCell>{a.status === 'active' && <RunAnalytics accountId={a.id} />}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
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
