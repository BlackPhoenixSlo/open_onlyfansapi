import type {
  CreatedInvite,
  CreateInviteBody,
  MemberFeature,
  MemberPermissions,
  TeamInvite,
  TeamMember,
  UpdateMemberBody,
} from '@api/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { MoreHorizontal } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { AccountIdsField, INVALID_ACCOUNT_IDS, parseAccountIds } from '@/components/account-ids-field';
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { FEATURE_LABELS, FEATURES, featureList } from '@/features/team/features';
import { accountsQuery, api, invitesQuery, teamMembersQuery } from '@/lib/api';
import { formatDate } from '@/lib/utils';

export const Route = createFileRoute('/_app/team')({ component: Team });

function Team() {
  const members = useQuery(teamMembersQuery);
  const invites = useQuery(invitesQuery);
  const queryClient = useQueryClient();
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<TeamMember | null>(null);
  const [link, setLink] = useState<CreatedInvite | null>(null);
  const [removing, setRemoving] = useState<TeamMember | null>(null);

  const createInvite = useMutation({
    mutationFn: (body: CreateInviteBody) => api<CreatedInvite>('/api/invites', { method: 'POST', body }),
    // The link is shown once: don't keep it in the mutation cache.
    gcTime: 0,
    onSuccess: (created) => {
      setInviting(false);
      setLink(created);
      return queryClient.invalidateQueries({ queryKey: invitesQuery.queryKey });
    },
    onError: (e) => toast.error(e.message),
  });

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateMemberBody }) =>
      api(`/api/team/members/${id}`, { method: 'PATCH', body }),
    onSuccess: () => {
      setEditing(null);
      toast.success('Permissions updated');
      return queryClient.invalidateQueries({ queryKey: teamMembersQuery.queryKey });
    },
    onError: (e) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api<void>(`/api/team/members/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Member removed');
      return queryClient.invalidateQueries({ queryKey: teamMembersQuery.queryKey });
    },
    onError: (e) => toast.error(e.message),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api<void>(`/api/invites/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Invite revoked');
      return queryClient.invalidateQueries({ queryKey: invitesQuery.queryKey });
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Team</h1>
        <Button onClick={() => setInviting(true)}>Create invite</Button>
      </div>

      {members.isPending ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : members.isError ? (
        <p className="text-destructive">{members.error.message}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Creators</TableHead>
              <TableHead>Features</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.data.items.map((m) => (
              <TableRow key={m.id}>
                <TableCell className="font-medium">{m.username ?? m.email ?? m.name}</TableCell>
                <TableCell>
                  <Badge variant={m.role === 'owner' ? 'default' : 'outline'}>{m.role}</Badge>
                </TableCell>
                <TableCell>{formatAccounts(m.allowedAccountIds)}</TableCell>
                <TableCell className="max-w-xs whitespace-normal">{featureList(m.features)}</TableCell>
                <TableCell>{formatDate(m.createdAt)}</TableCell>
                <TableCell>
                  {m.role === 'member' && (
                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" aria-label={`Actions for ${m.username ?? m.name}`}>
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setEditing(m)}>Edit permissions</DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onSelect={() => setRemoving(m)}>
                          Remove
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

      <div className="space-y-2">
        <h2 className="text-lg font-semibold">Pending invites</h2>
        {invites.isPending ? (
          <p className="text-muted-foreground">Loading…</p>
        ) : invites.isError ? (
          <p className="text-destructive">{invites.error.message}</p>
        ) : invites.data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No pending invites. An invite link works once, until it expires, and is shown only when you create it.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Creators</TableHead>
                <TableHead>Features</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {invites.data.items.map((inv: TeamInvite) => (
                <TableRow key={inv.id}>
                  <TableCell>{formatAccounts(inv.allowedAccountIds)}</TableCell>
                  <TableCell className="max-w-xs whitespace-normal">{featureList(inv.features)}</TableCell>
                  <TableCell>{formatDate(inv.createdAt)}</TableCell>
                  <TableCell>{formatDate(inv.expiresAt)}</TableCell>
                  <TableCell>
                    <Button variant="outline" size="sm" disabled={revoke.isPending} onClick={() => revoke.mutate(inv.id)}>
                      Revoke
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {inviting && (
        <PermissionsDialog
          title="Create invite"
          description="The link lets one person pick a username and password and join with these permissions."
          submitLabel="Create invite"
          initial={{ allowedAccountIds: null, features: [] }}
          pending={createInvite.isPending}
          onSubmit={(body) => createInvite.mutate(body)}
          onClose={() => setInviting(false)}
        />
      )}

      {editing && (
        <PermissionsDialog
          key={editing.id}
          title={`Permissions of ${editing.username ?? editing.name}`}
          submitLabel="Save"
          initial={editing}
          pending={update.isPending}
          onSubmit={(body) => update.mutate({ id: editing.id, body })}
          onClose={() => setEditing(null)}
        />
      )}

      <Dialog open={link !== null} onOpenChange={(open) => !open && setLink(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite link</DialogTitle>
            <DialogDescription>
              Send it to the person you are inviting. It works once, until {link && formatDate(link.invite.expiresAt)}, and
              won't be shown again.
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2">
            <Input readOnly value={link?.url ?? ''} className="font-mono" onFocus={(e) => e.target.select()} />
            <Button
              onClick={() =>
                navigator.clipboard.writeText(link?.url ?? '').then(
                  () => toast.success('Copied'),
                  () => toast.error('Copy failed; select the link and copy it manually'),
                )
              }
            >
              Copy
            </Button>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLink(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove "{removing?.username ?? removing?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              Their login is deleted and they are signed out at once. Their past requests stay in the logs. This can't be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => removing && remove.mutate(removing.id)}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Creators and features, for a new invite or an existing member; the caller sends them. */
function PermissionsDialog({
  title,
  description,
  submitLabel,
  initial,
  pending,
  onSubmit,
  onClose,
}: {
  title: string;
  description?: string;
  submitLabel: string;
  initial: MemberPermissions;
  pending: boolean;
  onSubmit: (permissions: MemberPermissions) => void;
  onClose: () => void;
}) {
  const accounts = useQuery(accountsQuery);
  // "All creators" is its own choice: an empty list below means none.
  const [allCreators, setAllCreators] = useState(initial.allowedAccountIds === null);
  const [accountIds, setAccountIds] = useState(initial.allowedAccountIds?.join(', ') ?? '');
  const [features, setFeatures] = useState<MemberFeature[]>(initial.features);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (allCreators) return onSubmit({ allowedAccountIds: null, features });
    const ids = parseAccountIds(accountIds);
    if (ids === undefined) {
      toast.error(INVALID_ACCOUNT_IDS);
      return;
    }
    onSubmit({ allowedAccountIds: ids ?? [], features });
  }

  function toggle(feature: MemberFeature, on: boolean) {
    setFeatures((list) => (on ? [...list, feature] : list.filter((f) => f !== feature)));
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Creators</legend>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-3.5 accent-primary"
                checked={allCreators}
                onChange={(e) => setAllCreators(e.target.checked)}
              />
              All creators, including ones connected later
            </label>
            {!allCreators && (
              <AccountIdsField
                id="member-accounts"
                label="Only these account IDs"
                value={accountIds}
                onChange={setAccountIds}
                accounts={accounts.data?.items ?? []}
                emptyMeans="none"
              />
            )}
          </fieldset>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Features</legend>
            {FEATURES.map((f) => (
              <label key={f} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-3.5 accent-primary"
                  checked={features.includes(f)}
                  onChange={(e) => toggle(f, e.target.checked)}
                />
                {FEATURE_LABELS[f]}
              </label>
            ))}
            <p className="text-xs text-muted-foreground">
              None selected means the member can sign in but use nothing. API keys, logs, webhooks, accounts and the raw
              passthrough stay owner-only.
            </p>
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function formatAccounts(ids: number[] | null) {
  if (!ids) return 'All';
  return ids.length ? ids.join(', ') : 'None';
}
