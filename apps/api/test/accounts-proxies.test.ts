import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/index.js';
import { startFakeUpstream } from './fake-upstream.js';
import { bearer, createKey, dashboard, linkTeam, ownAccounts, resetDb, signUp } from './helpers.js';

const TOKEN = process.env.UPSTREAM_TOKEN!;
const upstream = await startFakeUpstream(TOKEN, [
  { id: 1001, label: 'Main', ofUsername: 'main', ofDisplayName: 'Main', ofAvatarUrl: null, status: 'active', proxyLabel: 'acct-1001' },
]);
const app = await buildApp({ logger: false, upstreamUrl: upstream.url });

let linked: Awaited<ReturnType<typeof signUp>>;
let unlinked: Awaited<ReturnType<typeof signUp>>;
let key: string;

beforeAll(async () => {
  await resetDb();
  linked = await signUp(app, 'proxies@example.test');
  unlinked = await signUp(app, 'unlinked-proxies@example.test');
  await linkTeam(linked.teamId);
  // 9999 is this workspace's but unknown upstream (the upstream's 404 passes through).
  await ownAccounts(linked.teamId, 1001, 9999);
  key = (await createKey(app, linked.cookie, { scope: 'write' })).secret;
});
afterAll(async () => {
  await app.close();
  await upstream.close();
  await pool.end();
});

const edit = (headers: Record<string, string>, id: number | string, payload: unknown) =>
  app.inject({ method: 'PATCH', url: `/api/accounts/${id}`, headers, payload: payload as object });
const calls = (url: string) => upstream.requests.filter((r) => r.url === url);

describe('PATCH /api/accounts/:id', () => {
  it('forwards label as nickname and the proxy, and answers the whitelisted account', async () => {
    const res = await edit(dashboard(linked.cookie), 1001, { label: 'Renamed', proxy: { url: 'http://u:p@203.0.113.5:8080' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      account: { id: 1001, label: 'Renamed', username: 'main', displayName: 'Main', avatarUrl: null, status: 'active' },
    });
    const call = calls('/of-accounts/1001').at(-1)!;
    expect(call.method).toBe('PATCH');
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(call.body!)).toEqual({ nickname: 'Renamed', proxy: { url: 'http://u:p@203.0.113.5:8080' } });
  });

  it('sends proxy by label and null (unbind) as given, and omits what is not given', async () => {
    await edit(dashboard(linked.cookie), 1001, { proxy: { label: 'acct-1001' } });
    expect(JSON.parse(calls('/of-accounts/1001').at(-1)!.body!)).toEqual({ proxy: { label: 'acct-1001' } });
    await edit(dashboard(linked.cookie), 1001, { proxy: null });
    expect(JSON.parse(calls('/of-accounts/1001').at(-1)!.body!)).toEqual({ proxy: null });
  });

  it("passes the upstream's errors through unchanged", async () => {
    const missing = await edit(dashboard(linked.cookie), 9999, { label: 'x' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: { code: 'account_not_found' } });
    const badUrl = await edit(dashboard(linked.cookie), 1001, { proxy: { url: 'ftp://203.0.113.1:21' } });
    expect(badUrl.statusCode).toBe(400);
    expect(badUrl.json().error.code).toBe('invalid_proxy_url');
    const unknown = await edit(dashboard(linked.cookie), 1001, { proxy: { label: 'nope' } });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('proxy_not_found');
  });

  it('rejects bad bodies and ids, an unlinked workspace, missing CSRF and API keys without calling the upstream', async () => {
    const before = upstream.requests.length;
    expect((await edit(dashboard(linked.cookie), 1001, { proxy: { label: 'a', url: 'http://h:1' } })).statusCode).toBe(400);
    expect((await edit(dashboard(linked.cookie), 1001, { label: '' })).statusCode).toBe(400);
    expect((await edit(dashboard(linked.cookie), 'abc', { label: 'x' })).statusCode).toBe(400);
    expect((await edit(dashboard(unlinked.cookie), 1001, { label: 'x' })).json().error.code).toBe('team_not_linked');
    expect((await edit({ cookie: linked.cookie }, 1001, { label: 'x' })).json().error.code).toBe('csrf_failed');
    expect((await edit(bearer(key), 1001, { label: 'x' })).statusCode).toBe(401);
    expect(upstream.requests.length).toBe(before);
  });
});

describe('GET /api/proxies', () => {
  it('lists the proxies in camelCase without credentials', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/proxies', headers: dashboard(linked.cookie) });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('proxy-secret');
    expect(res.body).not.toContain('proxy-user');
    const [first, , dead] = res.json().items;
    expect(first).toEqual({
      label: 'acct-1001',
      scheme: 'http',
      host: '203.0.113.10',
      port: 8080,
      assignedAccountIds: [1001],
      verifiedIp: null,
      verifiedAt: null,
      verifiedGeo: null,
      ofReachable: null,
      ofError: null,
      stats: {
        ok: 3,
        failed: 1,
        blocked: 1,
        lastOkAt: '2026-10-09T11:30:00Z',
        lastError: 'timeout: slow',
        lastErrorAt: '2026-10-09T11:00:00Z',
        lastUsedAt: '2026-10-09T11:30:00Z',
      },
      since: '2026-10-09T10:00:00Z',
    });
    expect(dead.stats).toEqual({ ok: 0, failed: 0, blocked: 0, lastOkAt: null, lastError: null, lastErrorAt: null, lastUsedAt: null });
  });

  it("hides a proxy bound to another workspace's account and refuses it for probe and account edit; unbound ones are shared", async () => {
    const other = await signUp(app, 'other-proxies@example.test', { linked: true });
    await ownAccounts(other.teamId, 4040);
    const res = await app.inject({ method: 'GET', url: '/api/proxies', headers: dashboard(other.cookie) });
    expect(res.json().items.map((p: { label: string }) => p.label)).toEqual(['proxy two', 'dead']);
    const before = upstream.requests.filter((r) => r.url !== '/proxies').length;
    for (const refused of [
      await edit(dashboard(other.cookie), 1001, { label: 'mine' }),
      await edit(dashboard(other.cookie), 4040, { proxy: { label: 'acct-1001' } }),
      await app.inject({ method: 'POST', url: '/api/proxies/acct-1001/probe', headers: dashboard(other.cookie) }),
    ]) {
      expect(refused.statusCode).toBe(403);
      expect(refused.json().error.code).toBe('account_not_allowed');
    }
    // Only proxy-list reads reached the upstream.
    expect(upstream.requests.filter((r) => r.url !== '/proxies').length).toBe(before);
  });

  it('needs a linked workspace and the dashboard session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/proxies', headers: dashboard(unlinked.cookie) })).statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: '/api/proxies', headers: bearer(key) })).statusCode).toBe(401);
  });
});

describe('POST /api/proxies', () => {
  const create = (payload: unknown, headers: Record<string, string> = dashboard(linked.cookie)) =>
    app.inject({ method: 'POST', url: '/api/proxies', headers, payload: payload as object });

  it('forwards label and url and answers the new unbound proxy without credentials', async () => {
    const res = await create({ label: 'pool-1', url: 'http://u:secret-pw@203.0.113.50:8080' });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('secret-pw');
    expect(res.json().proxy).toMatchObject({ label: 'pool-1', scheme: 'http', host: '203.0.113.50', port: 8080, assignedAccountIds: [] });
    const call = calls('/proxies').filter((r) => r.method === 'POST').at(-1)!;
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(call.body!)).toEqual({ label: 'pool-1', url: 'http://u:secret-pw@203.0.113.50:8080' });
  });

  it("passes the upstream's 409 proxy_exists through", async () => {
    const res = await create({ label: 'dead', url: 'http://203.0.113.1:8080' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: { code: 'proxy_exists' } });
  });

  it('rejects reserved and unroutable labels, a missing url, and API keys without calling the upstream', async () => {
    const before = upstream.requests.length;
    for (const label of ['acct-42', '.x', 'a/b', '']) {
      expect((await create({ label, url: 'http://203.0.113.1:8080' })).statusCode).toBe(400);
    }
    expect((await create({ label: 'ok' })).statusCode).toBe(400);
    expect((await create({ label: 'ok', url: 'http://203.0.113.1:8080' }, bearer(key))).statusCode).toBe(401);
    expect(upstream.requests.length).toBe(before);
  });
});

describe('POST /api/proxies/bulk', () => {
  const bulk = (payload: unknown, headers: Record<string, string> = dashboard(linked.cookie)) =>
    app.inject({ method: 'POST', url: '/api/proxies/bulk', headers, payload: payload as object });

  it('forwards the pasted text and maps the per-line result to camelCase without a password', async () => {
    const text = ['203.0.113.10:8080:user:top-secret pool-a', 'nonsense line'].join('\n');
    const res = await bulk({ text });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('top-secret');
    const { result } = res.json();
    expect(result.added).toEqual([{ label: 'pool-a', host: '203.0.113.10', port: 8080, scheme: 'http', username: 'user' }]);
    expect(result.errors).toEqual([{ line: 2, textRedacted: 'nonsense line', reason: 'could not parse' }]);
    const call = calls('/proxies/bulk').at(-1)!;
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body!)).toEqual({ text, scheme: 'http' });
  });

  it('needs a linked workspace, the dashboard session, CSRF and rejects an API key', async () => {
    const before = upstream.requests.length;
    expect((await bulk({ text: 'x' }, dashboard(unlinked.cookie))).json().error.code).toBe('team_not_linked');
    expect((await bulk({ text: 'x' }, { cookie: linked.cookie })).json().error.code).toBe('csrf_failed');
    expect((await bulk({ text: 'x' }, bearer(key))).statusCode).toBe(401);
    expect((await bulk({})).statusCode).toBe(400);
    expect(upstream.requests.length).toBe(before);
  });
});

describe('POST /api/proxies/:label/probe', () => {
  const probe = (label: string, headers: Record<string, string> = dashboard(linked.cookie)) =>
    app.inject({ method: 'POST', url: `/api/proxies/${label}/probe`, headers });

  it('answers the probed proxy with its egress', async () => {
    const res = await probe('acct-1001');
    expect(res.statusCode).toBe(200);
    expect(res.json().proxy).toMatchObject({
      label: 'acct-1001',
      verifiedIp: '198.51.100.7',
      verifiedGeo: 'Ljubljana, SI',
      ofReachable: true,
      ofError: null,
    });
    expect(res.body).not.toContain('proxy-secret');
    expect(calls('/proxies/acct-1001/probe').at(-1)!.method).toBe('POST');
  });

  it('encodes a label with a space for the upstream path, and passes an OF-blocked result through', async () => {
    const res = await probe('proxy%20two');
    expect(res.statusCode).toBe(200);
    expect(res.json().proxy).toMatchObject({
      label: 'proxy two',
      ofReachable: false,
      ofError: 'curl: (56) CONNECT tunnel failed, response 403',
    });
    expect(calls('/proxies/proxy%20two/probe')).toHaveLength(1);
  });

  it("passes the upstream's 502 proxy_error and 404 through", async () => {
    const dead = await probe('dead');
    expect(dead.statusCode).toBe(502);
    expect(dead.json()).toEqual({ error: { code: 'proxy_error', message: 'proxy_probe_failed: refused' } });
    expect((await probe('missing')).json()).toEqual({ error: { code: 'proxy_not_found' } });
  });

  it('refuses a label with a leading dot or a slash, and API keys', async () => {
    const before = upstream.requests.length;
    expect((await probe('.x')).statusCode).toBe(400);
    expect((await probe('a%2Fb')).statusCode).toBe(400);
    expect((await probe('acct-1001', bearer(key))).statusCode).toBe(401);
    expect(upstream.requests.length).toBe(before);
  });
});
