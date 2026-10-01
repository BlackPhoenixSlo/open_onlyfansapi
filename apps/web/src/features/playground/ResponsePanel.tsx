import { Link } from '@tanstack/react-router';
import { StatusBadge } from '@/components/status-badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { prettyJson } from '@/lib/utils';

export type Result = { status: number; ms: number; headers: [string, string][]; body: string; requestId: string | null };

export function ResponsePanel({ result, error, pending }: { result: Result | undefined; error: Error | null; pending: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Response</CardTitle>
      </CardHeader>
      <CardContent>
        {pending ? (
          <p className="text-sm text-muted-foreground">Sending…</p>
        ) : error ? (
          <p className="text-sm text-destructive">Request failed: {error.message}</p>
        ) : !result ? (
          <p className="text-sm text-muted-foreground">Send a request to see the response.</p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <StatusBadge status={result.status} />
              <span>{result.ms} ms</span>
              {result.requestId && (
                <Link to="/logs/$id" params={{ id: result.requestId }} className="font-mono text-xs text-muted-foreground hover:underline">
                  {result.requestId}
                </Link>
              )}
            </div>
            <details>
              <summary className="cursor-pointer text-sm text-muted-foreground">Headers ({result.headers.length})</summary>
              <dl className="mt-2 grid grid-cols-[14rem_1fr] gap-x-4 gap-y-1 font-mono text-xs">
                {result.headers.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="break-all">{v}</dd>
                  </div>
                ))}
              </dl>
            </details>
            <pre className="max-h-[32rem] overflow-auto rounded-md bg-muted p-3 text-xs">{result.body ? prettyJson(result.body) : '(empty body)'}</pre>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
