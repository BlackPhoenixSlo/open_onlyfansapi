import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/index.js';
import { accountOwner, claimAccount } from '../src/modules/accounts/ownership.js';
import { startFakeUpstream } from './fake-upstream.js';
import { bearer, createKey, dashboard, linkTeam, resetDb, signUp, waitForLogs } from './helpers.js';

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

describe('Browserbase login (backend: browserbase, an optional registered proxy by label)', () => {
  it('forwards backend and proxy_label, and polls the live view through', async () => {
    const res = await start({ email: 'e@x.test', password: 'bb-secret-pw', proxyLabel: 'proxy two', backend: 'browserbase' });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('bb-secret-pw');
    const call = upstream.requests.filter((r) => r.url === '/login/browser/start').at(-1)!;
    expect(JSON.parse(call.body!)).toEqual({ email: 'e@x.test', password: 'bb-secret-pw', proxy_label: 'proxy two', backend: 'browserbase' });

    const snap = (await app.inject({ method: 'GET', url: `/api/accounts/login/browser/${res.json().jobId}`, headers: dashboard(linked.cookie) })).json();
    expect(snap).toMatchObject({ liveViewUrl: 'https://live.example.invalid/sess-1' });
    expect(snap).not.toHaveProperty('proxyFallback');
    expect(JSON.stringify(snap)).not.toContain('bb-secret-pw');
  });

  it('starts without a proxy: the upstream keeps the account on its own proxy', async () => {
    const res = await start({ email: 'e@x.test', password: 'pw', backend: 'browserbase' });
    expect(res.statusCode).toBe(200);
    const call = upstream.requests.filter((r) => r.url === '/login/browser/start').at(-1)!;
    expect(JSON.parse(call.body!)).toEqual({ email: 'e@x.test', password: 'pw', backend: 'browserbase' });
  });

  it('reports an error, not success, when the signed-in account belongs to another workspace', async () => {
    await claimAccount(linked.teamId, 3003);
    const { jobId } = (await start({ email: 'taken@x.test', password: 'pw', backend: 'browserbase' }, dashboard(other.cookie))).json();
    const poll = () => app.inject({ method: 'GET', url: `/api/accounts/login/browser/${jobId}`, headers: dashboard(other.cookie) });
    expect((await poll()).json().state).toBe('typing');
    const res = await poll();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ state: 'error', accountId: 3003 });
    expect(res.json().error).toContain('belongs to another workspace');
    expect((await accountOwner(3003))?.teamId).toBe(linked.teamId);
  });

  it("refuses a proxy bound to another workspace's account before reaching the upstream", async () => {
    const before = upstream.requests.filter((r) => r.url === '/login/browser/start').length;
    const res = await start({ email: 'e', password: 'pw', proxyLabel: 'acct-1001', backend: 'browserbase' });
    expect(res.json().error.code).toBe('account_not_allowed');
    expect(res.statusCode).toBe(403);
    expect(upstream.requests.filter((r) => r.url === '/login/browser/start').length).toBe(before);
  });

  it('never stores the password in request_log', async () => {
    // A logged /v1 call after the starts: once its row is written, any row the starts produced would be too.
    const logged = await app.inject({ method: 'GET', url: '/v1/accounts', headers: bearer(key) });
    await waitForLogs([String(logged.headers['x-request-id'])]);
    const { rows } = await pool.query(
      `SELECT id FROM request_log r WHERE r.path LIKE '/api/accounts/login%' OR r::text LIKE '%bb-secret-pw%' OR r::text LIKE '%hunter2%'`,
    );
    expect(rows).toEqual([]);
  });
});

describe('job routes are scoped to the workspace that started them', () => {
  it('polls to done and claims the OF account, accepts input and cancel, and hides the job from other workspaces', async () => {
    const { jobId } = (await start({ email: 'e', password: 'pw', proxy: PROXY })).json();
    const status = (headers: Record<string, string>) =>
      app.inject({ method: 'GET', url: `/api/accounts/login/browser/${jobId}`, headers });

    // Another workspace cannot see the job (started-principal check); an unknown job is a 404.
    const foreign = await status(dashboard(other.cookie));
    expect([foreign.statusCode, foreign.json().error.code]).toEqual([403, 'job_forbidden']);
    const unknown = await app.inject({ method: 'GET', url: '/api/accounts/login/browser/no-such-job', headers: dashboard(linked.cookie) });
    expect([unknown.statusCode, unknown.json().error.code]).toEqual([404, 'job_not_found']);

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

describe('POST /api/accounts/login/browser/:jobId/otp', () => {
  const CODE = '739218';
  const WRONG = '104857';

  it('forwards the code to the job, checks owner, job and body, and never echoes or logs the code', async () => {
    const lines: string[] = [];
    const logged = await buildApp({ upstreamUrl: upstream.url, logStream: { write: (line) => void lines.push(line) } });
    logged.log.level = 'trace'; // every line (tests run at LOG_LEVEL=warn)
    try {
      const { jobId } = (
        await logged.inject({
          method: 'POST',
          url: '/api/accounts/login/browser/start',
          headers: dashboard(linked.cookie),
          payload: { email: 'otp@x.test', password: 'pw', backend: 'browserbase' },
        })
      ).json();
      const otp = (payload: unknown, headers: Record<string, string> = dashboard(linked.cookie), id: string = jobId) =>
        logged.inject({ method: 'POST', url: `/api/accounts/login/browser/${id}/otp`, headers, payload: payload as object });
      const status = () => logged.inject({ method: 'GET', url: `/api/accounts/login/browser/${jobId}`, headers: dashboard(linked.cookie) });
      const seen: string[] = [];
      const expectError = async (res: Awaited<ReturnType<typeof otp>>, statusCode: number, code: string) => {
        seen.push(res.body);
        expect([res.statusCode, res.json().error.code]).toEqual([statusCode, code]);
      };

      expect((await status()).json()).toMatchObject({ state: 'otp', needsOtp: true, otpChecking: false, otpError: null });
      await expectError(await otp({ code: CODE }, dashboard(other.cookie)), 403, 'job_forbidden');
      await expectError(await otp({ code: CODE }, dashboard(linked.cookie), 'no-such-job'), 404, 'job_not_found');
      await expectError(await otp({ code: CODE }, { cookie: linked.cookie }), 403, 'csrf_failed');
      // Our own validation: no value in the message.
      await expectError(await otp({ code: Number(CODE) }), 400, 'validation_error');
      await expectError(await otp({ code: CODE.repeat(11) }), 400, 'validation_error');
      await expectError(await otp({ otp: CODE }), 400, 'validation_error');
      // A body that is not JSON: the parser's own message would quote it.
      for (const raw of [`{"code":"${CODE}"x`, `{"code":${CODE}`]) {
        const res = await logged.inject({
          method: 'POST',
          url: `/api/accounts/login/browser/${jobId}/otp`,
          headers: { ...dashboard(linked.cookie), 'content-type': 'application/json' },
          payload: raw,
        });
        seen.push(res.body);
        expect(res.statusCode).toBe(400);
      }
      // The upstream's digit check, passed through.
      await expectError(await otp({ code: '73a218' }), 400, 'invalid_otp');
      const forwardedBefore = upstream.requests.filter((r) => r.url === `/login/browser/${jobId}/otp`).length;

      const ok = await otp({ code: '739 218' });
      seen.push(ok.body);
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ state: 'otp', otpChecking: true });
      const calls = upstream.requests.filter((r) => r.url === `/login/browser/${jobId}/otp`);
      expect(calls.length).toBe(forwardedBefore + 1);
      expect(JSON.parse(calls.at(-1)!.body!)).toEqual({ code: '739 218' });
      expect(calls.at(-1)!.headers['x-login-principal']).toBe(linked.teamId);
      await expectError(await otp({ code: WRONG }), 409, 'otp_not_expected');

      const done = await status();
      seen.push(done.body);
      expect(done.json()).toMatchObject({ state: 'done', accountId: 2002 });

      for (const body of seen) {
        expect(body).not.toContain(CODE);
        expect(body).not.toContain('739 218');
        expect(body).not.toContain(WRONG);
      }
      const log = lines.join('');
      expect(log).toContain(`/api/accounts/login/browser/${jobId}/otp`);
      expect(log).not.toContain(CODE);
      expect(log).not.toContain('739 218');
      expect(log).not.toContain(WRONG);
    } finally {
      await logged.close();
    }
  });

  it('no longer takes a code on /input', async () => {
    const { jobId } = (await start({ email: 'otp@x.test', password: 'pw', backend: 'browserbase' })).json();
    const res = await app.inject({
      method: 'POST',
      url: `/api/accounts/login/browser/${jobId}/input`,
      headers: dashboard(linked.cookie),
      payload: { type: 'otp', code: CODE },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(CODE);
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
