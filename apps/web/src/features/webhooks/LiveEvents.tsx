import type { GatewayEvent } from '@api/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { accountsQuery, api, recentEventsQuery } from '@/lib/api';
import { subscribe, useStreamOpen } from '@/lib/dashboard-stream';
import { cn } from '@/lib/utils';

const MAX = 50;

/**
 * The last 50 events (newest first), whether or not an endpoint gets them: the newest ledger events on load (no
 * payload), then each event on the dashboard stream as it arrives. Kept while the page is open.
 */
export function LiveEvents() {
  const [items, setItems] = useState<GatewayEvent[]>([]);
  const [hideHistory, setHideHistory] = useState(false);
  const recent = useQuery(recentEventsQuery);
  const accounts = useQuery(accountsQuery);
  const accountName = new Map(accounts.data?.items.map((a) => [a.id, a.label ?? (a.username ? `@${a.username}` : null)]));
  const open = useStreamOpen();
  useEffect(
    () =>
      subscribe((frame) => {
        if (frame.event === 'event') setItems((prev) => [frame.data, ...prev].slice(0, MAX));
      }),
    [],
  );
  const emitTest = useMutation({
    mutationFn: () => api('/api/webhooks/stream/test', { method: 'POST' }),
    onError: (e) => toast.error(e.message),
  });
  const liveIds = new Set(items.map((e) => e.id));
  const history = hideHistory ? [] : (recent.data?.events ?? []).filter((e) => !liveIds.has(e.id));
  // Newest first: a refetch (window focus) can bring back events the stream missed, older than live ones.
  const shown = [...items, ...history].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, MAX);

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Live events
          <span className={cn('size-2 rounded-full', open ? 'bg-emerald-500' : 'bg-muted-foreground/40')} />
          <span className="text-xs font-normal text-muted-foreground">{open ? 'Listening' : 'Not connected'}</span>
        </CardTitle>
        <CardDescription>Register an endpoint to have these delivered to your server.</CardDescription>
        <CardAction className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => emitTest.mutate()} disabled={emitTest.isPending}>
            Emit test event
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setItems([]);
              setHideHistory(true);
            }}
            disabled={shown.length === 0}
          >
            Clear
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {shown.length === 0 ? (
          <p className="text-xs text-muted-foreground">{recent.isPending ? 'Loading…' : 'No events yet.'}</p>
        ) : (
          <ul className="divide-y text-xs">
            {shown.map((e) => (
              <li key={e.id}>
                <details className="group">
                  <summary className="flex cursor-pointer items-center gap-4 py-1.5 hover:bg-muted/50">
                    <ChevronRight className="size-3 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
                    <span className="w-20 shrink-0 text-muted-foreground tabular-nums">{new Date(e.ts).toLocaleTimeString()}</span>
                    <span className="min-w-0 flex-1 truncate font-mono">{e.type}</span>
                    <span className="shrink-0 text-muted-foreground" title={e.accountId === null ? undefined : `account ${e.accountId}`}>
                      {e.accountId === null ? '—' : (accountName.get(e.accountId) ?? `account ${e.accountId}`)}
                    </span>
                  </summary>
                  {liveIds.has(e.id) ? (
                    <pre className="mb-2 max-h-64 overflow-auto rounded-md bg-muted p-2">{JSON.stringify(e.data, null, 2)}</pre>
                  ) : (
                    <p className="mb-2 text-muted-foreground">Payload not stored for past events.</p>
                  )}
                </details>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
