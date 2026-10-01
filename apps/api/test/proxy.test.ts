import { createServer } from 'node:net';
import { createDecoder } from 'fast-jwt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/index.js';
import { resolveUpstream } from '../src/modules/proxy/routes.js';
import { startFakeBackend } from './fake-backend.js';
import { bearer, createKey, dashboard, linkTeam, resetDb, signUp, waitForLogs } from './helpers.js';

const BACKEND_USER = 4242;
const backend = await startFakeBackend(process.env.BACKEND_JWT_SECRET!, {
  [BACKEND_USER]: [
    { id: 12, label: 'Main', ofUsername: 'alpha', ofDisplayName: 'Alpha', ofAvatarUrl: null, status: 'active', egressPort: 9000, agencyId: 3, createdByUserId: 1 },
    { id: 13, label: null, ofUsername: 'beta', ofDisplayName: 'Beta', ofAvatarUrl: null, status: 'expired', egressPort: 9001, agencyId: 3, createdByUserId: 1 },
  ],
});
const app = await buildApp({ logger: false, backendUrl: backend.url });

let writeKey: string;
let readKey: string;
let limitedKey: string;
let cookie: string;
let userId: string;

beforeAll(async () => {
  await resetDb();
  const user = await signUp(app, 'proxy@example.test');
  cookie = user.cookie;
  userId = user.userId;
  await linkTeam(user.teamId, BACKEND_USER);
  writeKey = (await createKey(app, cookie, { scope: 'write' })).secret;
  readKey = (await createKey(app, cookie, { scope: 'read' })).secret;
  limitedKey = (await createKey(app, cookie, { scope: 'write', allowedAccountIds: [12] })).secret;
});
afterAll(async () => {
  await app.close();
  await backend.close();
  await pool.end();
});

const last = () => backend.requests.at(-1)!;

describe('proxy', () => {
  it('forwards method, path, query, body and headers; mints a JWT for the linked user', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/12/chats/1/messages?limit=5&a%20b=c',
      headers: { ...bearer(writeKey), 'content-type': 'application/json', 'x-of-cache': 'bypass' },
      payload: '{"text":"hi"}',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ echo: true, method: 'POST', url: '/of/chats/1/messages?limit=5&a%20b=c' });
    expect(res.headers['x-of-cache']).toBe('MISS');
    expect(res.headers['x-ratelimit-remaining']).toBe('299');

    const r = last();
    expect(r.url).toBe('/of/chats/1/messages?limit=5&a%20b=c');
    expect(r.body).toBe('{"text":"hi"}');
    expect(r.headers['x-of-proxy-account-id']).toBe('12');
    expect(r.headers['x-of-cache']).toBe('bypass');
    expect(r.headers['content-type']).toBe('application/json');
    expect(r.headers['x-request-id']).toBe(res.headers['x-request-id']);
    expect(r.headers.cookie).toBeUndefined();
    expect(r.jwt.sub).toBe(BACKEND_USER);
    expect(Object.keys(createDecoder()(String(r.headers.authorization).slice(7))).sort()).toEqual(['exp', 'iat', 'sub']);
  });

  it('forwards upstream errors and Retry-After unchanged', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/12/rate-limited', headers: bearer(writeKey) });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBe('42');
    expect(res.json()).toEqual({ error: 'RATE_LIMITED' });
  });

  it('works with the dashboard session', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/12/users/me', headers: { cookie, 'x-dashboard': '1' } });
    expect(res.statusCode).toBe(200);
    expect(last().url).toBe('/of/users/me');
  });

  it('proxies a session write with the CSRF headers and logs it without a key (playground)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/12/chats/1/messages?draft=1',
      headers: { ...dashboard(cookie), 'content-type': 'application/json' },
      payload: '{"text":"hi"}',
    });
    expect(res.statusCode).toBe(200);
    expect(last()).toMatchObject({ method: 'POST', url: '/of/chats/1/messages?draft=1', body: '{"text":"hi"}' });
    expect(last().headers.cookie).toBeUndefined();

    const id = res.headers['x-request-id'] as string;
    await waitForLogs([id]);
    const log = await app.inject({ method: 'GET', url: `/api/logs/${id}`, headers: { cookie } });
    expect(log.json()).toMatchObject({
      keyId: null,
      keyName: null,
      userId,
      accountId: 12,
      method: 'POST',
      path: '/v1/12/chats/1/messages',
      query: 'draft=1',
      statusCode: 200,
    });
  });

  it('read key cannot write', async () => {
    const before = backend.requests.length;
    const res = await app.inject({ method: 'POST', url: '/v1/12/chats/1/mute', headers: bearer(readKey) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('insufficient_scope');
    expect(backend.requests.length).toBe(before);
    expect((await app.inject({ method: 'GET', url: '/v1/12/users/me', headers: bearer(readKey) })).statusCode).toBe(200);
  });

  it('enforces the account allowlist', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/13/users/me', headers: bearer(limitedKey) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('account_not_allowed');
    expect((await app.inject({ method: 'GET', url: '/v1/12/users/me', headers: bearer(limitedKey) })).statusCode).toBe(200);
  });

  it('non-numeric account is 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/abc/users/me', headers: bearer(writeKey) });
    expect(res.statusCode).toBe(404);
  });

  it.each([
    '/v1/12/..%2fof-accounts',
    '/v1/12/users%2F..%2F..%2Fof-accounts',
    '/v1/12/users/..%5cof-accounts',
  ])('rejects path traversal %s with 400', async (url) => {
    const before = backend.requests.length;
    const res = await app.inject({ method: 'GET', url, headers: bearer(writeKey) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_path');
    expect(backend.requests.length).toBe(before);
  });

  // inject() normalises literal dot segments before routing, so check the resolver on raw URLs directly.
  it.each(['/v1/12/../of-accounts', '/v1/12/%2e%2e/of-accounts', '/v1/12/users/%2E/me', '/v1/12/a\\..\\b'])(
    'resolver rejects raw %s',
    (raw) => {
      expect(() => resolveUpstream(raw, 'http://backend.test')).toThrow(/disallowed segment/);
    },
  );

  it('lists accounts with whitelisted fields, filtered by the allowlist', async () => {
    const all = await app.inject({ method: 'GET', url: '/v1/accounts', headers: bearer(writeKey) });
    expect(all.statusCode).toBe(200);
    expect(all.json().items).toEqual([
      { id: 12, label: 'Main', username: 'alpha', displayName: 'Alpha', avatarUrl: null, status: 'active' },
      { id: 13, label: null, username: 'beta', displayName: 'Beta', avatarUrl: null, status: 'expired' },
    ]);
    const limited = await app.inject({ method: 'GET', url: '/v1/accounts', headers: bearer(limitedKey) });
    expect(limited.json().items.map((a: { id: number }) => a.id)).toEqual([12]);
  });

  it('unlinked team gets 409 team_not_linked', async () => {
    const other = await signUp(app, 'unlinked@example.test');
    const { secret } = await createKey(app, other.cookie, { scope: 'write' });
    for (const url of ['/v1/12/users/me', '/v1/accounts']) {
      const res = await app.inject({ method: 'GET', url, headers: bearer(secret) });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('team_not_linked');
    }
  });

  it('a body that stalls past the timeout is 504 upstream_timeout, not 500', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/12/slow-body', headers: bearer(writeKey) });
    expect(res.statusCode).toBe(504);
    expect(res.json().error.code).toBe('upstream_timeout');
  });

  it('an account id outside the int4 range is 404 and still logged', async () => {
    const before = backend.requests.length;
    const res = await app.inject({ method: 'GET', url: '/v1/99999999999/users/me', headers: bearer(writeKey) });
    expect(res.statusCode).toBe(404);
    expect(backend.requests.length).toBe(before);
    await waitForLogs([String(res.headers['x-request-id'])]);
  });

  it('rate-limits per key: 429 with Retry-After for one key, other keys unaffected', async () => {
    const { secret } = await createKey(app, cookie, { scope: 'read' });
    const max = Number(process.env.KEY_RATE_LIMIT_PER_MIN ?? 120);
    for (let i = 0; i < max; i++) await app.inject({ method: 'GET', url: '/v1/whoami', headers: bearer(secret) });
    const limited = await app.inject({ method: 'GET', url: '/v1/whoami', headers: bearer(secret) });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect((await app.inject({ method: 'GET', url: '/v1/whoami', headers: bearer(readKey) })).statusCode).toBe(200);
  });

  it('upstream down is 502 upstream_unavailable', async () => {
    const port = await new Promise<number>((resolve) => {
      const s = createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    const down = await buildApp({ logger: false, backendUrl: `http://127.0.0.1:${port}` });
    try {
      const res = await down.inject({ method: 'GET', url: '/v1/12/users/me', headers: bearer(writeKey) });
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe('upstream_unavailable');
    } finally {
      await down.close();
    }
  });
});
