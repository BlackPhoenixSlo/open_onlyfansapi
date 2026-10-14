import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  accountsQuery,
  ApiError,
  browserLoginJobQuery,
  browserLoginStreamUrl,
  cancelBrowserLogin,
  sendBrowserLoginInput,
  startBrowserLogin,
} from '@/lib/api';

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

/** Remote-browser login (plan direct-login §C). Mounted only while open: the password never outlives it. */
export function BrowserLoginDialog({ onClose }: { onClose: () => void }) {
  const [started, setStarted] = useState<{ jobId: string; streamToken: string } | null>(null);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        {started ? (
          <LiveLogin jobId={started.jobId} streamToken={started.streamToken} onClose={onClose} />
        ) : (
          <StartForm onStarted={setStarted} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function StartForm({ onStarted }: { onStarted: (s: { jobId: string; streamToken: string }) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [proxy, setProxy] = useState('');

  const start = useMutation({
    mutationFn: () => startBrowserLogin({ email: email.trim(), password, proxy: proxy.trim() || undefined }),
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
      className="min-w-0 space-y-4"
    >
      <DialogHeader>
        <DialogTitle>Log in with a browser</DialogTitle>
      </DialogHeader>
      <DialogDescription className="leading-relaxed">
        A real browser signs this account in through its proxy. If OnlyFans shows a captcha or a 2FA prompt, solve it
        here — it is shown to you, never solved automatically. The password is sent once and never stored.
      </DialogDescription>
      <div className="space-y-2">
        <Label htmlFor="bl-email">Email</Label>
        <Input id="bl-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="bl-password">Password</Label>
        <Input id="bl-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" required />
      </div>
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

function LiveLogin({ jobId, streamToken, onClose }: { jobId: string; streamToken: string; onClose: () => void }) {
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
  return (
    <div className="min-w-0 space-y-4">
      <DialogHeader>
        <DialogTitle>Logging in…</DialogTitle>
        <DialogDescription>{job.data?.message ?? state ?? 'Starting'}</DialogDescription>
      </DialogHeader>

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
