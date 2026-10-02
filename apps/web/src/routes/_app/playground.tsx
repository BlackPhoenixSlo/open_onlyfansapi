import type { LogDetail } from '@api/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import { Button } from '@/components/ui/button';
import { OperationPicker } from '@/features/playground/OperationPicker';
import { type Draft, RequestForm } from '@/features/playground/RequestForm';
import { type Result, ResponsePanel } from '@/features/playground/ResponsePanel';
import { curlSnippet } from '@/features/playground/snippet';
import { type Op, fillPath, matchPath, pathParams, specQuery, urlProblem } from '@/features/playground/spec';
import { accountsQuery, logQuery } from '@/lib/api';

// State is in memory; only a log id goes in the URL (never request bodies).
export const Route = createFileRoute('/_app/playground')({
  validateSearch: (s: Record<string, unknown>): { log?: string } => ({
    log: typeof s.log === 'string' ? s.log : undefined,
  }),
  component: Playground,
});

type Initial = { draft: Draft; account: string };

function fromOp(op: Op | undefined): Draft {
  if (!op) return { method: 'GET', path: '/v1/whoami', params: {}, query: [], body: '' };
  return { method: op.method, path: op.path, params: {}, query: op.query.map((key) => ({ key, value: '' })), body: op.body ?? '' };
}

/** Prefill from a logged request: its operation template (or the raw path), path params, query and stored body. */
function fromLog(log: LogDetail, ops: Op[]): Initial {
  const match = matchPath(ops, log.method, log.path);
  const proxied = /^\/v1\/(\d+)(\/.*)$/.exec(log.path);
  const { account, ...params } = match?.params ?? {};
  return {
    account: account ?? proxied?.[1] ?? '',
    draft: {
      method: log.method,
      path: match?.op.path ?? (proxied ? `/v1/{account}${proxied[2]}` : log.path),
      params,
      query: [...new URLSearchParams(log.query ?? '')].map(([key, value]) => ({ key, value })),
      body: log.reqBody ?? match?.op.body ?? '',
    },
  };
}

function Playground() {
  const { log: logId } = Route.useSearch();
  const spec = useQuery(specQuery);
  const log = useQuery({ ...logQuery(logId ?? ''), enabled: logId !== undefined });

  if (spec.isPending || (logId !== undefined && log.isPending)) {
    return (
      <Page>
        <p className="text-muted-foreground">Loading…</p>
      </Page>
    );
  }
  const ops = spec.data?.ops ?? [];
  const initial = log.data ? fromLog(log.data, ops) : { draft: fromOp(ops[0]), account: '' };
  return (
    <Page>
      {spec.isError && <p className="text-sm text-destructive">{spec.error.message}</p>}
      {spec.data && !spec.data.upstreamAvailable && (
        <p className="text-sm text-muted-foreground">The upstream's operations are unavailable right now; only gateway routes are listed.</p>
      )}
      {log.isError && <p className="text-sm text-destructive">Could not load request {logId}: {log.error.message}</p>}
      <Workbench key={logId ?? 'new'} ops={ops} initial={initial} />
    </Page>
  );
}

function Page({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Playground</h1>
      {children}
    </div>
  );
}

async function sendRequest(method: string, url: string, body: string | undefined): Promise<Result> {
  // The dashboard session authenticates the call (no API key in the browser); it is logged as "Dashboard".
  const problem = urlProblem(url, window.location.origin);
  if (problem) throw new Error(problem);
  const headers: Record<string, string> = { 'x-dashboard': '1', accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const started = performance.now();
  const res = await fetch(url, { method, headers, body, credentials: 'include' });
  const text = await res.text();
  return {
    status: res.status,
    ms: Math.round(performance.now() - started),
    headers: [...res.headers],
    body: text,
    requestId: res.headers.get('x-request-id'),
  };
}

function jsonProblem(body: string): string | null {
  try {
    JSON.parse(body);
    return null;
  } catch (e) {
    return `The body is not valid JSON: ${(e as Error).message}`;
  }
}

/**
 * `_pagination.next_page` of a wrapped account-route response (`{data, _meta, _pagination?}`, plan-v5 §2.2), when it
 * points at this origin; null otherwise.
 */
function nextPage(result: Result | undefined): URL | null {
  if (!result || result.status < 200 || result.status > 299) return null;
  try {
    const next = (JSON.parse(result.body) as { _pagination?: { next_page?: unknown } } | null)?._pagination?.next_page;
    if (typeof next !== 'string') return null;
    const url = new URL(next);
    return url.origin === window.location.origin ? url : null;
  } catch {
    return null;
  }
}

function Workbench({ ops, initial }: { ops: Op[]; initial: Initial }) {
  const [draft, setDraft] = useState(initial.draft);
  const [account, setAccount] = useState(initial.account);
  const accounts = useQuery(accountsQuery);
  const queryClient = useQueryClient();

  const accountId = account || String(accounts.data?.items[0]?.id ?? '');
  const path = fillPath(draft.path, { ...draft.params, account: accountId });
  const query = new URLSearchParams(draft.query.filter((r) => r.key && r.value).map((r) => [r.key, r.value])).toString();
  const url = query ? `${path}?${query}` : path;
  const body = draft.method !== 'GET' && draft.body.trim() ? draft.body : undefined;
  const missing = pathParams(draft.path).filter((n) => !(n === 'account' ? accountId : draft.params[n]));
  const problem =
    missing.length > 0
      ? `Fill in: ${missing.join(', ')}.`
      : (urlProblem(url, window.location.origin) ?? (body !== undefined ? jsonProblem(body) : null));

  const send = useMutation({
    mutationFn: (target: string | undefined) => sendRequest(draft.method, target ?? url, body),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['logs'] }),
  });
  const next = send.isPending ? null : nextPage(send.data);
  const sendNext = (target: URL) => {
    setDraft({ ...draft, query: [...target.searchParams].map(([key, value]) => ({ key, value })) });
    send.mutate(target.pathname + target.search);
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
      <OperationPicker
        ops={ops}
        selected={ops.find((o) => o.method === draft.method && o.path === draft.path)?.id}
        onSelect={(op) => setDraft(fromOp(op))}
      />
      <div className="min-w-0 space-y-4">
        <RequestForm
          draft={draft}
          onChange={setDraft}
          accounts={accounts}
          account={accountId}
          onAccountChange={setAccount}
          snippet={curlSnippet({ method: draft.method, url: `${window.location.origin}${url}`, body })}
          problem={problem}
          sending={send.isPending}
          onSend={() => send.mutate(undefined)}
        />
        <ResponsePanel result={send.data} error={send.error} pending={send.isPending} />
        {next && (
          <Button variant="outline" onClick={() => sendNext(next)}>
            Next page
          </Button>
        )}
      </div>
    </div>
  );
}
