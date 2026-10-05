import type { Account } from '@api/contracts';
import type { UseQueryResult } from '@tanstack/react-query';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ApiError } from '@/lib/api';
import { type Op, type Param, pathParams } from './spec';

export type Row = { key: string; value: string };
/** The request being edited. `path` is a template: `{name}` placeholders are filled from `params` (and the account picker). */
export type Draft = { method: string; path: string; params: Record<string, string>; query: Row[]; body: string };
/** The required parameters still empty, by name (`account` included in `path`). */
export type Missing = { path: string[]; query: string[] };

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export function RequestForm({
  op,
  draft,
  onChange,
  onReset,
  accounts,
  account,
  onAccountChange,
  snippet,
  missing,
  problem,
  sending,
  onSend,
}: {
  /** The spec operation the draft's method and path match, if any. */
  op: Op | undefined;
  draft: Draft;
  onChange: (draft: Draft) => void;
  /** Back to the operation's defaults, forgetting its remembered values. */
  onReset: (() => void) | undefined;
  accounts: UseQueryResult<{ items: Account[] }>;
  account: string;
  onAccountChange: (id: string) => void;
  snippet: string;
  /** Marks these parameters invalid. */
  missing: Missing;
  /** Why the request can't be sent yet, if anything. */
  problem: string | null;
  sending: boolean;
  onSend: () => void;
}) {
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const setRow = (i: number, patch: Partial<Row>) => set({ query: draft.query.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const names = pathParams(draft.path);
  const pathMeta = (name: string) => op?.params.find((p) => p.in === 'path' && p.name === name);
  // Declared query parameters get a labelled row (the first row with their name); every other row is free-form.
  const declared = (op?.params ?? [])
    .filter((p) => p.in === 'query')
    .map((p) => ({ p, i: draft.query.findIndex((r) => r.key === p.name) }))
    .filter(({ i }) => i >= 0);
  const free = draft.query.map((row, i) => ({ row, i })).filter(({ i }) => !declared.some((d) => d.i === i));

  return (
    <Card>
      <CardContent className="space-y-5">
        {op && (
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold">{op.summary ?? op.operationId ?? op.id}</h2>
              {op.summary && op.operationId && <p className="font-mono text-xs text-muted-foreground">{op.operationId}</p>}
            </div>
            {onReset && (
              <button type="button" onClick={onReset} className="text-sm text-muted-foreground underline-offset-4 hover:underline">
                Reset to defaults
              </button>
            )}
          </div>
        )}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!sending && problem === null) onSend();
          }}
        >
          <Select value={draft.method} onValueChange={(method) => set({ method })}>
            <SelectTrigger className="w-28 font-mono" aria-label="Method">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {METHODS.map((m) => (
                <SelectItem key={m} value={m} className="font-mono">
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input value={draft.path} onChange={(e) => set({ path: e.target.value })} className="font-mono" aria-label="Path" />
          <Button type="submit" disabled={sending || problem !== null}>
            {sending ? 'Sending…' : 'Send'}
          </Button>
        </form>
        {problem && (
          <p role="status" className="text-sm text-muted-foreground">
            {problem}
          </p>
        )}

        {names.includes('account') && <AccountField accounts={accounts} value={account} onChange={onAccountChange} />}

        {names.some((n) => n !== 'account') && (
          <Section title="Path parameters">
            <ParamGrid>
              {names
                .filter((n) => n !== 'account')
                .map((n) => (
                  <ParamRow
                    key={n}
                    name={n}
                    meta={pathMeta(n)}
                    required
                    invalid={missing.path.includes(n)}
                    value={draft.params[n] ?? ''}
                    onChange={(v) => set({ params: { ...draft.params, [n]: v } })}
                  />
                ))}
            </ParamGrid>
          </Section>
        )}

        <Section title="Query parameters">
          {declared.length > 0 && (
            <ParamGrid>
              {declared.map(({ p, i }) => (
                <ParamRow
                  key={p.name}
                  name={p.name}
                  meta={p}
                  required={p.required}
                  invalid={missing.query.includes(p.name)}
                  value={draft.query[i]!.value}
                  onChange={(value) => setRow(i, { value })}
                />
              ))}
            </ParamGrid>
          )}
          {free.map(({ row, i }) => (
            <div key={i} className="flex gap-2">
              <Input value={row.key} onChange={(e) => setRow(i, { key: e.target.value })} placeholder="name" className="w-48 font-mono" aria-label="Query name" />
              <Input value={row.value} onChange={(e) => setRow(i, { value: e.target.value })} placeholder="value" className="font-mono" aria-label="Query value" />
              <Button variant="ghost" size="icon" aria-label="Remove" onClick={() => set({ query: draft.query.filter((_, j) => j !== i) })}>
                <X />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={() => set({ query: [...draft.query, { key: '', value: '' }] })}>
            Add query parameter
          </Button>
          <p className="text-xs text-muted-foreground">Empty values are not sent; the API then uses its default.</p>
        </Section>

        {draft.method !== 'GET' && (
          <Section title="JSON body">
            <Textarea
              value={draft.body}
              onChange={(e) => set({ body: e.target.value })}
              rows={8}
              spellCheck={false}
              className="max-h-96 font-mono text-xs md:text-xs"
              aria-label="JSON body"
              placeholder="Leave empty to send no body"
            />
            {op && op.fields.length > 0 && (
              <dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-1 text-xs">
                {op.fields.map((f) => (
                  <div key={f.name} className="contents">
                    <dt className="font-mono">
                      {f.name}
                      {f.required && <RequiredMark />}
                    </dt>
                    <dd className="text-muted-foreground">
                      {f.type}
                      {f.placeholder !== undefined && ` · default ${f.placeholder}`}
                      {f.description && ` · ${f.description}`}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </Section>
        )}

        <Section title="curl">
          <div className="relative">
            <pre className="overflow-x-auto rounded-md bg-muted p-3 pr-20 text-xs">{snippet}</pre>
            <Button
              variant="outline"
              size="sm"
              className="absolute top-2 right-2"
              onClick={() =>
                navigator.clipboard.writeText(snippet).then(
                  () => toast.success('Copied cURL command'),
                  () => toast.error('Copy failed'),
                )
              }
            >
              Copy
            </Button>
          </div>
        </Section>
      </CardContent>
    </Card>
  );
}

function AccountField({
  accounts,
  value,
  onChange,
}: {
  accounts: UseQueryResult<{ items: Account[] }>;
  value: string;
  onChange: (id: string) => void;
}) {
  let body: ReactNode;
  if (accounts.isPending) body = <p className="text-sm text-muted-foreground">Loading accounts…</p>;
  else if (accounts.isError)
    body =
      accounts.error instanceof ApiError && accounts.error.code === 'team_not_linked' ? (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          This workspace isn't linked to the upstream yet, so account calls return 409 <code>team_not_linked</code>. See the
          Accounts page for how to link it.
        </p>
      ) : (
        <p className="text-sm text-destructive">{accounts.error.message}</p>
      );
  else if (accounts.data.items.length === 0) body = <p className="text-sm text-muted-foreground">No accounts are connected yet.</p>;
  else
    body = (
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-72" aria-label="Account">
          <SelectValue placeholder="Pick an account" />
        </SelectTrigger>
        <SelectContent>
          {accounts.data.items.map((a) => (
            <SelectItem key={a.id} value={String(a.id)}>
              {a.label ?? a.displayName ?? a.username ?? 'Account'} <span className="text-muted-foreground">#{a.id}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  return <Section title="Account">{body}</Section>;
}

function ParamGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-[12rem_1fr] items-start gap-x-3 gap-y-3">{children}</div>;
}

function RequiredMark() {
  return (
    <span className="ml-0.5 text-destructive" title="Required">
      *
    </span>
  );
}

function ParamRow({
  name,
  meta,
  required,
  invalid,
  value,
  onChange,
}: {
  name: string;
  meta: Param | undefined;
  required: boolean;
  /** Missing, and the request can't be sent without it. */
  invalid?: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = `param-${name}`;
  return (
    <>
      <div className="min-w-0 pt-1.5">
        <Label htmlFor={id} className="font-mono break-all">
          {name}
          {required && <RequiredMark />}
        </Label>
        {meta && <p className="truncate text-xs text-muted-foreground" title={meta.type}>{meta.type}</p>}
      </div>
      <div className="min-w-0 space-y-1">
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={meta?.placeholder}
          aria-invalid={invalid || undefined}
          className="font-mono"
        />
        {meta?.description && <p className="text-xs text-muted-foreground">{meta.description}</p>}
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </div>
  );
}
