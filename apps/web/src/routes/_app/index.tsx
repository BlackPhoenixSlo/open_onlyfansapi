import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { overviewQuery } from '@/lib/api';

export const Route = createFileRoute('/_app/')({ component: Home });

function Home() {
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
                  <Badge variant={item.reason === 'paused' ? 'destructive' : 'secondary'}>{item.reason}</Badge>
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
