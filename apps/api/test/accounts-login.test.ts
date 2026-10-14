import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/index.js';
import { accountOwner } from '../src/modules/accounts/ownership.js';
import { startFakeUpstream } from './fake-upstream.js';
import { bearer, createKey, dashboard, linkTeam, resetDb, signUp } from './helpers.js';

const TOKEN = process.env.UPSTREAM_TOKEN!;
const upstream = await startFakeUpstream(TOKEN, []);
const app = await buildApp({ logger: false, upstreamUrl: upstream.url });

let linked: Awaited<ReturnType<typeof signUp>>;
let other: Awaited<ReturnType<typeof signUp>>;
let unlinked: Awaited<ReturnType<typeof signUp>>;
let key: string;

beforeAll(async () => {
  await resetDb();
  linked = await signUp(app, 'login@example.test');
  other = await signUp(app, 'login-other@example.test', { linked: true });
  unlinked = await signUp(app, 'login-unlinked@example.test');
  await linkTeam(linked.teamId);
  key = (await createKey(app, linked.cookie, { scope: 'write' })).secret;
});
afterAll(async () => {
  await app.close();
  await upstream.close();
  await pool.end();
});

const start = (payload: unknown, headers: Record<string, string> = dashboard(linked.cookie)) =>
  app.inject({ method: 'POST', url: '/api/accounts/login/browser/start', headers, payload: payload as object });
const PROXY = 'http://u:p@203.0.113.10:8080';

describe('POST /api/accounts/login/browser/start', () => {
  it('forwards the principal and proxy, returns the job + stream token, and never echoes the password', async () => {
    const res = await start({ email: 'e@x.test', password: 'hunter2', proxy: PROXY });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('hunter2');
    const body = res.json();
    expect(body).toMatchObject({ jobId: expect.any(String), streamToken: expect.any(String), state: 'starting' });
    const call = upstream.requests.filter((r) => r.url === '/login/browser/start').at(-1)!;
    expect(call.headers['x-login-principal']).toBe(linked.teamId);
    expect(JSON.parse(call.body!)).toEqual({ email: 'e@x.test', password: 'hunter2', proxy: PROXY });
  });

  it("passes the upstream's proxy_required through", async () => {
    const res = await start({ email: 'e', password: 'pw' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('proxy_required');
  });

  it('needs a linked workspace, the dashboard session, CSRF and rejects an API key', async () => {
    expect((await start({ email: 'e', password: 'pw', proxy: PROXY }, dashboard(unlinked.cookie))).json().error.code).toBe('team_not_linked');
    expect((await start({ email: 'e', password: 'pw', proxy: PROXY }, { cookie: linked.cookie })).json().error.code).toBe('csrf_failed');
    expect((await start({ email: 'e', password: 'pw', proxy: PROXY }, bearer(key))).statusCode).toBe(401);
  });
});

describe('job routes are scoped to the workspace that started them', () => {
  it('polls to done and claims the OF account, accepts input and cancel, and hides the job from other workspaces', async () => {
    const { jobId } = (await start({ email: 'e', password: 'pw', proxy: PROXY })).json();
    const status = (headers: Record<string, string>) =>
      app.inject({ method: 'GET', url: `/api/accounts/login/browser/${jobId}`, headers });

    // Another workspace cannot see the job (started-principal check).
    expect((await status(dashboard(other.cookie))).statusCode).toBe(404);

    // First poll is in-progress; the second reports done and the account is claimed for the workspace.
    expect((await status(dashboard(linked.cookie))).json().state).toBe('typing');
    const done = await status(dashboard(linked.cookie));
    expect(done.json()).toMatchObject({ state: 'done', accountId: 2002, username: 'browser_acct' });
    expect((await accountOwner(2002))?.teamId).toBe(linked.teamId);

    const input = await app.inject({
      method: 'POST',
      url: `/api/accounts/login/browser/${jobId}/input`,
      headers: dashboard(linked.cookie),
      payload: { type: 'click', x: 10, y: 20 },
    });
    expect(input.json()).toMatchObject({ state: 'challenge', challenge: { kind: 'turnstile', w: 320, h: 240 } });
    const forwarded = upstream.requests.filter((r) => r.url === `/login/browser/${jobId}/input`).at(-1)!;
    expect(forwarded.headers['x-login-principal']).toBe(linked.teamId);

    const cancel = await app.inject({ method: 'POST', url: `/api/accounts/login/browser/${jobId}/cancel`, headers: dashboard(linked.cookie) });
    expect(cancel.json().state).toBe('cancelled');
  });
});

describe('GET /api/accounts/login/browser/:jobId/stream', () => {
  it('streams SSE when the query token matches and 404s otherwise, without needing a session', async () => {
    const { jobId, streamToken } = (await start({ email: 'e', password: 'pw', proxy: PROXY })).json();

    const bad = await app.inject({ method: 'GET', url: `/api/accounts/login/browser/${jobId}/stream?token=wrong` });
    expect(bad.statusCode).toBe(404);

    const res = await app.inject({ method: 'GET', url: `/api/accounts/login/browser/${jobId}/stream?token=${streamToken}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('"state":"done"');
  });
});
