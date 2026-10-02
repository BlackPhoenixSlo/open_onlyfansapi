import type { CreateWebhookBody, WebhookEndpoint, WebhookEventType } from '@api/contracts';
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
import { api, webhookEventsQuery, webhooksQuery } from '@/lib/api';

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
        <Button onClick={() => setFormTarget('new')}>Add endpoint</Button>
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
                <TableCell className="text-xs">{w.events.length === 0 ? 'All events' : w.events.join(', ')}</TableCell>
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

  const toggleEvent = (type: WebhookEventType, on: boolean) =>
    setEvents((prev) => (on ? [...prev, type] : prev.filter((t) => t !== type)));
  const secret = editing?.secret;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={onSubmit} className="space-y-4">
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
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Events</legend>
            {(catalogue.data?.items ?? []).map((ev) => (
              <label key={ev.type} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-primary"
                  checked={events.includes(ev.type)}
                  onChange={(e) => toggleEvent(ev.type, e.target.checked)}
                />
                <span>
                  <span className="font-mono">{ev.type}</span>
                  <span className="block text-xs text-muted-foreground">{ev.description}</span>
                </span>
              </label>
            ))}
            <p className="text-xs text-muted-foreground">None selected means every event.</p>
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
              <p className="text-xs text-muted-foreground">Verify the webhook-signature header with it.</p>
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
