import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/index.js';
import { startFakeUpstream } from './fake-upstream.js';
import { bearer, createKey, dashboard, linkTeam, resetDb, signUp } from './helpers.js';

const TOKEN = process.env.UPSTREAM_TOKEN!;
// One upstream token means one upstream tenant: every linked workspace sees the same accounts.
const upstream = await startFakeUpstream(TOKEN, [
  { id: 100, label: 'A', ofUsername: 'a', ofDisplayName: 'A', ofAvatarUrl: null, status: 'active' },
  { id: 200, label: 'B', ofUsername: 'b', ofDisplayName: 'B', ofAvatarUrl: null, status: 'active' },
]);
const app = await buildApp({ logger: false, upstreamUrl: upstream.url });

let a: Awaited<ReturnType<typeof signUp>>;
let b: Awaited<ReturnType<typeof signUp>>;
let aKey: string;
let bKey: string;
let bKeyId: string;

beforeAll(async () => {
  await resetDb();
  a = await signUp(app, 'a@example.test');
  b = await signUp(app, 'b@example.test');
  // Only A is linked; B stands in for a workspace the operator has not approved.
  await linkTeam(a.teamId);
  aKey = (await createKey(app, a.cookie, { name: 'a-read', scope: 'read' })).secret;
  const bCreated = await createKey(app, b.cookie, { name: 'b-key', scope: 'write' });
  bKey = bCreated.secret;
  bKeyId = bCreated.key.id;
});
afterAll(async () => {
  await app.close();
  await upstream.close();
  await pool.end();
});

describe('tenant isolation', () => {
  it('each sign-up gets its own workspace', () => {
    expect(a.teamId).not.toBe(b.teamId);
  });

  it("workspace A's session cannot list, edit or revoke workspace B's keys", async () => {
    const list = await app.inject({ method: 'GET', url: '/api/keys', headers: { cookie: a.cookie } });
    expect(list.json().items.map((k: { name: string }) => k.name)).toEqual(['a-read']);
    const patch = await app.inject({ method: 'PATCH', url: `/api/keys/${bKeyId}`, headers: dashboard(a.cookie), payload: { name: 'pwned' } });
    expect(patch.statusCode).toBe(404);
    const del = await app.inject({ method: 'DELETE', url: `/api/keys/${bKeyId}`, headers: dashboard(a.cookie) });
    expect(del.statusCode).toBe(404);
    const bList = await app.inject({ method: 'GET', url: '/api/keys', headers: { cookie: b.cookie } });
    expect(bList.json().items).toMatchObject([{ id: bKeyId, name: 'b-key', revokedAt: null }]);
  });

  it('an API key cannot use the dashboard key management', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/keys', headers: bearer(aKey) })).statusCode).toBe(401);
  });

  it("a linked workspace's key reaches the upstream with the gateway's own token", async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/accounts', headers: bearer(aKey) });
    expect(res.json().items.map((x: { id: number }) => x.id)).toEqual([100, 200]);
    expect(upstream.requests.at(-1)!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const who = await app.inject({ method: 'GET', url: '/v1/whoami', headers: bearer(aKey) });
    expect(who.json().team).toMatchObject({ id: a.teamId, linked: true });
  });

  it('an unlinked workspace gets 409 team_not_linked and no upstream request is made', async () => {
    const before = upstream.requests.length;
    for (const url of ['/v1/accounts', '/v1/100/users/me']) {
      const res = await app.inject({ method: 'GET', url, headers: bearer(bKey) });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('team_not_linked');
    }
    expect(upstream.requests.length).toBe(before);
    const who = await app.inject({ method: 'GET', url: '/v1/whoami', headers: bearer(bKey) });
    expect(who.json().team).toMatchObject({ id: b.teamId, linked: false });
  });

  it('a read key cannot write on any method', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await app.inject({ method, url: '/v1/100/posts/1', headers: bearer(aKey) });
      expect(res.statusCode).toBe(403);
    }
  });
});
