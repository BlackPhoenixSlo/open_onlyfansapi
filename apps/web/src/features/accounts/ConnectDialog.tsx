import type { ConnectAccountBody, ConnectedAccount } from '@api/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, LoaderCircle } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, accountsQuery, api } from '@/lib/api';
import { FASTT_STORE_URL, useFasttExtension } from './fastt';

const PROXY_REFERRAL_URL = 'https://iproyal.com/?r=jakabasej';

function FasttBlock() {
  const ext = useFasttExtension();
  return (
    <div className="space-y-2 rounded-md border p-3" data-testid="fastt-extension" data-state={ext}>
      <p className="font-medium">Fastt extension</p>
      {ext === 'checking' ? (
        <p className="text-muted-foreground">Checking for the extension…</p>
      ) : ext === 'installed' ? (
        <>
          <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400">
            <CircleCheck />
            Fastt extension installed
          </Badge>
          <p className="text-muted-foreground">Open the extension, press Copy curl, then paste it below and press Connect.</p>
        </>
      ) : (
        <>
          <Button asChild size="sm">
            <a href={FASTT_STORE_URL} target="_blank" rel="noopener noreferrer">
              Add the Fastt extension
            </a>
          </Button>
          <p className="text-muted-foreground">It captures your OnlyFans login in one click and copies the cURL.</p>
        </>
      )}
    </div>
  );
}

/** A client-side sanity check of a DevTools "Copy as cURL (bash)": null when plausible, else what is wrong. */
function checkCurl(curl: string): string | null {
  if (!/(^|\s)(-b\s+\$?'|--cookie\b)/.test(curl)) {
    return "This cURL has no cookies (-b '…'). In DevTools use Copy as cURL (bash), not cmd or PowerShell, while signed in.";
  }
  if (!/user-id\s*:/i.test(curl)) {
    return 'This cURL has no user-id header. Copy an onlyfans.com/api2/v2/… request, not the page or an image.';
  }
  return null;
}

/** Plain-language advice for the upstream's /session/bootstrap errors; null when its own message is enough. */
function connectHint(e: ApiError): string | null {
  switch (e.code) {
    case 'invalid_curl':
      return 'The upstream could not read this cURL. Copy the request again with DevTools → Copy as cURL (bash).';
    case 'proxy_required':
      return 'This upstream requires a proxy per account (OF_REQUIRE_PROXY=true). Add one and try again.';
    case 'invalid_proxy_url':
      return 'Use http://user:pass@host:port or socks5h://user:pass@host:port.';
    case 'proxy_error':
      return 'The proxy could not be reached; check its host, port and credentials, or try another.';
    case 'of_timeout':
    case 'of_unreachable':
      return 'OnlyFans could not be reached through this proxy; try again or try another proxy.';
    case 'of_error':
      if (e.status === 403) return 'OnlyFans refused this proxy; try another. If it keeps failing, copy a fresh cURL.';
      if (e.status === 401) return 'OnlyFans rejected the session: sign in again and copy a fresh cURL.';
      return null;
    default:
      return null;
  }
}

/** Connect an account from a pasted cURL. Mount it only while open: unmounting drops the cURL (live cookies). */
export function ConnectDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [curl, setCurl] = useState('');
  const [nickname, setNickname] = useState('');
  const [proxyUrl, setProxyUrl] = useState('');
  const [invalid, setInvalid] = useState<string | null>(null);

  const connect = useMutation({
    mutationFn: (body: ConnectAccountBody) => api<ConnectedAccount>('/api/accounts/connect', { method: 'POST', body }),
    // The variables hold the cURL: don't keep them in the mutation cache once the dialog is gone.
    gcTime: 0,
    onSuccess: (res, body) => {
      setCurl('');
      onClose();
      toast.success(`Connected ${body.nickname ?? (res.username ? `@${res.username}` : res.accountId)}`);
      void queryClient.invalidateQueries({ queryKey: accountsQuery.queryKey });
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const problem = checkCurl(curl);
    setInvalid(problem);
    connect.reset();
    if (problem) return;
    connect.mutate({ curl, nickname: nickname.trim() || undefined, proxyUrl: proxyUrl.trim() || undefined });
  }

  const error = connect.error instanceof ApiError ? connect.error : null;
  const hint = error && connectHint(error);

  return (
    <Dialog open onOpenChange={(open) => !open && !connect.isPending && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <form onSubmit={onSubmit} className="min-w-0 space-y-4">
          <DialogHeader>
            <DialogTitle>Connect account</DialogTitle>
          </DialogHeader>
          <FasttBlock />
          <DialogDescription asChild>
            <ol className="list-decimal space-y-1 pl-5 leading-relaxed">
              <li>
                Add the extension (or copy a cURL from DevTools: in Chrome, sign in to onlyfans.com as the account, use
                an incognito window to keep your current login, DevTools → Network → any api2/v2 request → Copy as cURL
                (bash)).
              </li>
              <li>Sign in to OnlyFans through it and press Copy curl.</li>
              <li>Paste here, add a proxy, press Connect.</li>
            </ol>
          </DialogDescription>
          <div className="space-y-2">
            <Label htmlFor="connect-curl">cURL</Label>
            <Textarea
              id="connect-curl"
              value={curl}
              onChange={(e) => setCurl(e.target.value)}
              placeholder="curl 'https://onlyfans.com/api2/v2/…' -H 'user-id: …' -b '…'"
              className="h-36 resize-y font-mono text-xs break-all [field-sizing:fixed]"
              spellCheck={false}
              autoComplete="off"
              aria-invalid={invalid !== null}
              required
            />
            {invalid && <p className="text-sm text-destructive">{invalid}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="connect-nickname">Nickname (optional)</Label>
            <Input id="connect-nickname" value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={100} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="connect-proxy">Proxy</Label>
            <Input
              id="connect-proxy"
              value={proxyUrl}
              onChange={(e) => setProxyUrl(e.target.value)}
              placeholder="http://user:pass@host:port or socks5h://…"
              className="font-mono"
              spellCheck={false}
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              Optional. Leave empty to connect from the server's own IP (or to keep the proxy an already connected
              account has). Give each account its own proxy if you want its traffic to come from a different IP. Need
              one?{' '}
              <a href={PROXY_REFERRAL_URL} target="_blank" rel="noopener noreferrer" className="underline">
                Get a proxy from IPRoyal
              </a>
              .
            </p>
          </div>
          {connect.error && (
            <div role="alert" className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3">
              <p className="text-sm text-destructive">{hint ?? connect.error.message}</p>
              {hint && error && (
                <p className="text-xs break-words text-muted-foreground">
                  Upstream: {error.code}
                  {error.message ? ` (${error.message})` : ''}
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={connect.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={connect.isPending}>
              {connect.isPending && <LoaderCircle className="animate-spin" />}
              {connect.isPending ? 'Connecting…' : 'Connect'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
