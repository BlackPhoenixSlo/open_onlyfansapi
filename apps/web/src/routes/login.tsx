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
  const [email, setEmail] = useState('');

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    const { error } = await authClient.signIn.email({ email, password: String(form.get('password')) });
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
