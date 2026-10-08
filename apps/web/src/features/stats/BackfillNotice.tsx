import type { StatsBackfillRun } from '@api/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { statsBackfillQuery } from '@/lib/api';

const busy = (run: StatsBackfillRun | undefined) => run?.status === 'queued' || run?.status === 'running';

/**
 * The selected account's analytics backfill: a spinner while it is queued or running (polled every 3 s), its error when
 * it failed, nothing otherwise. Stats queries refetch when a run seen in progress ends, so the cards fill in by themselves.
 */
export function BackfillNotice({ accountId }: { accountId: number }) {
  const queryClient = useQueryClient();
  const run = useQuery({ ...statsBackfillQuery(accountId), refetchInterval: (q) => (busy(q.state.data) ? 3000 : false) });
  const data = run.data;
  const wasBusy = useRef(false);
  useEffect(() => {
    if (busy(data)) wasBusy.current = true;
    else if (wasBusy.current) {
      wasBusy.current = false;
      void queryClient.invalidateQueries({ queryKey: ['stats'] });
    }
  }, [data, queryClient]);

  if (!data || data.status === 'idle' || data.status === 'done') return null;
  if (data.status === 'error') return <p className="text-xs text-destructive">Analytics backfill failed: {data.error}</p>;
  return (
    <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <LoaderCircle className="size-3 animate-spin" />
      {data.status === 'queued'
        ? 'Analytics backfill queued'
        : `Analytics backfill running: ${data.requests} requests, ${data.chats} chats, ${data.messages} messages so far`}
      {' · stats fill in when it finishes'}
    </p>
  );
}
