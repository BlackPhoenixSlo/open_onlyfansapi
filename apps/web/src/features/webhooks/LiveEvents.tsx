import type { GatewayEvent } from '@api/contracts';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { subscribe, useStreamOpen } from '@/lib/dashboard-stream';
import { cn } from '@/lib/utils';

/** Asks for the browser-notification permission the delivery toasts use when the tab is hidden; shown until answered. */
export function EnableNotificationsButton() {
  const [permission, setPermission] = useState(() => ('Notification' in window ? Notification.permission : 'denied'));
  if (permission !== 'default') return null;
  return (
    <Button variant="outline" onClick={() => void Notification.requestPermission().then(setPermission)}>
      Enable browser notifications
    </Button>
  );
}

/** The last 50 events on the dashboard stream (newest first), whether or not an endpoint gets them. Kept while the page is open. */
export function LiveEvents() {
  const [items, setItems] = useState<GatewayEvent[]>([]);
  const open = useStreamOpen();
  useEffect(
    () =>
      subscribe((frame) => {
        if (frame.event === 'event') setItems((prev) => [frame.data, ...prev].slice(0, 50));
      }),
    [],
  );
  const emitTest = useMutation({
    mutationFn: () => api('/api/webhooks/stream/test', { method: 'POST' }),
    onError: (e) => toast.error(e.message),
  });

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
          <Button variant="ghost" size="sm" onClick={() => setItems([])} disabled={items.length === 0}>
            Clear
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-xs text-muted-foreground">No events since this page opened.</p>
        ) : (
          <ul className="divide-y text-xs">
            {items.map((e) => (
              <li key={e.id}>
                <details>
                  <summary className="flex cursor-pointer gap-4 py-1.5">
                    <span className="w-20 shrink-0 text-muted-foreground tabular-nums">{new Date(e.ts).toLocaleTimeString()}</span>
                    <span className="min-w-0 flex-1 truncate font-mono">{e.type}</span>
                    <span className="shrink-0 text-muted-foreground">{e.accountId === null ? '—' : `account ${e.accountId}`}</span>
                  </summary>
                  <pre className="mb-2 max-h-64 overflow-auto rounded-md bg-muted p-2">{JSON.stringify(e.data, null, 2)}</pre>
                </details>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
