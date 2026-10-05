import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { toast } from 'sonner';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { prettyJson } from '@/lib/utils';
import { type ResponseTable, responseTable } from './table';

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
            <Body key={result.requestId ?? result.body} body={result.body} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Body({ body }: { body: string }) {
  const table = responseTable(body);
  const [view, setView] = useState<'json' | 'table'>('json');
  if (!body) return <pre className="rounded-md bg-muted p-3 text-xs">(empty body)</pre>;
  const pretty = prettyJson(body);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        {table && (
          <div className="flex gap-1" role="group" aria-label="Response view">
            <Button size="sm" variant={view === 'json' ? 'secondary' : 'ghost'} aria-pressed={view === 'json'} onClick={() => setView('json')}>
              JSON
            </Button>
            <Button size="sm" variant={view === 'table' ? 'secondary' : 'ghost'} aria-pressed={view === 'table'} onClick={() => setView('table')}>
              Table
            </Button>
          </div>
        )}
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          onClick={() =>
            navigator.clipboard.writeText(pretty).then(
              () => toast.success('Copied response body'),
              () => toast.error('Copy failed'),
            )
          }
        >
          Copy
        </Button>
      </div>
      {table && view === 'table' ? (
        <RowsTable table={table} />
      ) : (
        <pre className="max-h-[32rem] overflow-auto rounded-md bg-muted p-3 text-xs">{pretty}</pre>
      )}
    </div>
  );
}

function RowsTable({ table }: { table: ResponseTable }) {
  return (
    <div className="space-y-1">
      <div className="max-h-[32rem] overflow-auto rounded-md border">
        <Table className="text-xs">
          <TableHeader>
            <TableRow>
              {table.columns.map((c) => (
                <TableHead key={c} className="font-mono">
                  {c}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {table.rows.map((row, i) => (
              <TableRow key={i}>
                {table.columns.map((c) => (
                  <TableCell key={c} className="font-mono">
                    {row[c] === undefined || row[c] === null ? '' : String(row[c])}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        <code>{table.key}</code>: {table.total > table.rows.length ? `first ${table.rows.length} of ${table.total} rows` : `${table.total} rows`}
      </p>
    </div>
  );
}
