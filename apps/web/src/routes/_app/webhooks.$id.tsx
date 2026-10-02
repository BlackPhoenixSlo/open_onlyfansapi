import type { DeliveryStatus, WebhookDelivery } from '@api/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { Fragment, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { WebhookHealth } from '@/components/webhook-health';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ApiError, type DeliveryFilters, api, webhookDeliveriesQuery, webhookEventsQuery, webhookQuery } from '@/lib/api';

const STATUSES: DeliveryStatus[] = ['pending', 'succeeded', 'failed'];
/** Radix Select can't use '' as an item value. */
const ALL = 'all';

export const Route = createFileRoute('/_app/webhooks/$id')({ component: WebhookPage });

function WebhookPage() {
  const { id } = Route.useParams();
  const queryClient = useQueryClient();
  const endpoint = useQuery(webhookQuery(id));
  const catalogue = useQuery(webhookEventsQuery);
  const [filters, setFilters] = useState<DeliveryFilters>({});
  const deliveries = useInfiniteQuery(webhookDeliveriesQuery(id, filters));
  const [open, setOpen] = useState<WebhookDelivery | null>(null);

  const redeliver = useMutation({
    mutationFn: (d: WebhookDelivery) => api(`/v1/webhooks/${id}/deliveries/${d.id}/redeliver`, { method: 'POST' }),
    onSuccess: () => {
      toast.success(endpoint.data?.endpoint.enabled === false ? 'Queued; sent once the endpoint is enabled' : 'Redelivery queued');
      setOpen(null);
      return queryClient.invalidateQueries({ queryKey: ['webhooks', 'deliveries', id] });
    },
    onError: (e) => toast.error(e.message),
  });

  const items = deliveries.data?.pages.flatMap((p) => p.items) ?? [];
  const filtered = filters.status !== undefined || filters.event !== undefined;
  // `upstream.*` is a subscription pattern, not a delivered event type.
  const eventTypes = (catalogue.data?.items ?? []).map((e) => e.type).filter((t) => t !== 'upstream.*');

  return (
    <div className="space-y-6">
      <div>
        <Link to="/webhooks" className="text-sm text-muted-foreground hover:underline">
          ← Webhooks
        </Link>
        <h1 className="text-2xl font-semibold">Deliveries</h1>
        {endpoint.data && (
          <div className="mt-1 flex items-center gap-2">
            <span className="font-mono text-sm break-all">{endpoint.data.endpoint.url}</span>
            <WebhookHealth endpoint={endpoint.data.endpoint} />
          </div>
        )}
      </div>

      {endpoint.isError ? (
        <p className="text-destructive">
          {endpoint.error instanceof ApiError && endpoint.error.status === 404 ? 'Endpoint not found.' : endpoint.error.message}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <FilterSelect
              all="All statuses"
              value={filters.status}
              options={STATUSES}
              onChange={(v) => setFilters((f) => ({ ...f, status: STATUSES.find((s) => s === v) }))}
            />
            <FilterSelect
              all="All events"
              value={filters.event}
              options={eventTypes}
              onChange={(event) => setFilters((f) => ({ ...f, event }))}
            />
            {filtered && (
              <Button variant="ghost" onClick={() => setFilters({})}>
                Clear
              </Button>
            )}
          </div>

          {deliveries.isPending ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : deliveries.isError ? (
            <p className="text-destructive">{deliveries.error.message}</p>
          ) : items.length === 0 ? (
            <p className="text-muted-foreground">{filtered ? 'No deliveries match these filters.' : 'No deliveries yet.'}</p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Event</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Attempts</TableHead>
                    <TableHead>Last response</TableHead>
                    <TableHead className="w-48" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((d) => (
                    <TableRow key={d.id}>
                      <TableCell>{new Date(d.createdAt).toLocaleString()}</TableCell>
                      <TableCell className="font-mono text-xs">{d.eventType}</TableCell>
                      <TableCell>
                        <DeliveryBadge status={d.status} />
                      </TableCell>
                      <TableCell className="text-right">{d.attempts}</TableCell>
                      <TableCell className="max-w-xs truncate text-xs" title={d.lastError ?? undefined}>
                        {lastResponse(d)}
                      </TableCell>
                      <TableCell className="space-x-2 text-right">
                        <Button variant="outline" size="sm" onClick={() => setOpen(d)}>
                          Payload
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => redeliver.mutate(d)} disabled={redeliver.isPending}>
                          Redeliver
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {deliveries.hasNextPage && (
                <Button
                  variant="outline"
                  onClick={() => deliveries.fetchNextPage()}
                  disabled={deliveries.isFetchingNextPage}
                >
                  {deliveries.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </Button>
              )}
            </>
          )}
        </>
      )}

      <Dialog open={open !== null} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Delivery</DialogTitle>
          </DialogHeader>
          {open && (
            <div className="min-w-0 space-y-4">
              <Pairs
                rows={[
                  ['ID', <span className="font-mono break-all">{open.id}</span>],
                  ['Event', <span className="font-mono">{open.eventType}</span>],
                  ['Status', <DeliveryBadge status={open.status} />],
                  ['Attempts', open.attempts],
                  ['Last response', lastResponse(open)],
                  ['Last attempt', open.lastAttemptAt ? new Date(open.lastAttemptAt).toLocaleString() : '—'],
                  ['Next attempt', open.status === 'pending' ? new Date(open.nextAttemptAt).toLocaleString() : '—'],
                  ['Account', open.accountId ?? '—'],
                  ['Replay of', open.replayOf ? <span className="font-mono">{open.replayOf}</span> : '—'],
                ]}
              />
              <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs">
                {JSON.stringify(open.payload, null, 2)}
              </pre>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(null)}>
              Close
            </Button>
            <Button onClick={() => open && redeliver.mutate(open)} disabled={redeliver.isPending}>
              Redeliver
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function lastResponse(d: WebhookDelivery) {
  if (d.lastStatusCode !== null) return `HTTP ${d.lastStatusCode}`;
  return d.lastError ?? '—';
}

function DeliveryBadge({ status }: { status: DeliveryStatus }) {
  if (status === 'failed') return <Badge variant="destructive">failed</Badge>;
  if (status === 'pending') return <Badge variant="secondary">pending</Badge>;
  return <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">succeeded</Badge>;
}

function Pairs({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-sm">
      {rows.map(([k, v]) => (
        <Fragment key={k}>
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0">{v}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function FilterSelect({
  all,
  value,
  options,
  onChange,
}: {
  all: string;
  value: string | undefined;
  options: string[];
  onChange: (value: string | undefined) => void;
}) {
  return (
    <Select value={value ?? ALL} onValueChange={(v) => onChange(v === ALL ? undefined : v)}>
      <SelectTrigger className="w-48" aria-label={all}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{all}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o} value={o}>
            {o}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
