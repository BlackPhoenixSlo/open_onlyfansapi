import { Link, createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AuthCard } from '@/features/auth/AuthCard';
import { authClient } from '@/lib/auth-client';
import { PRODUCT_NAME } from '@/lib/brand';

export const Route = createFileRoute('/login')({
  // Already signed in: go to the dashboard.
  beforeLoad: async () => {
    const { data } = await authClient.getSession();
    if (data) throw redirect({ to: '/dashboard' });
  },
  component: Login,
});

function Login() {
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  /** An email (the owner's) or a username (a team member's, who has no email). */
  const [identifier, setIdentifier] = useState('');

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const password = String(new FormData(e.currentTarget).get('password'));
    const login = identifier.trim();
    setPending(true);
    const { error } = login.includes('@')
      ? await authClient.signIn.email({ email: login, password })
      : await authClient.signIn.username({ username: login, password });
    setPending(false);
    if (error) {
      toast.error(error.message ?? 'Sign in failed');
      return;
    }
    await navigate({ to: '/dashboard' });
  }

  return (
    <AuthCard
      title={`Sign in to ${PRODUCT_NAME}`}
      description={
        <>
          No account?{' '}
          <Link to="/register" className="underline">
            Create one
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="login">Email or username</Label>
          <Input
            id="login"
            name="login"
            autoComplete="username"
            required
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">Password</Label>
            <Link to="/forgot-password" className="text-sm underline">
              Forgot password?
            </Link>
          </div>
          <Input id="password" name="password" type="password" autoComplete="current-password" required />
        </div>
        <Button type="submit" className="w-full" disabled={pending}>
          Sign in
        </Button>
      </form>
    </AuthCard>
  );
}
