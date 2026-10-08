import type { StatsBackfillRun } from '@api/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { LoaderCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { SessionExpiredBadge } from '@/features/accounts/status-badge';
import { api, statsBackfillQuery } from '@/lib/api';

const DAYS = 30;
type BusyRun = Exclude<StatsBackfillRun, { status: 'idle' }> & { status: 'queued' | 'running' };
const busy = (run: StatsBackfillRun | undefined): run is BusyRun => run?.status === 'queued' || run?.status === 'running';
const retries = (n: number) => (n > 0 ? ` · ${n} ${n === 1 ? 'retry' : 'retries'}` : '');

/** Claims the account for this workspace and backfills its last 30 days in the background, polling every 3 s while it runs. */
export function RunAnalytics({ accountId }: { accountId: number }) {
  const queryClient = useQueryClient();
  const query = statsBackfillQuery(accountId);
  const run = useQuery({ ...query, refetchInterval: (q) => (busy(q.state.data) ? 3000 : false) });
  const start = useMutation({
    mutationFn: () => api<{ runId: string }>('/v1/stats/backfill', { method: 'POST', body: { accountId, days: DAYS } }),
    onSuccess: () => {
      toast.success(`Analytics run started for account ${accountId}`);
      return queryClient.invalidateQueries({ queryKey: query.queryKey });
    },
    onError: (e) => toast.error(e.message),
  });
  const data = run.data;

  if (busy(data)) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" />
        {data.status === 'queued' ? 'Queued…' : `Running… ${data.chats} chats, ${data.messages} messages`}
      </span>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Button size="sm" variant="outline" disabled={start.isPending || run.isPending} onClick={() => start.mutate()}>
        {start.isPending && <LoaderCircle className="animate-spin" />}
        Run analytics ({DAYS} days)
      </Button>
      {data?.status === 'done' && (
        <span className="text-muted-foreground">
          Done{retries(data.retries)} ·{' '}
          <Link to="/stats" search={{ accountId }} className="text-foreground underline">
            view Stats
          </Link>
        </span>
      )}
      {data?.status === 'error' && data.errorCode === 'session_expired' && <SessionExpiredBadge title={data.error ?? undefined} />}
      {data?.status === 'error' && data.errorCode !== 'session_expired' && (
        <span className="text-destructive">
          {data.error}
          {retries(data.retries)}
        </span>
      )}
    </div>
  );
}
