import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { keysQuery } from '@/lib/api';

export const Route = createFileRoute('/_app/')({ component: Home });

function Home() {
  const keys = useQuery(keysQuery);
  const activeKeys = keys.data?.items.filter((k) => !k.revokedAt).length;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Home</h1>
      <div className="grid gap-4 sm:grid-cols-3">
        <Kpi title="Requests (24h)" value="0" />
        <Kpi title="Error rate (24h)" value="0%" />
        <Kpi title="Active keys" value={activeKeys === undefined ? '—' : String(activeKeys)} />
      </div>
      <p className="text-sm text-muted-foreground">
        Request metrics are placeholders until request logging ships.{' '}
        <Link to="/usage" className="underline">
          View usage
        </Link>
      </p>
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
