import type { LogDetail } from '@api/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { Fragment, type ReactNode } from 'react';
import { toast } from 'sonner';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, logQuery } from '@/lib/api';
import { formatBytes } from '@/lib/utils';

export const Route = createFileRoute('/_app/logs/$id')({ component: LogPage });

function LogPage() {
  const { id } = Route.useParams();
  const log = useQuery(logQuery(id));

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <Link to="/logs" className="text-sm text-muted-foreground hover:underline">
            ← Logs
          </Link>
          <h1 className="text-2xl font-semibold">Request</h1>
        </div>
        {log.data && (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => copyCurl(log.data)}>
              Copy as cURL
            </Button>
            <Button variant="outline" asChild>
              <Link to="/playground" search={{ log: id }}>
                Open in playground
              </Link>
            </Button>
          </div>
        )}
      </div>

      {log.isPending ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : log.isError ? (
        <p className="text-destructive">
          {log.error instanceof ApiError && log.error.status === 404 ? 'Request not found.' : log.error.message}
        </p>
      ) : (
        <Detail log={log.data} />
      )}
    </div>
  );
}

function Detail({ log }: { log: LogDetail }) {
  const summary: [string, ReactNode][] = [
    ['Request ID', <span className="font-mono">{log.id}</span>],
    ['Time', new Date(log.createdAt).toLocaleString()],
    ['Method', <span className="font-mono">{log.method}</span>],
    ['Path', <span className="font-mono break-all">{log.path}</span>],
    ['Endpoint', log.endpoint],
    ['Status', <StatusBadge status={log.statusCode} />],
    ['Error code', log.errorCode ?? '—'],
    ['Duration', `${log.durationMs} ms`],
    ['Bytes', `${formatBytes(log.reqBytes)} sent, ${formatBytes(log.respBytes)} received`],
    ['Key', log.keyId === null ? 'Dashboard' : (log.keyName ?? log.keyId)],
    ['Account', log.accountId ?? '—'],
    ['IP', <span className="font-mono">{log.ip}</span>],
  ];
  const headers = Object.entries(log.reqHeaders);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Summary</CardTitle>
        </CardHeader>
        <CardContent>
          <Pairs rows={summary} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Request</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Pairs rows={[['Query', <span className="font-mono break-all">{log.query ? `?${log.query}` : '—'}</span>]]} />
          {headers.length > 0 && (
            <Pairs rows={headers.map(([k, v]) => [k, <span className="font-mono break-all">{v}</span>])} />
          )}
        </CardContent>
      </Card>
      <Body title="Request body" body={log.reqBody} />
      <Body title="Response body" body={log.respBody} />
    </div>
  );
}

function Pairs({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-2 text-sm">
      {rows.map(([k, v]) => (
        <Fragment key={k}>
          <dt className="text-muted-foreground">{k}</dt>
          <dd>{v}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function Body({ title, body }: { title: string; body: string | null }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {body === null ? (
          <p className="text-sm text-muted-foreground">Not stored (bodies are kept for failed requests by default).</p>
        ) : (
          <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs">{pretty(body)}</pre>
        )}
      </CardContent>
    </Card>
  );
}

function pretty(body: string) {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

/** Single-quotes a value for POSIX shells. */
const sh = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

function copyCurl(log: LogDetail) {
  const url = `${window.location.origin}${log.path}${log.query ? `?${log.query}` : ''}`;
  // Double quotes so the shell expands $API_KEY.
  const parts = [`curl -X ${log.method} ${sh(url)}`, `-H "Authorization: Bearer $API_KEY"`];
  if (log.reqBody !== null) {
    const type = log.reqHeaders['content-type'] ?? 'application/json';
    parts.push(`-H ${sh(`Content-Type: ${type}`)}`, `--data ${sh(log.reqBody)}`);
  }
  navigator.clipboard.writeText(parts.join(' \\\n  ')).then(
    () => toast.success('Copied cURL command'),
    () => toast.error('Copy failed'),
  );
}
