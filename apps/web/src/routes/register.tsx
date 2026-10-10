import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AuthCard } from '@/features/auth/AuthCard';
import { authClient } from '@/lib/auth-client';
import { PRODUCT_NAME } from '@/lib/brand';

export const Route = createFileRoute('/register')({ component: Register });

function Register() {
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    const { error } = await authClient.signUp.email({
      name: String(form.get('name')),
      email: String(form.get('email')),
      password: String(form.get('password')),
    });
    setPending(false);
    if (error) {
      toast.error(
        error.code === 'EMAIL_PASSWORD_SIGN_UP_DISABLED'
          ? 'Registration is closed. Ask the operator for an account.'
          : (error.message ?? 'Sign up failed'),
      );
      return;
    }
    // Signed in by the sign-up itself.
    await navigate({ to: '/dashboard' });
  }

  return (
    <AuthCard
      title={`Create your ${PRODUCT_NAME} account`}
      description={
        <>
          Already registered?{' '}
          <Link to="/login" className="underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="name">Name</Label>
          <Input id="name" name="name" autoComplete="name" required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input id="password" name="password" type="password" autoComplete="new-password" minLength={8} required />
        </div>
        <Button type="submit" className="w-full" disabled={pending}>
          Create account
        </Button>
      </form>
    </AuthCard>
  );
}
