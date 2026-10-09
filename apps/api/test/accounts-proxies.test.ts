import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/index.js';
import { startFakeUpstream } from './fake-upstream.js';
import { bearer, createKey, dashboard, linkTeam, resetDb, signUp } from './helpers.js';

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
    const [first, dead] = res.json().items;
    expect(first).toEqual({
      label: 'acct-1001',
      scheme: 'http',
      host: '203.0.113.10',
      port: 8080,
      assignedAccountIds: [1001],
      verifiedIp: null,
      verifiedAt: null,
      verifiedGeo: null,
      stats: { ok: 3, failed: 1, lastError: 'timeout: slow', lastErrorAt: '2026-10-09T11:00:00Z', lastUsedAt: '2026-10-09T11:30:00Z' },
      since: '2026-10-09T10:00:00Z',
    });
    expect(dead.stats).toEqual({ ok: 0, failed: 0, lastError: null, lastErrorAt: null, lastUsedAt: null });
  });

  it('needs a linked workspace and the dashboard session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/proxies', headers: dashboard(unlinked.cookie) })).statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: '/api/proxies', headers: bearer(key) })).statusCode).toBe(401);
  });
});

describe('POST /api/proxies/:label/probe', () => {
  const probe = (label: string, headers: Record<string, string> = dashboard(linked.cookie)) =>
    app.inject({ method: 'POST', url: `/api/proxies/${label}/probe`, headers });

  it('answers the probed proxy with its egress', async () => {
    const res = await probe('acct-1001');
    expect(res.statusCode).toBe(200);
    expect(res.json().proxy).toMatchObject({ label: 'acct-1001', verifiedIp: '198.51.100.7', verifiedGeo: 'Ljubljana, SI' });
    expect(res.body).not.toContain('proxy-secret');
    expect(calls('/proxies/acct-1001/probe').at(-1)!.method).toBe('POST');
  });

  it("passes the upstream's 502 proxy_error and 404 through", async () => {
    const dead = await probe('dead');
    expect(dead.statusCode).toBe(502);
    expect(dead.json()).toEqual({ error: { code: 'proxy_error', message: 'proxy_probe_failed: refused' } });
    expect((await probe('missing')).json()).toEqual({ error: { code: 'proxy_not_found' } });
  });

  it('refuses a label that is not one path segment, and API keys', async () => {
    const before = upstream.requests.length;
    expect((await probe('.x')).statusCode).toBe(400);
    expect((await probe('a%2Fb')).statusCode).toBe(400);
    expect((await probe('acct-1001', bearer(key))).statusCode).toBe(401);
    expect(upstream.requests.length).toBe(before);
  });
});
