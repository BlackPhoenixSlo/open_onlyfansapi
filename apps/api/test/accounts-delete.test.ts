import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/index.js';
import { claimAccount } from '../src/modules/accounts/ownership.js';
import { startFakeUpstream } from './fake-upstream.js';
import { bearer, createKey, dashboard, linkTeam, resetDb, signUp } from './helpers.js';

const TOKEN = process.env.UPSTREAM_TOKEN!;
const upstream = await startFakeUpstream(TOKEN, [
  { id: 2001, label: 'Gone', ofUsername: 'gone', ofDisplayName: 'Gone', ofAvatarUrl: null, status: 'active' },
  { id: 2002, label: 'Kept', ofUsername: 'kept', ofDisplayName: 'Kept', ofAvatarUrl: null, status: 'active' },
]);
const app = await buildApp({ logger: false, upstreamUrl: upstream.url });

let linked: Awaited<ReturnType<typeof signUp>>;
let unlinked: Awaited<ReturnType<typeof signUp>>;
let other: Awaited<ReturnType<typeof signUp>>;
let key: string;

beforeAll(async () => {
  await resetDb();
  linked = await signUp(app, 'delete@example.test');
  unlinked = await signUp(app, 'unlinked-delete@example.test');
  other = await signUp(app, 'other-delete@example.test');
  await linkTeam(linked.teamId);
  await linkTeam(other.teamId);
  await claimAccount(linked.teamId, 2001);
  await claimAccount(linked.teamId, 2002);
  key = (await createKey(app, linked.cookie, { scope: 'write' })).secret;
});
afterAll(async () => {
  await app.close();
  await upstream.close();
  await pool.end();
});

const remove = (headers: Record<string, string>, id: number | string) =>
  app.inject({ method: 'DELETE', url: `/api/accounts/${id}`, headers });

describe('DELETE /api/accounts/:id', () => {
  it("rejects a bad id, an unlinked workspace, another workspace's account, missing CSRF and API keys without calling the upstream", async () => {
    const before = upstream.requests.length;
    expect((await remove(dashboard(linked.cookie), 'abc')).statusCode).toBe(400);
    expect((await remove(dashboard(other.cookie), 2001)).json().error.code).toBe('account_not_allowed');
    expect((await remove(dashboard(unlinked.cookie), 2001)).json().error.code).toBe('team_not_linked');
    expect((await remove({ cookie: linked.cookie }, 2001)).json().error.code).toBe('csrf_failed');
    expect((await remove(bearer(key), 2001)).statusCode).toBe(401);
    expect(upstream.requests.length).toBe(before);
  });

  it('forwards to the upstream with its token, answers 204, and the account leaves the list', async () => {
    const res = await remove(dashboard(linked.cookie), 2001);
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    const call = upstream.requests.filter((r) => r.url === '/of-accounts/2001').at(-1)!;
    expect(call.method).toBe('DELETE');
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const list = await app.inject({ method: 'GET', url: '/v1/accounts', headers: bearer(key) });
    expect(list.json().items.map((a: { id: number }) => a.id)).toEqual([2002]);
  });

  it("passes the upstream's 404 through unchanged (the workspace still owns the account's history)", async () => {
    const res = await remove(dashboard(linked.cookie), 2001);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'account_not_found' } });
  });
});
