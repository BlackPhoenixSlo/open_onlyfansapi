import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/index.js';
import { startFakeBackend } from './fake-backend.js';
import { bearer, createKey, dashboard, linkTeam, resetDb, signUp } from './helpers.js';

const backend = await startFakeBackend(process.env.BACKEND_JWT_SECRET!, {
  1: [{ id: 100, label: 'A', ofUsername: 'a', ofDisplayName: 'A', ofAvatarUrl: null, status: 'active' }],
  2: [{ id: 200, label: 'B', ofUsername: 'b', ofDisplayName: 'B', ofAvatarUrl: null, status: 'active' }],
});
const app = await buildApp({ logger: false, backendUrl: backend.url });

let a: Awaited<ReturnType<typeof signUp>>;
let b: Awaited<ReturnType<typeof signUp>>;
let aKey: string;
let bKeyId: string;

beforeAll(async () => {
  await resetDb();
  a = await signUp(app, 'a@example.test');
  b = await signUp(app, 'b@example.test');
  await linkTeam(a.teamId, 1);
  await linkTeam(b.teamId, 2);
  aKey = (await createKey(app, a.cookie, { name: 'a-read', scope: 'read' })).secret;
  bKeyId = (await createKey(app, b.cookie, { name: 'b-key', scope: 'write' })).key.id;
});
afterAll(async () => {
  await app.close();
  await backend.close();
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

  it("workspace A's key sees only A's accounts and acts as A's backend user", async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/accounts', headers: bearer(aKey) });
    expect(res.json().items.map((x: { id: number }) => x.id)).toEqual([100]);
    expect(backend.requests.at(-1)!.jwt.sub).toBe(1);
    const who = await app.inject({ method: 'GET', url: '/v1/whoami', headers: bearer(aKey) });
    expect(who.json().team).toMatchObject({ id: a.teamId, backendUserId: 1 });
    await app.inject({ method: 'GET', url: '/v1/200/users/me', headers: bearer(aKey) });
    expect(backend.requests.at(-1)!.jwt.sub).toBe(1);
  });

  it('a read key cannot write on any method', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await app.inject({ method, url: '/v1/100/posts/1', headers: bearer(aKey) });
      expect(res.statusCode).toBe(403);
    }
  });
});
