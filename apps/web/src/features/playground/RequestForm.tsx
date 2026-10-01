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
import { pathParams } from './spec';

export type Row = { key: string; value: string };
/** The request being edited. `path` is a template: `{name}` placeholders are filled from `params` (and the account picker). */
export type Draft = { method: string; path: string; params: Record<string, string>; query: Row[]; body: string };

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

export function RequestForm({
  draft,
  onChange,
  accounts,
  account,
  onAccountChange,
  snippet,
  problem,
  sending,
  onSend,
}: {
  draft: Draft;
  onChange: (draft: Draft) => void;
  accounts: UseQueryResult<{ items: Account[] }>;
  account: string;
  onAccountChange: (id: string) => void;
  snippet: string;
  /** Why the request can't be sent yet, if anything. */
  problem: string | null;
  sending: boolean;
  onSend: () => void;
}) {
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const setRow = (i: number, patch: Partial<Row>) => set({ query: draft.query.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  const names = pathParams(draft.path);

  return (
    <Card>
      <CardContent className="space-y-5">
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
        {problem && <p className="text-sm text-muted-foreground">{problem}</p>}

        {names.includes('account') && <AccountField accounts={accounts} value={account} onChange={onAccountChange} />}

        {names.some((n) => n !== 'account') && (
          <Section title="Path parameters">
            <div className="grid grid-cols-[10rem_1fr] items-center gap-2">
              {names
                .filter((n) => n !== 'account')
                .map((n) => (
                  <ParamRow key={n} name={n} value={draft.params[n] ?? ''} onChange={(v) => set({ params: { ...draft.params, [n]: v } })} />
                ))}
            </div>
          </Section>
        )}

        <Section title="Query parameters">
          {draft.query.map((row, i) => (
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
          <p className="text-xs text-muted-foreground">Rows with an empty name or value are not sent.</p>
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
          This workspace isn't linked to a backend user yet, so account calls return 409 <code>team_not_linked</code>. See the
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

function ParamRow({ name, value, onChange }: { name: string; value: string; onChange: (value: string) => void }) {
  const id = `param-${name}`;
  return (
    <>
      <Label htmlFor={id} className="font-mono">
        {name}
      </Label>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} className="font-mono" />
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
