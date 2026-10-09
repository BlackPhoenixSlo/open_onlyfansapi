import type { StatsBackfillRun } from '@api/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SessionExpiredBadge } from '@/features/accounts/status-badge';
import { api, statsBackfillQuery } from '@/lib/api';

/** The ranges offered, in days back from now; the API takes 1 to 366. */
const DAYS = [30, 90, 180] as const;
type Days = (typeof DAYS)[number];
type BusyRun = Exclude<StatsBackfillRun, { status: 'idle' }> & { status: 'queued' | 'running' };
const busy = (run: StatsBackfillRun | undefined): run is BusyRun => run?.status === 'queued' || run?.status === 'running';
const retries = (n: number) => (n > 0 ? ` · ${n} ${n === 1 ? 'retry' : 'retries'}` : '');
const failed = (n: number) => (n > 0 ? ` · ${n} ${n === 1 ? 'chat' : 'chats'} failed` : '');

/** Claims the account for this workspace and backfills its last 30, 90 or 180 days in the background, polling every 3 s while it runs. */
export function RunAnalytics({ accountId }: { accountId: number }) {
  const queryClient = useQueryClient();
  const [days, setDays] = useState<Days>(DAYS[0]);
  const query = statsBackfillQuery(accountId);
  const run = useQuery({ ...query, refetchInterval: (q) => (busy(q.state.data) ? 3000 : false) });
  const start = useMutation({
    mutationFn: (n: Days) => api<{ runId: string }>('/v1/stats/backfill', { method: 'POST', body: { accountId, days: n } }),
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
    <div className="space-y-1 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={String(days)} onValueChange={(v) => setDays(Number(v) as Days)} disabled={start.isPending}>
          <SelectTrigger size="sm" className="w-28" aria-label="Days to backfill">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DAYS.map((n) => (
              <SelectItem key={n} value={String(n)}>
                {n} days
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" disabled={start.isPending || run.isPending} onClick={() => start.mutate(days)}>
          {start.isPending && <LoaderCircle className="animate-spin" />}
          Run analytics ({days} days)
        </Button>
        {data?.status === 'done' && (
          <span className="text-muted-foreground">
            Done{failed(data.failedChats)}{retries(data.retries)} ·{' '}
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
      <p className="text-xs text-muted-foreground">Long ranges take hours at the per-hour request limit.</p>
    </div>
  );
}
