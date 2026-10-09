import type { StatsBackfillRun } from '../../contracts.js';
import { newId } from '../../lib/ids.js';
import type { Upstream } from '../../lib/upstream.js';
import { dbStore } from './backfill-store.js';
import { backfill, BackfillRunningError, SessionExpiredError, type BackfillResult } from './backfill.js';

/**
 * Dashboard backfill runs (`POST /v1/stats/backfill`), the last one per account. In memory only: an API restart
 * loses the state, and a run in flight ends with the process (the rows it stored stay; run it again, rows upsert).
 */
type Run = {
  teamId: string;
  runId: string;
  accountId: number;
  from: Date;
  /** When the run was asked for; it reads up to when it starts (later, if it was queued). */
  startedAt: Date;
  finishedAt: Date | null;
  status: 'queued' | 'running' | 'done' | 'error';
  /** The backfill's counts so far (its result once done); null until its first request. */
  progress: Readonly<BackfillResult> | null;
  error: string | null;
  errorCode: 'session_expired' | null;
};

const runs = new Map<number, Run>();

/** The account's last run if it belongs to `teamId`, else `idle`. */
export function backfillRun(teamId: string, accountId: number): StatsBackfillRun {
  const run = runs.get(accountId);
  if (!run || run.teamId !== teamId) return { status: 'idle' };
  const { progress } = run;
  return {
    status: run.status,
    runId: run.runId,
    accountId: run.accountId,
    from: run.from.toISOString(),
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    requests: progress?.requests ?? 0,
    retries: progress?.retries ?? 0,
    chats: progress?.chats ?? 0,
    messages: progress?.messages ?? 0,
    failedChats: progress?.failedChats.length ?? 0,
    error: run.error,
    errorCode: run.errorCode,
  };
}

/** 409 `backfill_running` while the account's last run is queued or running. */
export function assertBackfillIdle(accountId: number): void {
  const status = runs.get(accountId)?.status;
  if (status === 'queued' || status === 'running') {
    throw new BackfillRunningError(accountId);
  }
}

/**
 * Starts a backfill of an account the caller already assigned to `teamId` (`assignAccount`), without CSVs, from
 * `from` up to when it starts, so its end moves `refreshed_at`. It is `queued` until the process-wide
 * one-account-at-a-time limiter lets it run. 409 `backfill_running` while the account's previous run is queued or
 * running.
 */
export function startBackfillRun(opts: { upstream: Upstream; teamId: string; accountId: number; from: Date }): string {
  const { upstream, teamId, accountId, from } = opts;
  assertBackfillIdle(accountId);
  const run: Run = {
    teamId,
    runId: newId('bfr'),
    accountId,
    from,
    startedAt: new Date(),
    finishedAt: null,
    status: 'queued',
    progress: null,
    error: null,
    errorCode: null,
  };
  runs.set(accountId, run);
  backfill({
    upstream,
    accountId,
    from,
    store: dbStore(teamId, accountId),
    onProgress: (r) => {
      run.progress = r;
      run.status = 'running';
    },
  }).then(
    (r) => {
      run.progress = r;
      run.status = 'done';
      run.finishedAt = new Date();
    },
    (err: unknown) => {
      run.status = 'error';
      run.error = err instanceof Error ? err.message : String(err);
      run.errorCode = err instanceof SessionExpiredError ? 'session_expired' : null;
      run.finishedAt = new Date();
    },
  );
  return run.runId;
}
