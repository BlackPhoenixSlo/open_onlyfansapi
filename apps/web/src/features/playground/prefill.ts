import { readStored, writeStored } from '@/lib/storage';
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

/**
 * `base` with `rows` on top: each row takes the place of the first base row with its key not taken yet; the others
 * are appended in order.
 */
export function overlayRows(base: Row[], rows: Row[]): Row[] {
  const out = [...base];
  const taken = new Set<number>();
  for (const row of rows) {
    const i = base.findIndex((r, j) => r.key === row.key && !taken.has(j));
    if (i < 0) out.push(row);
    else {
      taken.add(i);
      out[i] = row;
    }
  }
  return out;
}

/** What is remembered per operation: only what differs from the defaults, so date ranges stay fresh. */
type Saved = { params: Record<string, string>; query: Row[]; body?: string };

const isString = (v: unknown): v is string => typeof v === 'string';
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);
const isRow = (v: unknown): v is Row => isObject(v) && isString(v.key) && isString(v.value);
const isSaved = (v: unknown): v is Saved =>
  isObject(v) &&
  isObject(v.params) &&
  Object.values(v.params).every(isString) &&
  Array.isArray(v.query) &&
  v.query.every(isRow) &&
  (v.body === undefined || isString(v.body));

const opKey = (id: string) => `gateway.playground.op.${id}`;
const RECENT_KEY = 'gateway.playground.recent';
const ACCOUNT_KEY = 'gateway.playground.account';
const RECENT_MAX = 8;

/** `op`'s defaults with the values last sent for it on top. */
export function initialDraft(op: Op): Draft {
  const draft = defaultDraft(op);
  const saved = readStored(opKey(op.id), isSaved);
  if (!saved) return draft;
  return { ...draft, params: saved.params, query: overlayRows(draft.query, saved.query), body: saved.body ?? draft.body };
}

/** Remembers the values `draft` sends for `op` that differ from its defaults. */
export function rememberDraft(op: Op, draft: Draft) {
  const defaults = defaultDraft(op);
  const params = Object.fromEntries(Object.entries(draft.params).filter(([, v]) => v));
  // Each row lands on the default it overrides (same index) or past the defaults; only changed ones are kept.
  const rows = overlayRows(defaults.query, draft.query.filter((row) => row.key));
  const query = rows.filter((row, i) => row.value !== defaults.query[i]?.value);
  const body = draft.body !== defaults.body ? draft.body : undefined;
  const empty = Object.keys(params).length === 0 && query.length === 0 && body === undefined;
  writeStored(opKey(op.id), empty ? null : { params, query, body });
}

export function forgetDraft(op: Op) {
  writeStored(opKey(op.id), null);
}

/** The last used operation ids, most recent first. */
export function recentOps(): string[] {
  return readStored(RECENT_KEY, isStrings) ?? [];
}

export function pushRecent(id: string): string[] {
  const ids = [id, ...recentOps().filter((r) => r !== id)].slice(0, RECENT_MAX);
  writeStored(RECENT_KEY, ids);
  return ids;
}

export function lastAccount(): string {
  return readStored(ACCOUNT_KEY, isString) ?? '';
}

export function rememberAccount(id: string) {
  writeStored(ACCOUNT_KEY, id || null);
}

/** The account to preselect: the only one, else the last used if still listed, else the first. */
export function pickAccount(ids: string[], last: string): string {
  if (ids.length === 1) return ids[0]!;
  return ids.includes(last) ? last : (ids[0] ?? '');
}
