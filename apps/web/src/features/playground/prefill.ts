import type { Draft, Row } from './RequestForm';
import type { Op, Param } from './spec';

const DAY_MS = 86_400_000;
/** Date-range parameter names → which end of the default range (last 7 days to today) they take. */
const RANGE: Record<string, 'start' | 'end'> = {
  from: 'start',
  startDate: 'start',
  start_date: 'start',
  to: 'end',
  endDate: 'end',
  end_date: 'end',
};

/** The prefilled value for a query parameter: `limit` 20 (or the spec's maximum), date ranges the last 7 days; else empty. */
export function smartDefault(p: Param, now = new Date()): string {
  if (p.in !== 'query') return '';
  if (p.name === 'limit') return String(Math.min(20, p.maximum ?? 20));
  const edge = RANGE[p.name];
  if (!edge) return '';
  const iso = new Date(edge === 'start' ? now.getTime() - 7 * DAY_MS : now.getTime()).toISOString();
  return p.format === 'date-time' ? iso : iso.slice(0, 10);
}

/** A fresh request for `op`: every declared query parameter as a row (smart default or empty) and the body seed. */
export function defaultDraft(op: Op, now = new Date()): Draft {
  return {
    method: op.method,
    path: op.path,
    params: {},
    query: op.params.filter((p) => p.in === 'query').map((p) => ({ key: p.name, value: smartDefault(p, now) })),
    body: op.body ?? '',
  };
}

/** What is remembered per operation: only what differs from the defaults, so date ranges stay fresh. */
type Saved = { params: Record<string, string>; query: Row[]; body?: string };

const opKey = (id: string) => `gateway.playground.op.${id}`;
const RECENT_KEY = 'gateway.playground.recent';
const ACCOUNT_KEY = 'gateway.playground.account';
const RECENT_MAX = 8;

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or disabled: remembering is best effort.
  }
}

/** `op`'s defaults with the values last sent for it on top. */
export function initialDraft(op: Op): Draft {
  const draft = defaultDraft(op);
  const saved = read<Saved>(opKey(op.id));
  if (!saved) return draft;
  const query = [...draft.query];
  const used = new Set<number>();
  for (const row of saved.query ?? []) {
    const i = draft.query.findIndex((r, j) => r.key === row.key && !used.has(j));
    if (i < 0) query.push(row);
    else {
      used.add(i);
      query[i] = row;
    }
  }
  return { ...draft, params: saved.params ?? {}, query, body: saved.body ?? draft.body };
}

/** Remembers the values `draft` sends for `op` that differ from its defaults. */
export function rememberDraft(op: Op, draft: Draft) {
  const defaults = defaultDraft(op);
  const params = Object.fromEntries(Object.entries(draft.params).filter(([, v]) => v));
  const used = new Set<number>();
  const query = draft.query.filter((row) => {
    if (!row.key) return false;
    const i = defaults.query.findIndex((d, j) => d.key === row.key && !used.has(j));
    if (i < 0) return true;
    used.add(i);
    return defaults.query[i]!.value !== row.value;
  });
  const body = draft.body !== defaults.body ? draft.body : undefined;
  const empty = Object.keys(params).length === 0 && query.length === 0 && body === undefined;
  write(opKey(op.id), empty ? null : { params, query, body });
}

export function forgetDraft(op: Op) {
  write(opKey(op.id), null);
}

/** The last used operation ids, most recent first. */
export function recentOps(): string[] {
  const ids = read<unknown>(RECENT_KEY);
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

export function pushRecent(id: string): string[] {
  const ids = [id, ...recentOps().filter((r) => r !== id)].slice(0, RECENT_MAX);
  write(RECENT_KEY, ids);
  return ids;
}

export function lastAccount(): string {
  const id = read<unknown>(ACCOUNT_KEY);
  return typeof id === 'string' ? id : '';
}

export function rememberAccount(id: string) {
  write(ACCOUNT_KEY, id || null);
}

/** The account to preselect: the only one, else the last used if still listed, else the first. */
export function pickAccount(ids: string[], last: string): string {
  if (ids.length === 1) return ids[0]!;
  return ids.includes(last) ? last : (ids[0] ?? '');
}
