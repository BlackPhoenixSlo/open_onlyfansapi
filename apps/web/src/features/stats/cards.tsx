import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError } from '@/lib/api';

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-muted ${className}`} />;
}

export function Unverified() {
  return (
    <Badge variant="outline" className="border-amber-500/50 text-amber-700 dark:text-amber-400" title="Not yet checked by hand; see How to read this">
      unverified
    </Badge>
  );
}

export function Kpi({
  title,
  value,
  sub,
  hint,
  loading,
  error,
  empty,
  verified,
  children,
}: {
  title: string;
  value: string;
  sub?: string;
  hint?: string;
  loading?: boolean;
  error?: string;
  empty: boolean;
  verified?: boolean;
  children: ReactNode;
}) {
  if (loading) return <Skeleton className="h-32" />;
  const blank = empty && !error;
  return (
    <div className={`flex flex-col gap-1 rounded-xl border bg-card p-4 ${blank ? 'border-dashed bg-transparent' : ''}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-muted-foreground">{title}</span>
        {verified === false && !blank && <Unverified />}
      </div>
      {error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : blank ? (
        <>
          <span className="text-3xl font-semibold text-muted-foreground">—</span>
          <span className="text-xs text-muted-foreground">No data yet. Run the backfill for this range.</span>
        </>
      ) : (
        <>
          <span className="text-3xl font-semibold tabular-nums" title={hint}>
            {value}
          </span>
          {sub && <span className="text-sm">{sub}</span>}
          <span className="text-xs leading-snug text-muted-foreground">{children}</span>
        </>
      )}
    </div>
  );
}

/** A card holding a chart or table, with the query's loading, error and empty states; the defaults fit a chart. */
export function DataCard({
  title,
  description,
  state,
  empty,
  skeletonClassName = 'h-[240px]',
  emptyContent = (
    <div className="flex h-[240px] items-center justify-center rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
      No data in this range. Run the backfill for these days.
    </div>
  ),
  children,
}: {
  title: string;
  description: string;
  state: { isPending: boolean; isError: boolean; error: Error | null };
  empty: boolean;
  skeletonClassName?: string;
  emptyContent?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {state.isPending ? (
          <Skeleton className={skeletonClassName} />
        ) : state.isError ? (
          <p className="text-destructive">{state.error?.message}</p>
        ) : empty ? (
          emptyContent
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}

export function ErrorCard({ message }: { message: string }) {
  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <CardTitle className="text-destructive">Could not load stats</CardTitle>
        <CardDescription>{message}</CardDescription>
      </CardHeader>
    </Card>
  );
}

export function NoData() {
  return (
    <div className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
      No data in this range. Connect the account in{' '}
      <Link to="/accounts" className="underline">
        Accounts
      </Link>{' '}
      and press Run analytics.
    </div>
  );
}

export function Empty({ title, children }: { title: string; children: ReactNode }) {
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

/** Whether any of `queries` failed because the workspace is not linked to its upstream team. */
export const isTeamNotLinked = (queries: { error: Error | null }[]) =>
  queries.some((q) => q.error instanceof ApiError && q.error.code === 'team_not_linked');

/** A stats page for a workspace not linked to its upstream team; the page shows `subject`, e.g. "each fan's messages". */
export function WorkspaceNotLinked({ title, subject }: { title: string; subject: string }) {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <Empty title="Workspace not linked">
        This page shows {subject} from what the analytics backfill stored for this workspace. Link the workspace (
        <code className="rounded bg-muted px-1 py-0.5">pnpm --filter @gateway/api link-team &lt;slug&gt;</code>
        ), then connect the account in{' '}
        <Link to="/accounts" className="underline">
          Accounts
        </Link>{' '}
        and press Run analytics.
      </Empty>
    </div>
  );
}
