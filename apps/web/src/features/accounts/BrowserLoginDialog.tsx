import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  accountsQuery,
  ApiError,
  browserLoginJobQuery,
  browserLoginStreamUrl,
  cancelBrowserLogin,
  proxiesQuery,
  sendBrowserLoginInput,
  startBrowserLogin,
} from '@/lib/api';

export type BrowserLoginBackend = 'local' | 'browserbase';
type Started = { jobId: string; streamToken: string; proxyLabel?: string };
const NO_PROXY = 'none';

/** The notice shown when Browserbase refused the chosen proxy and the login ran from its own IP. */
export function proxyFallbackNotice(status: number | null | undefined, proxyLabel: string | undefined): string {
  return `Browserbase rejected the proxy (${status ?? 'error'}) — logged in via Browserbase's IP; session bound to proxy ${proxyLabel ?? '(none)'}`;
}

/** One screencast frame: a base64 PNG and the browser viewport's native pixel size. */
export type Frame = { w: number; h: number; png: string };

/**
 * Map a click on the displayed canvas back to the browser's native pixel coordinates:
 * `x = round((clientX - rect.left) * w / rect.width)`, same for y. The canvas is drawn at the frame's
 * native `w×h` but CSS-scaled to `rect`, so a click must be scaled back before it is sent.
 */
export function canvasToFrame(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  w: number,
  h: number,
): { x: number; y: number } {
  return {
    x: Math.round(((clientX - rect.left) * w) / rect.width),
    y: Math.round(((clientY - rect.top) * h) / rect.height),
  };
}

/**
 * Remote-browser login (plan direct-login §C). Mounted only while open: the password never outlives it.
 * `backend="browserbase"` runs the browser on Browserbase: the operator picks a registered proxy and solves any
 * challenge in Browserbase's live view.
 */
export function BrowserLoginDialog({ onClose, backend = 'local' }: { onClose: () => void; backend?: BrowserLoginBackend }) {
  const [started, setStarted] = useState<Started | null>(null);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        {started ? (
          <LiveLogin jobId={started.jobId} streamToken={started.streamToken} proxyLabel={started.proxyLabel} onClose={onClose} />
        ) : (
          <StartForm backend={backend} onStarted={setStarted} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function StartForm({ backend, onStarted }: { backend: BrowserLoginBackend; onStarted: (s: Started) => void }) {
  const browserbase = backend === 'browserbase';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [proxy, setProxy] = useState('');
  const [proxyChoice, setProxyChoice] = useState(NO_PROXY);
  const proxies = useQuery({ ...proxiesQuery, enabled: browserbase });
  const proxyLabel = browserbase && proxyChoice !== NO_PROXY ? proxyChoice : undefined;

  const start = useMutation({
    mutationFn: () =>
      startBrowserLogin(
        browserbase
          ? { email: email.trim(), password, proxyLabel, backend }
          : { email: email.trim(), password, proxy: proxy.trim() || undefined },
      ),
    // The variables hold the password: don't keep them in the mutation cache.
    gcTime: 0,
    onSuccess: (job) => onStarted({ jobId: job.jobId, streamToken: job.streamToken, proxyLabel }),
  });
  const error = start.error instanceof ApiError ? start.error : null;

  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (email.trim() && password) start.mutate();
      }}
      className="min-w-0 space-y-4"
    >
      <DialogHeader>
        <DialogTitle>{browserbase ? 'Try Browserbase login' : 'Log in with a browser'}</DialogTitle>
      </DialogHeader>
      <DialogDescription className="leading-relaxed">
        {browserbase
          ? 'A Browserbase browser signs this account in. Open its live view and solve any Cloudflare check or 2FA prompt there yourself — nothing is solved automatically. The password is sent once and never stored.'
          : 'A real browser signs this account in through its proxy. If OnlyFans shows a captcha or a 2FA prompt, solve it here — it is shown to you, never solved automatically. The password is sent once and never stored.'}
      </DialogDescription>
      <div className="space-y-2">
        <Label htmlFor="bl-email">Email</Label>
        <Input id="bl-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="bl-password">Password</Label>
        <Input id="bl-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" required />
      </div>
      {browserbase ? (
        <div className="space-y-2">
          <Label htmlFor="bl-proxy-label">Proxy</Label>
          <Select value={proxyChoice} onValueChange={setProxyChoice} disabled={proxies.isPending || proxies.isError}>
            <SelectTrigger id="bl-proxy-label" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_PROXY}>No proxy</SelectItem>
              {(proxies.data?.items ?? []).map((p) => (
                <SelectItem key={p.label} value={p.label}>
                  {p.label}
                  <span className="text-muted-foreground">
                    {p.scheme}://{p.host}:{p.port}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {proxies.isError && <p className="text-xs text-destructive">Couldn't load proxies: {proxies.error.message}</p>}
          <p className="text-xs text-muted-foreground">
            The account is bound to this proxy. If Browserbase refuses it (its free plan answers 402), the login runs
            from Browserbase's IP instead and the account is still bound to it.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <Label htmlFor="bl-proxy">Proxy</Label>
          <Input
            id="bl-proxy"
            value={proxy}
            onChange={(e) => setProxy(e.target.value)}
            placeholder="host:port:user:pass or scheme://user:pass@host:port"
            className="font-mono"
            spellCheck={false}
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">
            Its cookies are minted and used from the same IP. Required if the upstream enforces a proxy per account.
          </p>
        </div>
      )}
      {start.error && <p className="text-sm text-destructive">{error?.message ?? 'Could not start the login'}</p>}
      <DialogFooter>
        <Button type="submit" disabled={start.isPending || !email.trim() || !password}>
          {start.isPending && <LoaderCircle className="animate-spin" />}
          Start
        </Button>
      </DialogFooter>
    </form>
  );
}

const CHALLENGE_LABEL: Record<string, string> = {
  cloudflare: 'Cloudflare check',
  turnstile: 'Cloudflare Turnstile',
  recaptcha: 'reCAPTCHA',
  hcaptcha: 'hCaptcha',
  geetest: 'GeeTest',
};

function LiveLogin({
  jobId,
  streamToken,
  proxyLabel,
  onClose,
}: {
  jobId: string;
  streamToken: string;
  proxyLabel?: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const job = useQuery(browserLoginJobQuery(jobId));
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<Frame | null>(null);
  const [otp, setOtp] = useState('');

  // Screencast: draw each SSE frame onto the canvas at its native size.
  useEffect(() => {
    const source = new EventSource(browserLoginStreamUrl(jobId, streamToken));
    source.onmessage = (ev) => {
      let data: { frame?: Frame | null };
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!data.frame) return;
      frameRef.current = data.frame;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const img = new Image();
      img.onload = () => {
        canvas.width = data.frame!.w;
        canvas.height = data.frame!.h;
        canvas.getContext('2d')?.drawImage(img, 0, 0);
      };
      img.src = `data:image/png;base64,${data.frame.png}`;
    };
    return () => source.close();
  }, [jobId, streamToken]);

  const state = job.data?.state;
  useEffect(() => {
    if (state === 'done') {
      toast.success(job.data?.username ? `Connected @${job.data.username}` : 'Connected');
      void queryClient.invalidateQueries({ queryKey: accountsQuery.queryKey });
      onClose();
    }
  }, [state, job.data?.username, queryClient, onClose]);

  const sendInput = useMutation({ mutationFn: (body: Parameters<typeof sendBrowserLoginInput>[1]) => sendBrowserLoginInput(jobId, body) });
  const cancel = useMutation({ mutationFn: () => cancelBrowserLogin(jobId), onSuccess: () => onClose() });

  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const frame = frameRef.current;
    const canvas = canvasRef.current;
    if (!frame || !canvas) return;
    const { x, y } = canvasToFrame(e.clientX, e.clientY, canvas.getBoundingClientRect(), frame.w, frame.h);
    sendInput.mutate({ type: 'click', x, y });
  };

  const challenge = job.data?.challenge;
  const liveViewUrl = job.data?.liveViewUrl;
  return (
    <div className="min-w-0 space-y-4">
      <DialogHeader>
        <DialogTitle>Logging in…</DialogTitle>
        <DialogDescription>{job.data?.message ?? state ?? 'Starting'}</DialogDescription>
      </DialogHeader>

      {liveViewUrl && (
        <div className="space-y-2 rounded-md border p-3">
          <Button asChild size="sm">
            <a href={liveViewUrl} target="_blank" rel="noopener noreferrer">
              Open live view
            </a>
          </Button>
          <p className="text-xs text-muted-foreground">
            Watch the browser there. If OnlyFans shows a Cloudflare check or asks for a 2FA code, solve it in the live
            view; this dialog finishes on its own once the account is signed in.
          </p>
        </div>
      )}

      {job.data?.proxyFallback && (
        <p role="status" className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          {proxyFallbackNotice(job.data.proxyFallbackStatus, proxyLabel)}
        </p>
      )}

      {state === 'challenge' && (
        <div className="space-y-2">
          <p className="text-sm font-medium">{CHALLENGE_LABEL[challenge?.kind ?? ''] ?? 'Verification'} — solve it below</p>
          {/* The live browser; a click maps back to its native pixels. */}
          <canvas ref={canvasRef} onClick={onCanvasClick} className="w-full cursor-pointer rounded border" />
        </div>
      )}

      {state === 'otp' && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (otp.trim()) sendInput.mutate({ type: 'otp', code: otp.trim() });
          }}
          className="space-y-2"
        >
          <Label htmlFor="bl-otp">2FA code</Label>
          <div className="flex gap-2">
            <Input id="bl-otp" value={otp} onChange={(e) => setOtp(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={32} />
            <Button type="submit" disabled={!otp.trim() || sendInput.isPending}>
              Submit
            </Button>
          </div>
        </form>
      )}

      {state === 'error' && <p className="text-sm text-destructive">{job.data?.error ?? 'The login failed'}</p>}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
          Cancel
        </Button>
      </DialogFooter>
    </div>
  );
}
