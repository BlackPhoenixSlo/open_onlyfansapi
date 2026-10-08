import type { StatsBackfillRun } from '../../contracts.js';
import { AppError } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import type { Upstream } from '../../lib/upstream.js';
import { backfill } from './backfill.js';

/**
 * Dashboard backfill runs (`POST /v1/stats/backfill`), the last one per account. In memory only: an API restart
 * loses the state, and a run in flight ends with the process (the rows it stored stay; run it again, rows upsert).
 */
type Run = {
  runId: string;
  teamId: string;
  accountId: number;
  status: 'queued' | 'running' | 'done' | 'error';
  from: Date;
  to: Date;
  startedAt: Date;
  finishedAt: Date | null;
  requests: number;
  chats: number;
  messages: number;
  error: string | null;
};

const runs = new Map<number, Run>();

/** The account's last run if it belongs to `teamId`, else `idle`. */
export function backfillRun(teamId: string, accountId: number): StatsBackfillRun {
  const run = runs.get(accountId);
  if (!run || run.teamId !== teamId) return { status: 'idle' };
  const { teamId: _t, from, to, startedAt, finishedAt, ...rest } = run;
  return { ...rest, from: from.toISOString(), to: to.toISOString(), startedAt: startedAt.toISOString(), finishedAt: finishedAt?.toISOString() ?? null };
}

/**
 * Starts a backfill of an account the caller already assigned to `teamId` (`assignAccount`), without CSVs. It is
 * `queued` until the process-wide one-account-at-a-time limiter lets it run. 409 `backfill_running` while the
 * account's previous run is queued or running.
 */
export function startBackfillRun(opts: { upstream: Upstream; teamId: string; accountId: number; from: Date; to: Date }): string {
  const { upstream, teamId, accountId, from, to } = opts;
  const current = runs.get(accountId);
  if (current?.status === 'queued' || current?.status === 'running') {
    throw new AppError(409, 'backfill_running', `A backfill of account ${accountId} is already running`);
  }
  const run: Run = {
    runId: newId('bfr'),
    teamId,
    accountId,
    status: 'queued',
    from,
    to,
    startedAt: new Date(),
    finishedAt: null,
    requests: 0,
    chats: 0,
    messages: 0,
    error: null,
  };
  runs.set(accountId, run);
  backfill({
    upstream,
    teamId,
    accountId,
    from,
    to,
    claimed: true,
    onProgress: (r) => Object.assign(run, { status: 'running', requests: r.requests, chats: r.chats, messages: r.messages }),
  }).then(
    (r) => Object.assign(run, { status: 'done', requests: r.requests, chats: r.chats, messages: r.messages, finishedAt: new Date() }),
    (err: unknown) => Object.assign(run, { status: 'error', error: err instanceof Error ? err.message : String(err), finishedAt: new Date() }),
  );
  return run.runId;
}
