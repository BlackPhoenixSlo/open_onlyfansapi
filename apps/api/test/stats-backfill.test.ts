import { setTimeout as sleep } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { db, pool } from '../src/db/index.js';
import { accountWorkspace, messageFact } from '../src/db/schema.js';
import { startFakeUpstream, type FakeOf } from './fake-upstream.js';
import { bearer, createKey, dashboard, linkTeam, resetDb, signUp } from './helpers.js';

const TOKEN = 'test-only-upstream-token';
const ACCOUNT = 1001;
const HOUR = 3_600_000;

const fake = await startFakeUpstream(TOKEN, [{ id: ACCOUNT, label: null, ofUsername: 'demo', ofDisplayName: 'Demo', ofAvatarUrl: null, status: 'active' }]);
const app = await buildApp({ logger: false, upstreamUrl: fake.url });

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const msg = (id: number, createdAt: string, from: number) => ({ id, createdAt, fromUser: { id: from }, text: `<p>text ${id}</p>`, price: 0, isTip: false, mediaCount: 0, media: [], queueId: null });

/** One chat with a fan message and its reply in the last day; the first request answers 429 (Retry-After 1 s), so the run is still going when the test posts again. */
function ofData(): FakeOf {
  const messages = { 2001: [msg(102, ago(HOUR), ACCOUNT), msg(101, ago(2 * HOUR), 2001)] };
  return {
    chats: [{ withUser: { id: 2001, username: 'fan_one' }, lastMessage: { id: 102, createdAt: messages[2001][0]!.createdAt } }],
    messages,
    mass: [],
    transactions: [],
    welcome: null,
    rateLimit: 1,
    retryAfter: '1',
  };
}

let owner: { cookie: string; teamId: string };
let other: { cookie: string; teamId: string };

const post = (headers: Record<string, string>, payload: unknown) => app.inject({ method: 'POST', url: '/v1/stats/backfill', headers, payload: payload as object });
const status = (headers: Record<string, string>, accountId = ACCOUNT) => app.inject({ method: 'GET', url: `/v1/stats/backfill?accountId=${accountId}`, headers });
/** Polls the owner's run of ACCOUNT until it is neither queued nor running. */
async function waitForRun() {
  for (;;) {
    const run = (await status(dashboard(owner.cookie))).json();
    if (run.status !== 'queued' && run.status !== 'running') return run;
    await sleep(100);
  }
}

beforeAll(async () => {
  await resetDb();
  await pool.query('TRUNCATE account_workspace, message_fact, chat_coverage, purchase_fact');
  owner = await signUp(app, 'backfill-owner@example.test');
  other = await signUp(app, 'backfill-other@example.test');
  await linkTeam(owner.teamId);
  await linkTeam(other.teamId);
  fake.state.of = ofData();
});
afterAll(async () => {
  await app.close();
  await fake.close();
  await pool.end();
});

describe('POST /v1/stats/backfill', () => {
  it('claims a connected account for the session workspace, runs in the background to done, and refuses a second run meanwhile', async () => {
    expect((await status(dashboard(owner.cookie))).json()).toEqual({ status: 'idle' });

    const res = await post(dashboard(owner.cookie), { accountId: ACCOUNT, days: 1 });
    expect(res.statusCode).toBe(202);
    const { runId } = res.json();
    expect(runId).toMatch(/^bfr_/);
    expect(await db.select().from(accountWorkspace).where(eq(accountWorkspace.accountId, ACCOUNT))).toMatchObject([{ teamId: owner.teamId }]);

    const again = await post(dashboard(owner.cookie), { accountId: ACCOUNT });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('backfill_running');

    const pending = (await status(dashboard(owner.cookie))).json();
    expect(pending).toMatchObject({ runId, accountId: ACCOUNT, finishedAt: null, error: null });
    expect(['queued', 'running']).toContain(pending.status);
    expect(Date.parse(pending.to) - Date.parse(pending.from)).toBe(24 * HOUR);

    const run = await waitForRun();
    expect(run).toMatchObject({ status: 'done', runId, retries: 0, chats: 1, messages: 2, error: null });
    expect(run.requests).toBeGreaterThan(4);
    expect(run.finishedAt).not.toBeNull();
    expect(await db.$count(messageFact, eq(messageFact.teamId, owner.teamId))).toBe(2);
  });

  it('retries a transient 502 and records it on the run', async () => {
    fake.state.of = { ...ofData(), rateLimit: 0, badGateway: 1 };
    expect((await post(dashboard(owner.cookie), { accountId: ACCOUNT, days: 1 })).statusCode).toBe(202);
    expect(await waitForRun()).toMatchObject({ status: 'done', retries: 1, chats: 1, messages: 2, error: null });
  });

  it('404s an account the workspace has not connected, 403s one outside a key allowlist or with a read key', async () => {
    const unknown = await post(dashboard(owner.cookie), { accountId: 9999 });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('not_found');

    const limited = (await createKey(app, owner.cookie, { scope: 'write', allowedAccountIds: [ACCOUNT] })).secret;
    const outside = await post(bearer(limited), { accountId: 2002 });
    expect(outside.statusCode).toBe(403);
    expect(outside.json().error.code).toBe('account_not_allowed');
    expect((await status(bearer(limited), 2002)).statusCode).toBe(403);
    expect((await status(bearer(limited))).json()).toMatchObject({ status: 'done' });

    const read = (await createKey(app, owner.cookie, { scope: 'read' })).secret;
    const readOnly = await post(bearer(read), { accountId: ACCOUNT });
    expect(readOnly.statusCode).toBe(403);
    expect(readOnly.json().error.code).toBe('insufficient_scope');
  });

  it("409s an account another workspace claimed, and does not show that workspace's run", async () => {
    const res = await post(dashboard(other.cookie), { accountId: ACCOUNT });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('account_workspace_conflict');
    expect((await status(dashboard(other.cookie))).json()).toEqual({ status: 'idle' });
  });

  it('records an expired OF session on the run', async () => {
    fake.state.of = { ...ofData(), rateLimit: 0, unauthorized: true };
    expect((await post(dashboard(owner.cookie), { accountId: ACCOUNT, days: 1 })).statusCode).toBe(202);
    expect(await waitForRun()).toMatchObject({
      status: 'error',
      errorCode: 'session_expired',
      error: `OF session of account ${ACCOUNT} expired: re-connect it in Accounts, then run the backfill again`,
    });
  });

  it('counts a chat OF refuses as failed on a run that ends done', async () => {
    fake.state.of = { ...ofData(), rateLimit: 0, deadSession: true };
    expect((await post(dashboard(owner.cookie), { accountId: ACCOUNT, days: 1 })).statusCode).toBe(202);
    expect(await waitForRun()).toMatchObject({ status: 'done', chats: 0, failedChats: 1, error: null, errorCode: null });
  });

  it('ends the run session_expired when OF refuses 5 chats in a row', async () => {
    const data = ofData();
    for (const id of [2002, 2003, 2004, 2005, 2006]) data.chats.push({ withUser: { id, username: `fan_${id}` }, lastMessage: { id: id * 10, createdAt: ago(HOUR) } });
    fake.state.of = { ...data, rateLimit: 0, deadSession: true };
    expect((await post(dashboard(owner.cookie), { accountId: ACCOUNT, days: 1 })).statusCode).toBe(202);
    const run = await waitForRun();
    expect(run).toMatchObject({ status: 'error', errorCode: 'session_expired', chats: 0, failedChats: 5 });
    expect(run.error).toContain('re-connect it in Accounts');
  });
});
