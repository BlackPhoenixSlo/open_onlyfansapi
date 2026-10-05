import type { DeliveryNotice } from '@api/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, createFileRoute, redirect, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { authClient } from '@/lib/auth-client';
import { subscribe, useDashboardStream } from '@/lib/dashboard-stream';
import { PRODUCT_NAME } from '@/lib/brand';

export const Route = createFileRoute('/_app')({
  beforeLoad: async () => {
    const { data } = await authClient.getSession();
    if (!data) throw redirect({ to: '/login' });
  },
  component: AppLayout,
});

const nav = [
  { to: '/', label: 'Home' },
  { to: '/accounts', label: 'Accounts' },
  { to: '/keys', label: 'API keys' },
  { to: '/logs', label: 'Logs' },
  { to: '/usage', label: 'Usage' },
  { to: '/webhooks', label: 'Webhooks' },
  { to: '/playground', label: 'Playground' },
  { to: '/settings', label: 'Settings' },
] as const;

/** Each attempt outcome's wording and toast. A retry is not final: only delivered and failed reach the desktop. */
const OUTCOME: Record<DeliveryNotice['status'], { word: string; show: typeof toast.success; final: boolean }> = {
  succeeded: { word: 'delivered', show: toast.success, final: true },
  pending: { word: 'retrying', show: toast.warning, final: false },
  failed: { word: 'failed', show: toast.error, final: true },
};

/**
 * Shows each finished webhook delivery attempt on the dashboard stream as a toast and, for final ones when permission
 * is granted and the tab is hidden, a browser notification. Both open the webhook's page.
 */
function useDeliveryToasts() {
  const navigate = useNavigate();
  useEffect(
    () =>
      subscribe((frame) => {
        if (frame.event !== 'delivery') return;
        const n = frame.data;
        const outcome = OUTCOME[n.status];
        const detail = n.status === 'succeeded' ? `HTTP ${n.statusCode}` : n.error;
        const description = `${n.description || new URL(n.url).host} · ${outcome.word} · ${detail}`;
        const open = () => void navigate({ to: '/webhooks/$id', params: { id: n.endpointId } });
        outcome.show(n.eventType, { description, action: { label: 'View', onClick: open } });
        if (outcome.final && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
          const notification = new Notification(n.eventType, { body: description, tag: n.deliveryId });
          notification.onclick = () => {
            window.focus();
            open();
            notification.close();
          };
        }
      }),
    [navigate],
  );
}

function AppLayout() {
  const { data: session } = authClient.useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  useDashboardStream(session?.user.id);
  useDeliveryToasts();

  async function signOut() {
    await authClient.signOut();
    queryClient.clear();
    await navigate({ to: '/login' });
  }

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r p-4">
        <div className="mb-6 px-2 text-lg font-semibold">{PRODUCT_NAME}</div>
        <nav className="flex flex-1 flex-col gap-1">
          {nav.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeOptions={{ exact: item.to === '/' }}
              className="rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              activeProps={{ className: 'bg-accent text-accent-foreground font-medium' }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="justify-start truncate">
              {session?.user.email ?? 'Account'}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52">
            <DropdownMenuLabel className="truncate">{session?.user.email}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={signOut}>Sign out</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </aside>
      <main className="min-w-0 flex-1 p-8">
        <Outlet />
      </main>
    </div>
  );
}
