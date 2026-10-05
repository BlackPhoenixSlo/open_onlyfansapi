import type { CreateWebhookBody, WebhookEndpoint, WebhookEventInfo, WebhookEventType } from '@api/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { MoreHorizontal } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { WebhookHealth } from '@/components/webhook-health';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EnableNotificationsButton, LiveEvents } from '@/features/webhooks/LiveEvents';
import { api, webhookEventsQuery, webhooksQuery } from '@/lib/api';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/_app/webhooks/')({ component: Webhooks });

/** `null` = closed, `'new'` = create form, an endpoint = edit form for it. */
type FormTarget = WebhookEndpoint | 'new' | null;

function Webhooks() {
  const webhooks = useQuery(webhooksQuery);
  const queryClient = useQueryClient();
  const [formTarget, setFormTarget] = useState<FormTarget>(null);
  const [deleting, setDeleting] = useState<WebhookEndpoint | null>(null);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: webhooksQuery.queryKey }),
      queryClient.invalidateQueries({ queryKey: ['overview'] }),
    ]);

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api(`/v1/webhooks/${id}`, { method: 'PATCH', body: { enabled } }),
    onSuccess: (_, { enabled }) => {
      toast.success(enabled ? 'Endpoint enabled' : 'Endpoint paused');
      return refresh();
    },
    onError: (e) => toast.error(e.message),
  });

  const sendTest = useMutation({
    mutationFn: (endpoint: WebhookEndpoint) => api(`/v1/webhooks/${endpoint.id}/test`, { method: 'POST' }),
    onSuccess: (_, endpoint) =>
      toast.success(endpoint.enabled ? 'Test event queued' : 'Test event queued; it is sent once the endpoint is enabled'),
    onError: (e) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api<void>(`/v1/webhooks/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Endpoint deleted');
      return refresh();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Webhooks</h1>
        <div className="flex gap-2">
          <EnableNotificationsButton />
          <Button onClick={() => setFormTarget('new')}>Add endpoint</Button>
        </div>
      </div>

      {webhooks.isPending ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : webhooks.isError ? (
        <p className="text-destructive">{webhooks.error.message}</p>
      ) : webhooks.data.items.length === 0 ? (
        <p className="text-muted-foreground">No endpoints yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>URL</TableHead>
              <TableHead>Events</TableHead>
              <TableHead className="w-36 min-w-36">Health</TableHead>
              <TableHead>Enabled</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {webhooks.data.items.map((w) => (
              <TableRow key={w.id}>
                <TableCell className="max-w-md">
                  <Link to="/webhooks/$id" params={{ id: w.id }} className="font-mono text-xs break-all hover:underline">
                    {w.url}
                  </Link>
                  {w.description && <div className="text-xs text-muted-foreground">{w.description}</div>}
                </TableCell>
                <TableCell className="text-xs" title={w.events.join(', ') || undefined}>
                  {w.events.length === 0 ? 'All events' : w.events.length <= 2 ? w.events.join(', ') : `${w.events.length} events`}
                </TableCell>
                <TableCell className="w-36 min-w-36">
                  <WebhookHealth endpoint={w} />
                </TableCell>
                <TableCell>
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    aria-label={`${w.enabled ? 'Pause' : 'Enable'} ${w.url}`}
                    checked={w.enabled}
                    disabled={toggle.isPending}
                    onChange={(e) => toggle.mutate({ id: w.id, enabled: e.target.checked })}
                  />
                </TableCell>
                <TableCell>{new Date(w.createdAt).toLocaleString()}</TableCell>
                <TableCell>
                  <DropdownMenu modal={false}>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label={`Actions for ${w.url}`}>
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => setFormTarget(w)}>Edit</DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => sendTest.mutate(w)}>Send test event</DropdownMenuItem>
                      <DropdownMenuItem asChild>
                        <Link to="/webhooks/$id" params={{ id: w.id }}>
                          Deliveries
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(w)}>
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <LiveEvents />

      {formTarget && (
        <EndpointFormDialog
          key={formTarget === 'new' ? 'new' : formTarget.id}
          editing={formTarget === 'new' ? null : formTarget}
          onClose={() => setFormTarget(null)}
          onCreated={setFormTarget}
          refresh={refresh}
        />
      )}

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this endpoint?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-mono break-all">{deleting?.url}</span> and its deliveries will be deleted. This
              can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => deleting && remove.mutate(deleting.id)}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function EndpointFormDialog({
  editing,
  onClose,
  onCreated,
  refresh,
}: {
  editing: WebhookEndpoint | null;
  onClose: () => void;
  /** Reopens the dialog on the new endpoint, so its secret can be revealed. */
  onCreated: (endpoint: WebhookEndpoint) => void;
  /** Refetches the endpoint list and the Home overview. */
  refresh: () => Promise<unknown>;
}) {
  const catalogue = useQuery(webhookEventsQuery);
  const [url, setUrl] = useState(editing?.url ?? '');
  const [description, setDescription] = useState(editing?.description ?? '');
  // Stored endpoints only hold catalogue types (the API validates them on write).
  const [events, setEvents] = useState<WebhookEventType[]>((editing?.events ?? []) as WebhookEventType[]);
  const [revealed, setRevealed] = useState(false);

  const save = useMutation({
    mutationFn: async (body: CreateWebhookBody) => {
      if (editing) {
        await api(`/v1/webhooks/${editing.id}`, { method: 'PATCH', body });
        return null;
      }
      return (await api<{ endpoint: WebhookEndpoint }>('/v1/webhooks', { method: 'POST', body })).endpoint;
    },
    onSuccess: (created) => {
      if (created) {
        toast.success('Endpoint created');
        onCreated(created);
      } else {
        toast.success('Endpoint updated');
        onClose();
      }
      void refresh();
    },
    onError: (e) => toast.error(e.message),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    save.mutate({ url: url.trim(), description: description.trim() || null, events });
  }

  const toggleEvents = (types: WebhookEventType[], on: boolean) =>
    setEvents((prev) => (on ? [...new Set([...prev, ...types])] : prev.filter((t) => !types.includes(t))));
  // Catalogue order, grouped by the type's prefix (`messages.received` → `messages`).
  const groups = new Map<string, WebhookEventInfo[]>();
  for (const ev of catalogue.data?.items ?? []) {
    const prefix = ev.type.split('.')[0]!;
    groups.set(prefix, [...(groups.get(prefix) ?? []), ev]);
  }
  const secret = editing?.secret;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-5xl">
        <form onSubmit={onSubmit} className="min-w-0 space-y-4">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit endpoint' : 'Add endpoint'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="webhook-url">URL</Label>
            <Input
              id="webhook-url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/webhooks"
              maxLength={2048}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="webhook-description">Description</Label>
            <Input
              id="webhook-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
            />
          </div>
          <fieldset className="min-w-0 space-y-2">
            <legend className="text-sm font-medium">Events</legend>
            <div className="columns-2 gap-5 sm:columns-3 lg:columns-4">
              {[...groups].map(([prefix, items]) => {
                const types = items.map((ev) => ev.type);
                const selected = types.filter((t) => events.includes(t)).length;
                return (
                  <div key={prefix} role="group" aria-label={`${prefix} events`} className="mb-3 break-inside-avoid">
                    <label className="flex items-center gap-1.5 text-xs font-medium">
                      <input
                        type="checkbox"
                        className="size-3.5 accent-primary"
                        aria-label={`All ${prefix} events`}
                        checked={selected === types.length}
                        ref={(el) => {
                          if (el) el.indeterminate = selected > 0 && selected < types.length;
                        }}
                        onChange={(e) => toggleEvents(types, e.target.checked)}
                      />
                      <span className="font-mono">{prefix}</span>
                    </label>
                    {items.map((ev) => {
                      // TBC = known OF source, not mapped yet; never = no source in a self-hosted gateway.
                      const pending = ev.status === 'emitted' ? null : ev.status === 'tbc' ? 'TBC' : 'never';
                      return (
                        <label
                          key={ev.type}
                          title={`${ev.type}: ${ev.description}`}
                          className={cn('flex items-center gap-1.5 py-px pl-4 text-xs', pending && 'text-muted-foreground opacity-70')}
                        >
                          <input
                            type="checkbox"
                            className="size-3.5 accent-primary"
                            aria-label={ev.type}
                            checked={events.includes(ev.type)}
                            onChange={(e) => toggleEvents([ev.type], e.target.checked)}
                          />
                          <span className="min-w-0 truncate font-mono">{ev.type.slice(prefix.length + 1)}</span>
                          {pending && <span className="shrink-0 text-[10px] uppercase">{pending}</span>}
                        </label>
                      );
                    })}
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">
              None selected means every event. Muted events are not emitted yet (TBC) or never by this gateway; hover for
              details.
            </p>
          </fieldset>
          {secret && (
            <div className="space-y-2">
              <Label htmlFor="webhook-secret">Signing secret</Label>
              <div className="flex gap-2">
                <Input
                  id="webhook-secret"
                  readOnly
                  value={revealed ? secret : 'whsec_' + '•'.repeat(24)}
                  className="font-mono"
                  onFocus={(e) => revealed && e.target.select()}
                />
                <Button type="button" variant="outline" onClick={() => setRevealed((r) => !r)}>
                  {revealed ? 'Hide' : 'Reveal'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    navigator.clipboard.writeText(secret).then(
                      () => toast.success('Copied'),
                      () => toast.error('Copy failed; reveal the secret and copy it manually'),
                    )
                  }
                >
                  Copy
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">Verify the Signature header with it: hex HMAC-SHA256 of the raw body, keyed with this secret as-is.</p>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {editing ? 'Close' : 'Cancel'}
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {editing ? 'Save' : 'Add endpoint'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
