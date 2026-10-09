import type { FastifyBaseLogger } from 'fastify';
import { db } from '../db/index.js';
import { accountWorkspace } from '../db/schema.js';
import { newId } from '../lib/ids.js';
import type { Upstream } from '../lib/upstream.js';
import { backfillRun, startBackfillRun } from '../modules/analytics/backfill-runs.js';
import { dbStore, readTransactions, type Get } from '../modules/analytics/backfill.js';
import { refreshBoundary } from '../modules/analytics/refresh.js';
import { DAY_MS } from '../modules/stats/scope.js';

const HOUR_MS = 3_600_000;
/** The daily refresh's longest window. */
const REFRESH_MAX_MS = 7 * DAY_MS;
/** The poll's window: OF's ledger lagged real time by 3.5 to 10.5 hours, so a sale shows up well within it. */
const POLL_WINDOW_MS = 48 * HOUR_MS;

/** A plain GET of the account through the upstream: no pacing, retry or backoff (the poll runs once an hour). */
const plainGet =
  (upstream: Upstream, accountId: number): Get =>
  async (path) => {
    const out = await upstream.forward({ accountId, path, method: 'GET', headers: { accept: 'application/json', 'x-request-id': newId('req') } });
    if (!out.ok) throw new Error(`transactions poll: the upstream answered ${out.status} to GET ${path}`);
    return JSON.parse(out.body.toString('utf8')) as unknown;
  };

/**
 * The hourly transactions poll (docs/analytics.md, Keeping it fresh): for each claimed account (`account_workspace`),
 * the transactions of the last 48 hours, read and upserted into `purchase_fact` as the backfill does
 * (`readTransactions`): one request an account, more only when those hours hold over 100 transactions. An account
 * that fails is logged and the others still run. Returns the rows stored.
 */
export async function pollTransactions(upstream: Upstream, log: FastifyBaseLogger, now = new Date()): Promise<number> {
  let stored = 0;
  for (const { accountId, teamId } of await db.select().from(accountWorkspace)) {
    try {
      await readTransactions(plainGet(upstream, accountId), dbStore(teamId, accountId), now.getTime() - POLL_WINDOW_MS, now.getTime(), (rows) => {
        stored += rows.length;
      });
    } catch (err) {
      log.error({ err, accountId }, 'transactions poll failed');
    }
  }
  return stored;
}

/**
 * The daily refresh (docs/analytics.md, Keeping it fresh), ticked hourly: once `now` is past today's `hour`:00 UTC,
 * each claimed account whose `refreshed_at` is null or before it gets one backfill from max(now - 7 days,
 * refreshed_at - 1 hour) to now, started like the dashboard's (`startBackfillRun`: queued behind the one-at-a-time
 * limiter, its status on the Accounts page) and never awaited here. Skipped: an account whose run is queued or running,
 * and one whose last run (since the API started: the state is in memory) ended `session_expired` after today's
 * refresh time, until tomorrow's. Returns the runs started.
 */
export async function refreshDue(upstream: Upstream, log: FastifyBaseLogger, hour: number, now = new Date()): Promise<number> {
  const boundary = refreshBoundary(now, hour).getTime();
  if (now.getTime() < boundary) return 0;
  let started = 0;
  for (const { accountId, teamId, refreshedAt } of await db.select().from(accountWorkspace)) {
    if (refreshedAt && refreshedAt.getTime() >= boundary) continue;
    const last = backfillRun(teamId, accountId);
    if (last.status === 'queued' || last.status === 'running') continue;
    if (last.status === 'error' && last.errorCode === 'session_expired' && Date.parse(last.finishedAt ?? '') >= boundary) continue;
    const from = Math.max(now.getTime() - REFRESH_MAX_MS, (refreshedAt?.getTime() ?? -Infinity) - HOUR_MS);
    try {
      startBackfillRun({ upstream, teamId, accountId, from: new Date(from), to: now });
      started++;
    } catch (err) {
      log.error({ err, accountId }, 'stats refresh failed to start');
    }
  }
  return started;
}
