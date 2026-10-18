import type { Me } from '@api/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { WebhookHealthBadge } from '@/components/webhook-health';
import { accountLabel } from '@/components/account-ids-field';
import { featureList } from '@/features/team/features';
import { accountsQuery, meQuery, overviewQuery } from '@/lib/api';

export const Route = createFileRoute('/_app/dashboard')({ component: Home });

/** The owner's Home unless /api/me confirms a team member (also when it fails). */
function Home() {
  const me = useQuery(meQuery);
  if (me.isPending) return <p className="text-muted-foreground">Loading…</p>;
  return me.data?.role === 'member' ? <MemberHome me={me.data} /> : <OwnerHome />;
}

/** A team member's Home: what the owner gave them (the owner KPIs are owner-only). */
function MemberHome({ me }: { me: Me }) {
  const accounts = useQuery(accountsQuery);
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Home</h1>
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>Team member of {me.workspace.name}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <div>
            <div className="font-medium">Creators</div>
            {accounts.isPending ? (
              <p className="text-muted-foreground">Loading…</p>
            ) : accounts.isError ? (
              <p className="text-destructive">{accounts.error.message}</p>
            ) : accounts.data.items.length === 0 ? (
              <p className="text-muted-foreground">None yet.</p>
            ) : (
              <p>{accounts.data.items.map(accountLabel).join(', ')}</p>
            )}
          </div>
          <div>
            <div className="font-medium">Features</div>
            <p>{featureList(me.features, 'None yet. Ask the owner.')}</p>
          </div>
          <Link to="/playground" className="underline">
            Open the Playground
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}

function OwnerHome() {
  const overview = useQuery(overviewQuery);
  const o = overview.data;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Home</h1>
      <div className="grid gap-4 sm:grid-cols-3">
        <Kpi title="Requests (24h)" value={o ? o.requests24h.toLocaleString() : '—'} />
        <Kpi title="Error rate (24h)" value={o ? `${(o.errorRate24h * 100).toFixed(1)}%` : '—'} />
        <Kpi title="Active keys" value={o ? String(o.activeKeys) : '—'} />
      </div>
      {overview.isError && <p className="text-destructive">{overview.error.message}</p>}
      {o && o.needsAttention.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Needs attention</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {o.needsAttention.map((item) => (
                <li key={item.id} className="flex items-center gap-2">
                  <WebhookHealthBadge health={item.reason} />
                  <span>Webhook</span>
                  <Link to="/webhooks/$id" params={{ id: item.id }} className="font-mono text-xs break-all hover:underline">
                    {item.url}
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      <Link to="/usage" className="text-sm underline">
        View usage
      </Link>
    </div>
  );
}

function Kpi({ title, value }: { title: string; value: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent className="text-3xl font-semibold">{value}</CardContent>
    </Card>
  );
}
