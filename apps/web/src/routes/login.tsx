import { Link, createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authClient } from '@/lib/auth-client';
import { PRODUCT_NAME } from '@/lib/brand';

/** `error` is set by the email verification link when it fails (TOKEN_EXPIRED, INVALID_TOKEN, USER_NOT_FOUND). */
type LoginSearch = { error?: string };

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): LoginSearch =>
    typeof search.error === 'string' ? { error: search.error } : {},
  // Already signed in (e.g. right after following the verification link): go to the dashboard.
  beforeLoad: async () => {
    const { data } = await authClient.getSession();
    if (data) throw redirect({ to: '/dashboard' });
  },
  component: Login,
});

function Login() {
  const navigate = useNavigate();
  const { error: linkError } = Route.useSearch();
  const [pending, setPending] = useState(false);
  const [email, setEmail] = useState('');
  /** Sign-in was refused because the address is not verified yet. */
  const [unverified, setUnverified] = useState(false);
  const notice = unverified
    ? 'Your email is not verified yet. Check your email for a verification link.'
    : linkError === 'TOKEN_EXPIRED'
      ? 'That verification link has expired. Enter your email and send a new one.'
      : linkError
        ? 'That verification link is not valid. Enter your email and send a new one.'
        : null;

  async function resend() {
    if (!email) {
      toast.error('Enter your email above first');
      return;
    }
    setPending(true);
    const { error } = await authClient.sendVerificationEmail({ email });
    setPending(false);
    if (error) toast.error(error.message ?? 'Could not send the verification email');
    else toast.success('Verification email sent');
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setUnverified(false);
    const { error } = await authClient.signIn.email({ email, password: String(form.get('password')) });
    setPending(false);
    if (error?.code === 'EMAIL_NOT_VERIFIED') {
      setUnverified(true);
      return;
    }
    if (error) {
      toast.error(error.message ?? 'Sign in failed');
      return;
    }
    await navigate({ to: '/dashboard' });
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in to {PRODUCT_NAME}</CardTitle>
          <CardDescription>
            No account?{' '}
            <Link to="/register" className="underline">
              Create one
            </Link>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" name="password" type="password" autoComplete="current-password" required />
            </div>
            <Button type="submit" className="w-full" disabled={pending}>
              Sign in
            </Button>
          </form>
          {notice && (
            <div className="mt-4 space-y-2 text-sm">
              <p>{notice}</p>
              <Button type="button" variant="outline" className="w-full" disabled={pending} onClick={resend}>
                Resend verification email
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
