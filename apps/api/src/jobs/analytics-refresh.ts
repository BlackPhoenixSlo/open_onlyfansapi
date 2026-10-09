import type { FastifyBaseLogger } from 'fastify';
import { db } from '../db/index.js';
import { accountWorkspace } from '../db/schema.js';
import { newId } from '../lib/ids.js';
import type { Upstream } from '../lib/upstream.js';
import { dbStore, readTransactions, type Get } from '../modules/analytics/backfill.js';

const HOUR_MS = 3_600_000;
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
