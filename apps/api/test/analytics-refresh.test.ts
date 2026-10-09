import type { FastifyBaseLogger } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { db, pool } from '../src/db/index.js';
import { purchaseFact } from '../src/db/schema.js';
import { envSchema } from '../src/env.js';
import { pollTransactions } from '../src/jobs/analytics-refresh.js';
import { createUpstream, type Upstream } from '../src/lib/upstream.js';
import { assignAccount } from '../src/modules/analytics/workspace.js';
import { startFakeUpstream } from './fake-upstream.js';
import { linkTeam, resetDb, signUp } from './helpers.js';

// The jobs are tested by calling them: RUN_JOBS is false in tests, so no job ticks, and every OF call goes to the fake upstream.
const TOKEN = 'test-only-upstream-token';
const ACCOUNTS = [1001, 1002];
const NOW = new Date('2026-09-10T12:00:00.000Z');
const HOUR = 3_600_000;

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
  it('is off when unset or empty, an hour 0 to 23 when set, and refuses anything else', () => {
    expect(parse(undefined).data?.STATS_REFRESH_HOUR_UTC).toBeUndefined();
    expect(parse('').data?.STATS_REFRESH_HOUR_UTC).toBeUndefined();
    expect(parse('0').data?.STATS_REFRESH_HOUR_UTC).toBe(0);
    expect(parse('23').data?.STATS_REFRESH_HOUR_UTC).toBe(23);
    for (const bad of ['24', '-1', '3.5', 'three']) expect(parse(bad).success).toBe(false);
  });
});

describe('hourly transactions poll', () => {
  it('reads the last 48 hours of each claimed account in one request each and upserts them', async () => {
    const start = fake.requests.length;
    expect(await pollTransactions(upstream, log(), NOW)).toBe(4);
    expect(ofCalls(start)).toEqual(
      ACCOUNTS.map(() => `/of/payouts/transactions?limit=100&offset=0&startDate=${encodeURIComponent('2026-09-08 12:00:00')}`),
    );
    const rows = await db.select({ accountId: purchaseFact.accountId, txId: purchaseFact.txId, teamId: purchaseFact.teamId }).from(purchaseFact);
    expect(rows.map((r) => `${r.accountId}:${r.txId}`).sort()).toEqual(['1001:tx2', '1001:tx3', '1002:tx2', '1002:tx3']);
    expect(rows.every((r) => r.teamId === teamId)).toBe(true);

    // The next tick upserts: no double count.
    expect(await pollTransactions(upstream, log(), NOW)).toBe(4);
    expect(await db.$count(purchaseFact)).toBe(4);
  });

  it('logs an account that fails and still polls the others', async () => {
    const failing: Upstream = {
      ...upstream,
      forward: async (req) =>
        req.accountId === 1001 ? { status: 401, ok: false, headers: new Headers(), body: Buffer.from('{}') } : upstream.forward(req),
    };
    const spy = log();
    expect(await pollTransactions(failing, spy, NOW)).toBe(2);
    expect(spy.error).toHaveBeenCalledTimes(1);
    expect(spy.error.mock.calls[0]![0]).toMatchObject({ accountId: 1001 });
    expect(await db.$count(purchaseFact)).toBe(2);
  });
});
