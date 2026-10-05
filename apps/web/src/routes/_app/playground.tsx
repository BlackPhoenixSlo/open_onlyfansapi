import type { LogDetail } from '@api/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { type ReactNode, useState } from 'react';
import { OperationPicker } from '@/features/playground/OperationPicker';
import { type Draft, type Missing, RequestForm } from '@/features/playground/RequestForm';
import { type Result, ResponsePanel } from '@/features/playground/ResponsePanel';
import {
  defaultDraft,
  forgetDraft,
  initialDraft,
  lastAccount,
  overlayRows,
  pickAccount,
  pushRecent,
  recentOps,
  rememberAccount,
  rememberDraft,
} from '@/features/playground/prefill';
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
  return op ? initialDraft(op) : { method: 'GET', path: '/v1/whoami', params: {}, query: [], body: '' };
}

/** Prefill from a logged request: its operation template (or the raw path), path params, query and stored body. */
function fromLog(log: LogDetail, ops: Op[]): Initial {
  const match = matchPath(ops, log.method, log.path);
  const proxied = /^\/v1\/(\d+)(\/.*)$/.exec(log.path);
  const { account, ...params } = match?.params ?? {};
  const logged = [...new URLSearchParams(log.query ?? '')].map(([key, value]) => ({ key, value }));
  // The logged values over the operation's declared parameters; the unlogged ones stay as empty rows (not sent), so
  // the replay shows their help text.
  const declared = (match?.op.params ?? []).filter((p) => p.in === 'query').map((p) => ({ key: p.name, value: '' }));
  return {
    account: account ?? proxied?.[1] ?? '',
    draft: {
      method: log.method,
      path: match?.op.path ?? (proxied ? `/v1/{account}${proxied[2]}` : log.path),
      params,
      query: overlayRows(declared, logged),
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
  const recent = recentOps();
  const initial = log.data
    ? fromLog(log.data, ops)
    : { draft: fromOp(ops.find((o) => o.id === recent[0]) ?? ops[0]), account: '' };
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

function Workbench({ ops, initial }: { ops: Op[]; initial: Initial }) {
  const [draft, setDraft] = useState(initial.draft);
  const [account, setAccount] = useState(initial.account);
  const [recent, setRecent] = useState(recentOps);
  const accounts = useQuery(accountsQuery);
  const queryClient = useQueryClient();

  const op = ops.find((o) => o.method === draft.method && o.path === draft.path);
  const accountId = account || pickAccount((accounts.data?.items ?? []).map((a) => String(a.id)), lastAccount());
  const path = fillPath(draft.path, { ...draft.params, account: accountId });
  const query = new URLSearchParams(draft.query.filter((r) => r.key && r.value).map((r) => [r.key, r.value])).toString();
  const url = query ? `${path}?${query}` : path;
  const body = draft.method !== 'GET' && draft.body.trim() ? draft.body : undefined;
  const missing: Missing = {
    path: pathParams(draft.path).filter((n) => !(n === 'account' ? accountId : draft.params[n])),
    query: (op?.params ?? [])
      .filter((p) => p.in === 'query' && p.required && !draft.query.some((r) => r.key === p.name && r.value))
      .map((p) => p.name),
  };
  const names = [...missing.path, ...missing.query];
  const kind = missing.query.length === 0 ? 'path ' : missing.path.length === 0 ? 'query ' : '';
  const problem =
    names.length > 0
      ? `Fill in the required ${kind}${names.length === 1 ? 'parameter' : 'parameters'}: ${names.join(', ')}.`
      : (urlProblem(url, window.location.origin) ?? (body !== undefined ? jsonProblem(body) : null));

  const send = useMutation({
    mutationFn: () => sendRequest(draft.method, url, body),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['logs'] }),
  });

  return (
    <div className="grid gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
      <OperationPicker
        ops={ops}
        recent={recent}
        selected={op?.id}
        onSelect={(o) => {
          setDraft(fromOp(o));
          send.reset();
        }}
      />
      <div className="min-w-0 space-y-4">
        <RequestForm
          op={op}
          draft={draft}
          onChange={setDraft}
          onReset={
            op &&
            (() => {
              forgetDraft(op);
              setDraft(defaultDraft(op));
            })
          }
          accounts={accounts}
          account={accountId}
          onAccountChange={(id) => {
            setAccount(id);
            rememberAccount(id);
          }}
          snippet={curlSnippet({ method: draft.method, url: `${window.location.origin}${url}`, body })}
          missing={missing}
          problem={problem}
          sending={send.isPending}
          onSend={() => {
            if (op) {
              rememberDraft(op, draft);
              setRecent(pushRecent(op.id));
            }
            if (pathParams(draft.path).includes('account')) rememberAccount(accountId);
            send.mutate();
          }}
        />
        <ResponsePanel result={send.data} error={send.error} pending={send.isPending} />
      </div>
    </div>
  );
}
