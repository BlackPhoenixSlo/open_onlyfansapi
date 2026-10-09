import type { Account, UpdateAccountBody } from '@api/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { accountsQuery, api, proxiesQuery } from '@/lib/api';

// Select values: Radix refuses '' as an item value, and a `p:` prefix keeps a proxy label from colliding with these.
const NO_PROXY = 'none';
const NEW_PROXY = 'new';

/** Rename an account and change its proxy. Mount it only while open (it reads its initial values on mount). */
export function EditAccountDialog({ account, onClose }: { account: Account; onClose: () => void }) {
  const queryClient = useQueryClient();
  const proxies = useQuery(proxiesQuery);
  const [label, setLabel] = useState(account.label ?? '');
  // null until the user picks: the current binding comes from the proxy list, which may still be loading.
  const [choice, setChoice] = useState<string | null>(null);
  const [proxyUrl, setProxyUrl] = useState('');

  const assigned = proxies.data?.items.find((p) => p.assignedAccountIds.includes(account.id));
  const current = assigned ? `p:${assigned.label}` : NO_PROXY;
  const selected = choice ?? current;

  const save = useMutation({
    mutationFn: (body: UpdateAccountBody) => api(`/api/accounts/${account.id}`, { method: 'PATCH', body }),
    // The variables may hold a proxy URL with its password: don't keep them once the dialog is gone.
    gcTime: 0,
    onSuccess: () => {
      toast.success('Account updated');
      onClose();
      void queryClient.invalidateQueries({ queryKey: accountsQuery.queryKey });
      void queryClient.invalidateQueries({ queryKey: proxiesQuery.queryKey });
    },
    onError: (e) => toast.error(e.message),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const body: UpdateAccountBody = {};
    if (label.trim() && label.trim() !== account.label) body.label = label.trim();
    if (selected === NEW_PROXY) body.proxy = { url: proxyUrl.trim() };
    else if (selected !== current) body.proxy = selected === NO_PROXY ? null : { label: selected.slice(2) };
    if (Object.keys(body).length === 0) return onClose();
    save.mutate(body);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !save.isPending && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={onSubmit} className="min-w-0 space-y-4">
          <DialogHeader>
            <DialogTitle>Edit {account.username ? `@${account.username}` : account.id}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="account-label">Label</Label>
            <Input id="account-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={100} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="account-proxy">Proxy</Label>
            <Select value={selected} onValueChange={setChoice} disabled={proxies.isPending}>
              <SelectTrigger id="account-proxy" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_PROXY}>No proxy</SelectItem>
                {proxies.data?.items.map((p) => (
                  <SelectItem key={p.label} value={`p:${p.label}`}>
                    {p.label}
                    <span className="text-muted-foreground">
                      {p.scheme}://{p.host}:{p.port}
                    </span>
                  </SelectItem>
                ))}
                <SelectItem value={NEW_PROXY}>New proxy URL…</SelectItem>
              </SelectContent>
            </Select>
            {proxies.isError && <p className="text-xs text-destructive">Proxies could not be loaded: {proxies.error.message}</p>}
            {selected === NEW_PROXY && (
              <Input
                aria-label="Proxy URL"
                value={proxyUrl}
                onChange={(e) => setProxyUrl(e.target.value)}
                placeholder="http://user:pass@host:port or socks5h://…"
                className="font-mono"
                spellCheck={false}
                autoComplete="off"
                maxLength={2048}
                required
              />
            )}
            <p className="text-xs text-muted-foreground">
              A new URL is stored as this account's own proxy (acct-{account.id}). Changing the proxy restarts the
              account's connection.
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending && <LoaderCircle className="animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
