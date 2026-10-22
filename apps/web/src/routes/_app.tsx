import type { Me, MemberFeature } from '@api/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, Outlet, createFileRoute, redirect, useLocation, useNavigate } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useDeliveryToasts } from '@/features/webhooks/delivery-toasts';
import { meQuery } from '@/lib/api';
import { authClient } from '@/lib/auth-client';
import { useDashboardStream } from '@/lib/dashboard-stream';
import { PRODUCT_NAME } from '@/lib/brand';

export const Route = createFileRoute('/_app')({
  beforeLoad: async () => {
    const { data } = await authClient.getSession();
    if (!data) throw redirect({ to: '/login' });
  },
  component: AppLayout,
});

/** Who sees an item: everyone, the owner only, or team members holding a feature (plan-team §2.4). */
type Access = 'all' | 'owner' | MemberFeature;

const nav = [
  { to: '/dashboard', label: 'Home', access: 'all' },
  { to: '/accounts', label: 'Accounts', access: 'owner' },
  { to: '/keys', label: 'API keys', access: 'owner' },
  { to: '/team', label: 'Team', access: 'owner' },
  { to: '/logs', label: 'Logs', access: 'owner' },
  { to: '/usage', label: 'Usage', access: 'owner' },
  { to: '/stats', label: 'Stats', access: 'stats' },
  { to: '/conversations', label: 'Conversations', access: 'stats' },
  { to: '/revenue', label: 'Revenue', access: 'stats' },
  { to: '/webhooks', label: 'Webhooks', access: 'owner' },
  { to: '/playground', label: 'Playground', access: 'all' },
  { to: '/settings', label: 'Settings', access: 'owner' },
] as const satisfies readonly { to: string; label: string; access: Access }[];

/**
 * The owner's view unless /api/me confirms a team member, so the owner's nav never depends on it. The API enforces
 * the same rules; this only hides dead ends.
 */
function canSee(access: Access, me: Me | undefined): boolean {
  if (access === 'all' || me?.role !== 'member') return true;
  return access !== 'owner' && me.features.includes(access);
}

function AppLayout() {
  const { data: session } = authClient.useSession();
  const me = useQuery(meQuery);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  // A page the nav hides from this user (a member typing /team, say) sends them Home, by the same rule.
  const page = nav.find((item) => pathname === item.to || pathname.startsWith(`${item.to}/`));
  const hidden = page !== undefined && !canSee(page.access, me.data);
  // The webhook stream is owner-only: not for a member, nor before /api/me answers.
  useDashboardStream(me.isPending || me.data?.role === 'member' ? undefined : session?.user.id);
  useDeliveryToasts();
  // A team member's email is a synthetic one: show their username.
  const accountName = session?.user.displayUsername || session?.user.email;

  async function signOut() {
    await authClient.signOut();
    queryClient.clear();
    await navigate({ to: '/login' });
  }

  return (
    // overflow-x-clip: a page wider than a phone must not widen the layout viewport (fixed dialogs center on it).
    <div className="flex min-h-screen overflow-x-clip">
      <aside className="flex w-56 shrink-0 flex-col border-r p-4">
        <div className="mb-6 px-2 text-lg font-semibold">{PRODUCT_NAME}</div>
        <nav className="flex flex-1 flex-col gap-1">
          {nav.filter((item) => canSee(item.access, me.data)).map((item) => (
            <Link
              key={item.to}
              to={item.to}
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
              {accountName ?? 'Account'}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-52">
            <DropdownMenuLabel className="truncate">{accountName}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={signOut}>Sign out</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </aside>
      <main className="min-w-0 flex-1 p-4 md:p-8">
        {hidden ? <Navigate to="/dashboard" replace /> : <Outlet />}
      </main>
    </div>
  );
}
