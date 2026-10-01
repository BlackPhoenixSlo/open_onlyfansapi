import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
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
