import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ApiError, accountsQuery } from '@/lib/api';

export const Route = createFileRoute('/_app/accounts')({ component: Accounts });

const CONNECT_HINT = 'Accounts are connected through the backend app (the desktop app), not here.';

function Accounts() {
  const accounts = useQuery(accountsQuery);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Accounts</h1>
      {accounts.isPending ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : accounts.isError ? (
        accounts.error instanceof ApiError && accounts.error.code === 'team_not_linked' ? (
          <Empty title="Workspace not linked">
            {CONNECT_HINT} This workspace isn't linked to a backend user yet. A workspace admin links it with{' '}
            <code className="rounded bg-muted px-1 py-0.5">
              pnpm --filter @gateway/api link-team &lt;slug&gt; &lt;backendUserId&gt;
            </code>{' '}
            (the slug is shown in Settings).
          </Empty>
        ) : (
          <p className="text-destructive">{accounts.error.message}</p>
        )
      ) : accounts.data.items.length === 0 ? (
        <Empty title="No accounts yet">{CONNECT_HINT} Once connected there, they show up in this list.</Empty>
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
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
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
