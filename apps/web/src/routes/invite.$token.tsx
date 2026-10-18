import type { AcceptInviteBody, InvitePreview } from '@api/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AuthCard } from '@/features/auth/AuthCard';
import { api } from '@/lib/api';
import { authClient } from '@/lib/auth-client';
import { PRODUCT_NAME } from '@/lib/brand';

export const Route = createFileRoute('/invite/$token')({ component: AcceptInvite });

/** The page an invite link opens: pick a username and password, join the workspace, and sign in (plan-team §1.3). */
function AcceptInvite() {
  const { token } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(false);
  const preview = useQuery({
    queryKey: ['invite', token],
    queryFn: () => api<InvitePreview>(`/api/invites/${encodeURIComponent(token)}`),
  });

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const body: AcceptInviteBody = { username: String(form.get('username')).trim(), password: String(form.get('password')) };
    setPending(true);
    try {
      await api(`/api/invites/${encodeURIComponent(token)}/accept`, { method: 'POST', body });
      const { error } = await authClient.signIn.username(body);
      if (error) throw new Error(error.message ?? 'Joined, but sign-in failed; sign in with your new username');
      // A user signed in before (an owner opening the link) leaves cached queries behind, as sign-out would clear.
      queryClient.clear();
      await navigate({ to: '/dashboard' });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthCard
      title={preview.data ? `Join ${preview.data.workspace.name}` : `Join a ${PRODUCT_NAME} workspace`}
      description={
        <>
          Already joined?{' '}
          <Link to="/login" className="underline">
            Sign in
          </Link>
        </>
      }
    >
      {preview.isPending ? (
        <p className="text-sm text-muted-foreground">Checking the link…</p>
      ) : preview.isError ? (
        <p className="text-sm">{preview.error.message}. Ask the workspace owner for a new link.</p>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="username">Username</Label>
            <Input
              id="username"
              name="username"
              autoComplete="username"
              minLength={3}
              maxLength={30}
              pattern="[a-zA-Z0-9_.]+"
              title="Letters, digits, _ and . only"
              required
            />
            <p className="text-xs text-muted-foreground">You sign in with it; there is no email. 3 to 30 letters, digits, _ or .</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input id="password" name="password" type="password" autoComplete="new-password" minLength={8} required />
          </div>
          <Button type="submit" className="w-full" disabled={pending}>
            Join
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
