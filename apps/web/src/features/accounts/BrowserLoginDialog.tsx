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
type Started = { jobId: string; streamToken: string };
/** The Proxy choice that binds nothing: the account keeps its proxy, or a new one connects from the server's IP. */
const KEEP_PROXY = 'keep';

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
 * `backend="browserbase"` runs the browser on Browserbase's network: the operator solves any challenge in Browserbase's
 * live view (embedded, and one tap away full screen), and the optional proxy is bound to the account afterwards. It
 * needs no extension, so it is how an account is connected from a phone: there the form and its button fit the first
 * screen. Closing the dialog stops a running login, so it never connects an account nobody sees finish.
 */
export function BrowserLoginDialog({ onClose, backend = 'local' }: { onClose: () => void; backend?: BrowserLoginBackend }) {
  const [started, setStarted] = useState<Started | null>(null);
  const close = () => {
    if (started) cancelBrowserLogin(started.jobId).catch(() => undefined);
    onClose();
  };
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent
        className={
          backend === 'browserbase'
            ? 'max-h-dvh gap-4 overflow-y-auto p-4 sm:max-h-[calc(100dvh-2rem)] sm:max-w-2xl sm:gap-6 sm:p-6'
            : 'max-h-dvh overflow-y-auto sm:max-w-xl'
        }
      >
        {started ? (
          <LiveLogin jobId={started.jobId} streamToken={started.streamToken} onClose={onClose} onStop={close} />
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
  const [proxyChoice, setProxyChoice] = useState(KEEP_PROXY);
  const [howOpen, setHowOpen] = useState(false);
  const proxies = useQuery({ ...proxiesQuery, enabled: browserbase });
  const proxyLabel = browserbase && proxyChoice !== KEEP_PROXY ? proxyChoice : undefined;

  const start = useMutation({
    mutationFn: () =>
      startBrowserLogin(
        browserbase
          ? { email: email.trim(), password, proxyLabel, backend }
          : { email: email.trim(), password, proxy: proxy.trim() || undefined },
      ),
    // The variables hold the password: don't keep them in the mutation cache.
    gcTime: 0,
    onSuccess: (job) => onStarted({ jobId: job.jobId, streamToken: job.streamToken }),
  });
  const error = start.error instanceof ApiError ? start.error : null;

  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (email.trim() && password) start.mutate();
      }}
      className={browserbase ? 'min-w-0 space-y-3 sm:space-y-4' : 'min-w-0 space-y-4'}
    >
      <DialogHeader>
        <DialogTitle>{browserbase ? 'Try Browserbase login' : 'Log in with a browser'}</DialogTitle>
      </DialogHeader>
      {browserbase && (
        // On a phone the explanation folds away, so the email, password and button fit on the first screen.
        <button
          type="button"
          aria-expanded={howOpen}
          onClick={() => setHowOpen((o) => !o)}
          className="-mt-1 text-sm text-primary underline-offset-4 hover:underline sm:hidden"
        >
          How it works
        </button>
      )}
      <DialogDescription className={browserbase && !howOpen ? 'leading-relaxed max-sm:hidden' : 'leading-relaxed'}>
        {browserbase
          ? "The login runs in a remote browser on Browserbase's network, so no extension is needed and it works on a phone. If OnlyFans shows a verification check or asks for a 2FA code, you solve it yourself in the live view; nothing is solved automatically."
          : 'A real browser signs this account in through its proxy. If OnlyFans shows a captcha or a 2FA prompt, solve it here — it is shown to you, never solved automatically. The password is sent once and never stored.'}
      </DialogDescription>
      <div className="space-y-2">
        <Label htmlFor="bl-email">{browserbase ? 'OnlyFans email' : 'Email'}</Label>
        <Input
          id="bl-email"
          type="email"
          inputMode="email"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="off"
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="bl-password">{browserbase ? 'OnlyFans password' : 'Password'}</Label>
        <Input id="bl-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
        {browserbase && <p className="text-xs text-muted-foreground">Sent once to start the login, never stored.</p>}
      </div>
      {browserbase ? (
        <div className="space-y-2">
          <Label htmlFor="bl-proxy-label">Proxy for this account</Label>
          <Select value={proxyChoice} onValueChange={setProxyChoice} disabled={proxies.isPending || proxies.isError}>
            <SelectTrigger id="bl-proxy-label" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={KEEP_PROXY}>Keep its proxy (new account: server IP)</SelectItem>
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
          <p className={howOpen ? 'text-xs text-muted-foreground' : 'text-xs text-muted-foreground max-sm:hidden'}>
            Bound to the account after the login, like a pasted cURL, so all later traffic goes through it. The login
            itself runs on Browserbase's network.
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
      {start.error && (
        <p role="alert" className="text-sm text-destructive">
          {error?.message ?? 'Could not start the login'}
        </p>
      )}
      <DialogFooter>
        <Button type="submit" disabled={start.isPending || !email.trim() || !password} className={browserbase ? 'w-full sm:w-auto' : undefined}>
          {start.isPending && <LoaderCircle className="animate-spin" />}
          {browserbase ? (start.isPending ? 'Starting browser…' : 'Try Browserbase login') : 'Start'}
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

/** What each running state asks of the operator. */
const STATE_TEXT: Record<string, string> = {
  starting: 'Starting the remote browser (about 10 to 20 seconds)…',
  typing: 'Entering the email and password on OnlyFans…',
  challenge: 'OnlyFans is showing a verification check. Solve it in the live view.',
  otp: 'OnlyFans is asking for the 2FA code. Type it in the live view or below.',
  capturing: 'Signed in. Saving the session…',
};

function LiveLogin({
  jobId,
  streamToken,
  onClose,
  onStop,
}: {
  jobId: string;
  streamToken: string;
  onClose: () => void;
  /** Stops the job and closes the dialog. */
  onStop: () => void;
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

  const onCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const frame = frameRef.current;
    const canvas = canvasRef.current;
    if (!frame || !canvas) return;
    const { x, y } = canvasToFrame(e.clientX, e.clientY, canvas.getBoundingClientRect(), frame.w, frame.h);
    sendInput.mutate({ type: 'click', x, y });
  };

  const challenge = job.data?.challenge;
  const terminal = state === 'done' || state === 'error' || state === 'cancelled';
  const liveViewUrl = terminal ? null : job.data?.liveViewUrl;
  return (
    <div className="min-w-0 space-y-4">
      <DialogHeader>
        <DialogTitle>{liveViewUrl ? 'Browserbase login' : 'Logging in…'}</DialogTitle>
        <DialogDescription role="status">
          {(liveViewUrl && state && STATE_TEXT[state]) || job.data?.message || state || 'Starting'}
        </DialogDescription>
      </DialogHeader>

      {liveViewUrl && (
        <div className="space-y-2">
          {/* Touch inside an iframe is awkward on a phone: the full-screen page is one tap away. */}
          <Button asChild className="w-full sm:w-auto">
            <a href={liveViewUrl} target="_blank" rel="noopener noreferrer">
              Open live view full screen ↗
            </a>
          </Button>
          <iframe
            title="Browserbase live view"
            src={liveViewUrl}
            sandbox="allow-same-origin allow-scripts"
            allow="clipboard-read; clipboard-write"
            className="block aspect-[16/10] w-full max-w-full rounded-md border bg-muted"
          />
          <p className="text-xs text-muted-foreground">
            After solving it full screen, come back to this tab: the login finishes here.
          </p>
        </div>
      )}

      {state === 'challenge' && !liveViewUrl && (
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
        <Button type="button" variant="outline" onClick={onStop}>
          {terminal ? 'Close' : 'Stop login'}
        </Button>
      </DialogFooter>
    </div>
  );
}
