import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/index.js';
import { isPassthrough, resolveUpstream } from '../src/modules/proxy/routes.js';
import { startFakeUpstream } from './fake-upstream.js';
import { bearer, createKey, dashboard, linkTeam, resetDb, signUp, waitForLogs } from './helpers.js';

const TOKEN = process.env.UPSTREAM_TOKEN!;
const upstream = await startFakeUpstream(TOKEN, [
  { id: 12, label: 'Main', ofUsername: 'alpha', ofDisplayName: 'Alpha', ofAvatarUrl: null, status: 'active', egressPort: 9000, agencyId: 3, createdByUserId: 1 },
  { id: 13, label: null, ofUsername: 'beta', ofDisplayName: 'Beta', ofAvatarUrl: null, status: 'expired', egressPort: 9001, agencyId: 3, createdByUserId: 1 },
]);
const app = await buildApp({ logger: false, upstreamUrl: upstream.url });

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
  await linkTeam(user.teamId);
  writeKey = (await createKey(app, cookie, { scope: 'write' })).secret;
  readKey = (await createKey(app, cookie, { scope: 'read' })).secret;
  limitedKey = (await createKey(app, cookie, { scope: 'write', allowedAccountIds: [12] })).secret;
});
afterAll(async () => {
  await app.close();
  await upstream.close();
  await pool.end();
});

const last = () => upstream.requests.at(-1)!;

describe('proxy', () => {
  it('forwards method, path, query, body and headers, authenticated with the upstream token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/12/chats/1/messages?limit=5&a%20b=c',
      headers: { ...bearer(writeKey), 'content-type': 'application/json', 'x-of-cache': 'bypass' },
      payload: '{"text":"hi"}',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ echo: true, method: 'POST', url: '/of/chats/1/messages?limit=5&a%20b=c' });
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
    // The upstream sees only the gateway's own credential: never the client's API key or session cookie.
    expect(r.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(r.headers)).not.toMatch(/gk_|better-auth/);
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
    expect(last().headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(last().headers.cookie).toBeUndefined();
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
    const before = upstream.requests.length;
    const res = await app.inject({ method: 'POST', url: '/v1/12/chats/1/mute', headers: bearer(readKey) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('insufficient_scope');
    expect(upstream.requests.length).toBe(before);
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
    const before = upstream.requests.length;
    const res = await app.inject({ method: 'GET', url, headers: bearer(writeKey) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_path');
    expect(upstream.requests.length).toBe(before);
  });

  // inject() normalises literal dot segments before routing, so check the resolver on raw URLs directly.
  it.each(['/v1/12/../of-accounts', '/v1/12/%2e%2e/of-accounts', '/v1/12/users/%2E/me', '/v1/12/a\\..\\b'])(
    'resolver rejects raw %s',
    (raw) => {
      expect(() => resolveUpstream(raw)).toThrow(/disallowed segment/);
    },
  );

  it.each(['/_of/users/me', '/%5Fof/users/me'])('forwards the passthrough %s byte for byte', async (rest) => {
    const res = await app.inject({ method: 'GET', url: `/v1/12${rest}?limit=5&a%20b=c`, headers: bearer(writeKey) });
    const url = `/of${rest}?limit=5&a%20b=c`;
    expect(res.statusCode).toBe(200);
    expect(last().url).toBe(url);
    expect(res.rawPayload.equals(Buffer.from(JSON.stringify({ echo: true, method: 'GET', url })))).toBe(true);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
  });

  describe('response wrapper', () => {
    const shaped = (q: Record<string, string>) => `/v1/1001/shaped?${new URLSearchParams(q)}`;
    const get = (url: string) => app.inject({ method: 'GET', url, headers: bearer(writeKey) });

    it('wraps a 2xx JSON body as {data, _meta}: data is the upstream bytes, content-length matches', async () => {
      const body = '{"id":12345678901234567890,"name":"fan_1","nested":[1.50,{"a":null}]}';
      const res = await get(shaped({ type: 'application/json', body }));
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(`{"data":${body},"_meta":{}}`);
      expect(res.headers['content-length']).toBe(String(Buffer.byteLength(res.body)));
      expect(res.headers['content-type']).toBe('application/json');

      for (const [type, data] of [['application/json; charset=utf-8', '[]'], ['application/problem+json', 'null']] as const) {
        const r = await get(shaped({ type, body: data }));
        expect(r.body, type).toBe(`{"data":${data},"_meta":{}}`);
      }
      // A named route that echoes: the whole echo is the data.
      const echo = await get('/v1/1001/chats?limit=5');
      expect(echo.json()).toEqual({ data: { echo: true, method: 'GET', url: '/of/chats?limit=5' }, _meta: {} });
    });

    it('turns x-next-page into an absolute _pagination.next_page and never forwards x-next-page', async () => {
      const res = await get(shaped({ type: 'application/json', body: '[1]', next: '/chats?limit=10&offset=10' }));
      expect(res.body).toBe('{"data":[1],"_meta":{},"_pagination":{"next_page":"http://localhost:5173/v1/1001/chats?limit=10&offset=10"}}');
      expect(res.headers['x-next-page']).toBeUndefined();
      expect(res.headers['content-length']).toBe(String(Buffer.byteLength(res.body)));

      const odd = await get(shaped({ type: 'application/json', body: '{}', next: '/chats?q="a\\b"' }));
      expect(odd.json()).toEqual({ data: {}, _meta: {}, _pagination: { next_page: 'http://localhost:5173/v1/1001/chats?q="a\\b"' } });
      expect(odd.headers['x-next-page']).toBeUndefined();
    });

    it.each<[string, Record<string, string>]>([
      ['4xx', { status: '404', type: 'application/json', body: '{"error":{"code":"of_error","status":404}}' }],
      ['204', { status: '204', type: 'application/json', body: '' }],
      ['empty', { type: 'application/json', body: '' }],
      ['non-JSON', { type: 'text/plain', body: '{"a":1}' }],
      ['no content-type', { body: '{"a":1}' }],
      ['whitespace-only', { type: 'application/json', body: ' \n ' }],
      ['BOM-prefixed', { type: 'application/json', body: '\uFEFF{"a":1}' }],
      ['truncated JSON', { type: 'application/json', body: '{"a":' }],
      ['two JSON values', { type: 'application/json', body: '{"a":1}{"b":2}' }],
    ])('passes a %s response through unwrapped', async (_name, q) => {
      const res = await get(shaped({ ...q, next: '/chats?offset=10' }));
      expect(res.statusCode).toBe(Number(q.status ?? 200));
      expect(res.body).toBe(q.body);
      expect(res.headers['x-next-page']).toBeUndefined();
    });

    it('wraps a gzipped upstream body: the upstream client already decoded it', async () => {
      const res = await get(shaped({ type: 'application/json', body: '{"a":1}', gzip: '1' }));
      expect(res.body).toBe('{"data":{"a":1},"_meta":{}}');
      expect(res.headers['content-encoding']).toBeUndefined();
    });

    it.each(['chats?offset=10', '//evil.example/chats', 'https://evil.example/chats', ''])(
      'omits _pagination for the x-next-page value %j',
      async (next) => {
        const res = await get(shaped({ type: 'application/json', body: '[1]', next }));
        expect(res.body).toBe('{"data":[1],"_meta":{}}');
        expect(res.headers['x-next-page']).toBeUndefined();
      },
    );

    it.each(['_of', '%5Fof'])('never wraps the passthrough /%s/…', async (segment) => {
      const res = await get(`/v1/1001/${segment}/users/me`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ echo: true, method: 'GET', url: `/of/${segment}/users/me` });
    });
  });

  it('isPassthrough matches the decoded first segment only', () => {
    for (const rest of ['/_of', '/_of/users/me', '/_of?x=1', '/%5Fof/users/me', '/%5fof', '/_%6Ff/a']) {
      expect(isPassthrough(rest), rest).toBe(true);
    }
    for (const rest of ['/', '/users/me', '/users/_of', '/_off/a', '/%5Fofx', '/%E0%A4%A/a', '/?_of']) {
      expect(isPassthrough(rest), rest).toBe(false);
    }
  });

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

  it('unlinked team gets 409 team_not_linked and reaches no upstream', async () => {
    const other = await signUp(app, 'unlinked@example.test');
    const { secret } = await createKey(app, other.cookie, { scope: 'write' });
    const before = upstream.requests.length;
    for (const url of ['/v1/12/users/me', '/v1/accounts']) {
      const res = await app.inject({ method: 'GET', url, headers: bearer(secret) });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('team_not_linked');
    }
    expect(upstream.requests.length).toBe(before);
  });

  it('a body that stalls past the timeout is 504 upstream_timeout, not 500', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/12/slow-body', headers: bearer(writeKey) });
    expect(res.statusCode).toBe(504);
    expect(res.json().error.code).toBe('upstream_timeout');
  });

  it('an account id outside the int4 range is 404 and still logged', async () => {
    const before = upstream.requests.length;
    const res = await app.inject({ method: 'GET', url: '/v1/99999999999/users/me', headers: bearer(writeKey) });
    expect(res.statusCode).toBe(404);
    expect(upstream.requests.length).toBe(before);
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
    const down = await buildApp({ logger: false, upstreamUrl: `http://127.0.0.1:${port}` });
    try {
      const res = await down.inject({ method: 'GET', url: '/v1/12/users/me', headers: bearer(writeKey) });
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe('upstream_unavailable');
    } finally {
      await down.close();
    }
  });
});
