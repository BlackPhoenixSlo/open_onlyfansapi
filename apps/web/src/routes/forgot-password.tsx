import { Link, createFileRoute } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AuthCard } from '@/features/auth/AuthCard';
import { authClient } from '@/lib/auth-client';

export const Route = createFileRoute('/forgot-password')({ component: ForgotPassword });

function ForgotPassword() {
  const [pending, setPending] = useState(false);
  /** Set once requested: the address the reset link went to, if it has an account. */
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get('email'));
    setPending(true);
    // The API answers the same for unknown addresses, so this form does not reveal which emails have an account.
    const { error } = await authClient.requestPasswordReset({ email });
    setPending(false);
    if (error) {
      toast.error(error.message ?? 'Could not send the reset email');
      return;
    }
    setSentTo(email);
  }

  if (sentTo) {
    return (
      <AuthCard
        title="Check your email"
        description={
          <>
            If an account exists for {sentTo}, we sent a reset link (valid 1 hour). If this server has no email set up,
            ask its operator for a reset link.
          </>
        }
      >
        <Link to="/login" className="underline">
          Back to sign in
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Reset your password"
      description={
        <>
          Enter your email and we will send you a reset link.{' '}
          <Link to="/login" className="underline">
            Back to sign in
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </div>
        <Button type="submit" className="w-full" disabled={pending}>
          Send reset link
        </Button>
      </form>
    </AuthCard>
  );
}
