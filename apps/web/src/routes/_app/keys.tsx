import type { ApiKey, CreateKeyBody, CreatedKey, KeyScope } from '@api/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { MoreHorizontal } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { accountsQuery, api, keysQuery } from '@/lib/api';

export const Route = createFileRoute('/_app/keys')({ component: Keys });

/** `null` = closed, `'new'` = create form, an ApiKey = edit form for that key. */
type FormTarget = ApiKey | 'new' | null;

function Keys() {
  const keys = useQuery(keysQuery);
  const queryClient = useQueryClient();
  const [formTarget, setFormTarget] = useState<FormTarget>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);

  const revoke = useMutation({
    mutationFn: (id: string) => api<void>(`/api/keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Key revoked');
      return queryClient.invalidateQueries({ queryKey: keysQuery.queryKey });
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">API keys</h1>
        <Button onClick={() => setFormTarget('new')}>Create key</Button>
      </div>

      {keys.isPending ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : keys.isError ? (
        <p className="text-destructive">{keys.error.message}</p>
      ) : keys.data.items.length === 0 ? (
        <p className="text-muted-foreground">No keys yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Key</TableHead>
              <TableHead>Scope</TableHead>
              <TableHead>Accounts</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.data.items.map((k) => (
              <TableRow key={k.id} className={k.revokedAt ? 'opacity-50' : undefined}>
                <TableCell className="font-medium">{k.name}</TableCell>
                <TableCell className="font-mono">{k.start}…</TableCell>
                <TableCell>
                  <Badge variant="outline">{k.scope}</Badge>
                </TableCell>
                <TableCell>{k.allowedAccountIds ? k.allowedAccountIds.join(', ') : 'All'}</TableCell>
                <TableCell>{formatDate(k.createdAt)}</TableCell>
                <TableCell>{k.lastUsedAt ? formatDate(k.lastUsedAt) : 'Never'}</TableCell>
                <TableCell>
                  {k.revokedAt ? <Badge variant="secondary">revoked</Badge> : <Badge>active</Badge>}
                </TableCell>
                <TableCell>
                  {!k.revokedAt && (
                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" aria-label={`Actions for ${k.name}`}>
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setFormTarget(k)}>Edit</DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onSelect={() => setRevoking(k)}>
                          Revoke
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {formTarget && (
        <KeyFormDialog
          key={formTarget === 'new' ? 'new' : formTarget.id}
          editing={formTarget === 'new' ? null : formTarget}
          onClose={() => setFormTarget(null)}
          onCreated={setSecret}
        />
      )}

      <Dialog open={secret !== null} onOpenChange={(open) => !open && setSecret(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Your new API key</DialogTitle>
            <DialogDescription>Copy it now. It won't be shown again.</DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <Input readOnly value={secret ?? ''} className="font-mono" onFocus={(e) => e.target.select()} />
            <Button
              onClick={() =>
                navigator.clipboard.writeText(secret ?? '').then(
                  () => toast.success('Copied'),
                  () => toast.error('Copy failed; select the key and copy it manually'),
                )
              }
            >
              Copy
            </Button>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSecret(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={revoking !== null} onOpenChange={(open) => !open && setRevoking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke "{revoking?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              Requests using this key will be rejected immediately. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => revoking && revoke.mutate(revoking.id)}>
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function KeyFormDialog({
  editing,
  onClose,
  onCreated,
}: {
  editing: ApiKey | null;
  onClose: () => void;
  onCreated: (secret: string) => void;
}) {
  const queryClient = useQueryClient();
  const accounts = useQuery(accountsQuery);
  const [name, setName] = useState(editing?.name ?? '');
  const [scope, setScope] = useState<KeyScope>(editing?.scope ?? 'read');
  const [accountIds, setAccountIds] = useState(editing?.allowedAccountIds?.join(', ') ?? '');

  const save = useMutation({
    mutationFn: async (body: CreateKeyBody) => {
      if (editing) {
        await api(`/api/keys/${editing.id}`, { method: 'PATCH', body });
        return null;
      }
      return (await api<CreatedKey>('/api/keys', { method: 'POST', body })).secret;
    },
    // The secret is shown once: show it before the list refetch, and don't keep it in the mutation cache afterwards.
    gcTime: 0,
    onSuccess: (secret) => {
      onClose();
      if (secret) onCreated(secret);
      else toast.success('Key updated');
      void queryClient.invalidateQueries({ queryKey: keysQuery.queryKey });
    },
    onError: (e) => toast.error(e.message),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const allowedAccountIds = parseAccountIds(accountIds);
    if (allowedAccountIds === undefined) {
      toast.error('Account IDs must be positive whole numbers separated by commas');
      return;
    }
    save.mutate({ name: name.trim(), scope, allowedAccountIds });
  }

  const available = accounts.data?.items ?? [];

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={onSubmit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit key' : 'Create key'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="key-name">Name</Label>
            <Input id="key-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required />
          </div>
          <div className="space-y-2">
            <Label htmlFor="key-scope">Scope</Label>
            <Select value={scope} onValueChange={(v) => setScope(v as KeyScope)}>
              <SelectTrigger id="key-scope" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="read">read</SelectItem>
                <SelectItem value="write">write</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="key-accounts">Allowed account IDs</Label>
            <Input
              id="key-accounts"
              value={accountIds}
              onChange={(e) => setAccountIds(e.target.value)}
              placeholder="All accounts"
            />
            <p className="text-xs text-muted-foreground">
              Comma-separated, e.g. 12, 34. Leave empty to allow all accounts.
              {available.length > 0 &&
                ` Available: ${available.map((a) => `${a.id} (${a.label ?? a.username ?? 'unnamed'})`).join(', ')}.`}
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {editing ? 'Save' : 'Create key'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Empty → null (all accounts); invalid → undefined. */
function parseAccountIds(text: string): number[] | null | undefined {
  const parts = text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const ids = parts.map(Number);
  return ids.every((n) => Number.isInteger(n) && n > 0) ? ids : undefined;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString();
}
