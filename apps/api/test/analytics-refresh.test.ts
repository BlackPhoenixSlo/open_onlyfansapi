import { setTimeout as sleep } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { db, pool } from '../src/db/index.js';
import { accountWorkspace, purchaseFact } from '../src/db/schema.js';
import { envSchema } from '../src/env.js';
import { pollTransactions, refreshDue } from '../src/jobs/analytics-refresh.js';
import { createUpstream, type Upstream } from '../src/lib/upstream.js';
import { backfillRun } from '../src/modules/analytics/backfill-runs.js';
import { nextRefresh, refreshBoundary } from '../src/modules/analytics/refresh.js';
import { assignAccount } from '../src/modules/analytics/workspace.js';
import { startFakeUpstream } from './fake-upstream.js';
import { linkTeam, resetDb, signUp } from './helpers.js';

// The jobs are tested by calling them: RUN_JOBS is false in tests, so no job ticks, and every OF call goes to the fake upstream.
const TOKEN = 'test-only-upstream-token';
const ACCOUNTS = [1001, 1002, 1003];
const NOW = new Date('2026-09-10T12:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const app = await buildApp({ logger: false });
const fake = await startFakeUpstream(TOKEN);
const upstream = createUpstream({ url: fake.url, token: TOKEN, timeoutMs: 2000 });
const log = () => ({ error: vi.fn() }) as unknown as FastifyBaseLogger & { error: ReturnType<typeof vi.fn> };

const tx = (id: string, hoursAgo: number, fan = 2001) => ({
  id,
  descriptionDetails: { type: 'message' },
  amount: 10,
  net: 8,
  currency: 'USD',
  status: 'done',
  createdAt: new Date(NOW.getTime() - hoursAgo * HOUR).toISOString(),
  user: { id: fan },
});
/** `/of` GETs the fake upstream got since `start`. */
const ofCalls = (start: number) => fake.requests.slice(start).map((r) => r.url).filter((u) => u.startsWith('/of/'));

let teamId: string;
beforeAll(async () => {
  await resetDb();
  await pool.query('TRUNCATE account_workspace, message_fact, chat_coverage, purchase_fact');
  teamId = (await signUp(app, 'refresh@example.test')).teamId;
  await linkTeam(teamId);
  for (const id of ACCOUNTS) await assignAccount(teamId, id);
});
beforeEach(async () => {
  await pool.query('TRUNCATE purchase_fact');
  fake.state.of = {
    chats: [],
    messages: {},
    mass: [],
    welcome: null,
    // Newest first, as OF lists them: two in the last 48 hours, one just before.
    transactions: [tx('tx3', 1), tx('tx2', 47), tx('tx1', 49)],
  };
});
afterAll(async () => {
  await app.close();
  await fake.close();
  await pool.end();
});

describe('STATS_REFRESH_HOUR_UTC', () => {
  const parse = (v: string | undefined) => envSchema.safeParse({ ...process.env, STATS_REFRESH_HOUR_UTC: v });
  it('is off when unset, empty or blank, an hour 0 to 23 when set, and refuses anything else', () => {
    expect(parse(undefined).data?.STATS_REFRESH_HOUR_UTC).toBeUndefined();
    expect(parse('').data?.STATS_REFRESH_HOUR_UTC).toBeUndefined();
    expect(parse('  ').data?.STATS_REFRESH_HOUR_UTC).toBeUndefined(); // not hour 0
    expect(parse(' 3 ').data?.STATS_REFRESH_HOUR_UTC).toBe(3);
    expect(parse('0').data?.STATS_REFRESH_HOUR_UTC).toBe(0);
    expect(parse('23').data?.STATS_REFRESH_HOUR_UTC).toBe(23);
    for (const bad of ['24', '-1', '3.5', 'three']) expect(parse(bad).success).toBe(false);
  });
});

describe('next refresh time', () => {
  it('is today\'s refresh hour UTC until it passes, then tomorrow\'s; null when the refresh is off', () => {
    expect(nextRefresh(3, new Date('2026-10-08T02:59:59.000Z'))?.toISOString()).toBe('2026-10-08T03:00:00.000Z');
    expect(nextRefresh(3, new Date('2026-10-08T03:00:00.000Z'))?.toISOString()).toBe('2026-10-09T03:00:00.000Z');
    expect(nextRefresh(0, new Date('2026-12-31T23:00:00.000Z'))?.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(nextRefresh(undefined, new Date())).toBeNull();
  });
});

describe('hourly transactions poll', () => {
  it('reads the last 48 hours of each claimed account in one request each and upserts them', async () => {
    const start = fake.requests.length;
    expect(await pollTransactions(upstream, log(), NOW)).toBe(6);
    expect(ofCalls(start)).toEqual(
      ACCOUNTS.map(() => `/of/payouts/transactions?limit=100&offset=0&startDate=${encodeURIComponent('2026-09-08 12:00:00')}`),
    );
    const rows = await db.select({ accountId: purchaseFact.accountId, txId: purchaseFact.txId, teamId: purchaseFact.teamId }).from(purchaseFact);
    expect(rows.map((r) => `${r.accountId}:${r.txId}`).sort()).toEqual(['1001:tx2', '1001:tx3', '1002:tx2', '1002:tx3', '1003:tx2', '1003:tx3']);
    expect(rows.every((r) => r.teamId === teamId)).toBe(true);

    // The next tick upserts: no double count.
    expect(await pollTransactions(upstream, log(), NOW)).toBe(6);
    expect(await db.$count(purchaseFact)).toBe(6);
  });

  it('logs an account that fails and still polls the others', async () => {
    const failing: Upstream = {
      ...upstream,
      forward: async (req) =>
        req.accountId === 1001 ? { status: 401, ok: false, headers: new Headers(), body: Buffer.from('{}') } : upstream.forward(req),
    };
    const spy = log();
    expect(await pollTransactions(failing, spy, NOW)).toBe(4);
    expect(spy.error).toHaveBeenCalledTimes(1);
    expect(spy.error.mock.calls[0]![0]).toMatchObject({ accountId: 1001 });
    expect(await db.$count(purchaseFact)).toBe(4);
  });
});

describe('daily refresh', () => {
  const setRefreshed = (accountId: number, at: Date | null) => db.update(accountWorkspace).set({ refreshedAt: at }).where(eq(accountWorkspace.accountId, accountId));
  const run = (accountId: number) => backfillRun(teamId, accountId);
  /** Waits until no run of ACCOUNTS is queued or running. */
  async function settle() {
    while (ACCOUNTS.some((id) => ['queued', 'running'].includes(run(id).status))) await sleep(20);
  }
  // Real time: a started run reads mass history up to the real now. The refresh hour is the current UTC hour, so
  // today's refresh time has passed.
  const at = (t: Date) => ({ t, h: t.getUTCHours() });

  it('starts one run per due account (null or before today\'s refresh time), none for the others, and does not wait for them', async () => {
    const { t, h } = at(new Date());
    const boundary = refreshBoundary(t, h);
    await setRefreshed(1001, null);
    await setRefreshed(1002, new Date(boundary.getTime() + 1000)); // refreshed today: not due
    await setRefreshed(1003, new Date(t.getTime() - 2 * DAY)); // two days ago: from an hour before that
    const before = run(1002);
    expect(await refreshDue(upstream, log(), h, t)).toBe(2);
    // Returned with the runs still queued or running: the job never awaits a run.
    expect(['queued', 'running']).toContain(run(1001).status);
    expect(run(1001)).toMatchObject({ from: new Date(t.getTime() - 7 * DAY).toISOString() });
    expect(run(1003)).toMatchObject({ from: new Date(t.getTime() - 2 * DAY - HOUR).toISOString() });
    expect(run(1002)).toEqual(before);
    // A tick while they run starts nothing more.
    expect(await refreshDue(upstream, log(), h, t)).toBe(0);
    await settle();
    expect([run(1001).status, run(1003).status]).toEqual(['done', 'done']);
    // Each run read up to its start and ran to its end, so refreshed_at moved to its start: no account is due until tomorrow.
    const rows = (await db.select().from(accountWorkspace)).filter((r) => r.accountId !== 1002);
    expect(rows).toHaveLength(2);
    for (const { refreshedAt } of rows) expect(refreshedAt!.getTime()).toBeGreaterThanOrEqual(t.getTime());
    expect(await refreshDue(upstream, log(), h, new Date())).toBe(0);
  });

  it('starts nothing before today\'s refresh time', async () => {
    await setRefreshed(1001, null);
    const before = run(1001);
    expect(await refreshDue(upstream, log(), 5, new Date('2026-09-10T04:59:59.000Z'))).toBe(0);
    expect(run(1001)).toEqual(before);
  });

  it('tries an account once a day: a failed run (here a dead session) is tried again the next day', async () => {
    // A clock of its own, days ahead (the runs' startedAt included): earlier tests already ran these accounts today.
    const day1 = new Date(refreshBoundary(new Date(), 5, 2).getTime() + 30 * 60_000);
    const day2 = new Date(day1.getTime() + DAY);
    vi.setSystemTime(day1);
    for (const id of ACCOUNTS) await setRefreshed(id, id === 1001 ? null : day1);
    fake.state.of!.unauthorized = true;
    try {
      expect(await refreshDue(upstream, log(), 5, day1)).toBe(1);
      await settle();
      expect(run(1001)).toMatchObject({ status: 'error', errorCode: 'session_expired', startedAt: day1.toISOString() });
      const requests = fake.requests.length;
      expect(await refreshDue(upstream, log(), 5, new Date(day2.getTime() - 31 * 60_000))).toBe(0); // later that day
      expect(fake.requests.length).toBe(requests);
      // The next day's refresh time: tried again (1002 and 1003, refreshed the day before, are due again too).
      vi.setSystemTime(day2);
      expect(await refreshDue(upstream, log(), 5, day2)).toBe(3);
      await settle();
      expect(run(1001)).toMatchObject({ status: 'error', errorCode: 'session_expired', startedAt: day2.toISOString() });
    } finally {
      fake.state.of!.unauthorized = false;
      vi.useRealTimers();
    }
  });
});
