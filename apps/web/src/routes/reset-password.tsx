import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AuthCard } from '@/features/auth/AuthCard';
import { authClient } from '@/lib/auth-client';

const BAD_LINK = 'That reset link is not valid or has expired.';

/** `token` comes from the emailed link. */
type ResetSearch = { token?: string };

export const Route = createFileRoute('/reset-password')({
  validateSearch: (search: Record<string, unknown>): ResetSearch =>
    typeof search.token === 'string' ? { token: search.token } : {},
  component: ResetPassword,
});

function ResetPassword() {
  const navigate = useNavigate();
  const { token } = Route.useSearch();
  const [pending, setPending] = useState(false);
  /** Why the server refused the new password. */
  const [failure, setFailure] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const newPassword = String(new FormData(e.currentTarget).get('password'));
    setPending(true);
    const { error } = await authClient.resetPassword({ newPassword, token });
    setPending(false);
    if (error) {
      setFailure(error.code === 'INVALID_TOKEN' ? BAD_LINK : (error.message ?? 'Could not reset the password'));
      return;
    }
    toast.success('Password changed. Sign in with your new password.');
    await navigate({ to: '/login' });
  }

  return (
    <AuthCard
      title="Choose a new password"
      description={
        <Link to="/login" className="underline">
          Back to sign in
        </Link>
      }
    >
      {!token || failure ? (
        <div className="space-y-2 text-sm">
          <p>{failure ?? BAD_LINK}</p>
          <Link to="/forgot-password" className="underline">
            Request a new reset link
          </Link>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="password">New password</Label>
            <Input id="password" name="password" type="password" autoComplete="new-password" minLength={8} required />
          </div>
          <Button type="submit" className="w-full" disabled={pending}>
            Set new password
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
