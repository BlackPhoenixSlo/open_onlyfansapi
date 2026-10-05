import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/index.js';
import { startFakeUpstream } from './fake-upstream.js';
import { bearer, createKey, dashboard, linkTeam, resetDb, signUp, waitForLogs } from './helpers.js';

const TOKEN = process.env.UPSTREAM_TOKEN!;
const upstream = await startFakeUpstream(TOKEN, []);
const app = await buildApp({ logger: false, upstreamUrl: upstream.url });

const CURL = "curl 'https://onlyfans.com/api2/v2/users/me' -H 'user-id: 4242' -b 'sess=secret-cookie-value'";
let linked: Awaited<ReturnType<typeof signUp>>;
let unlinked: Awaited<ReturnType<typeof signUp>>;
let key: string;

beforeAll(async () => {
  await resetDb();
  linked = await signUp(app, 'connect@example.test');
  unlinked = await signUp(app, 'unlinked-connect@example.test');
  await linkTeam(linked.teamId);
  key = (await createKey(app, linked.cookie, { scope: 'write' })).secret;
});
afterAll(async () => {
  await app.close();
  await upstream.close();
  await pool.end();
});

const connect = (headers: Record<string, string>, payload: unknown) =>
  app.inject({ method: 'POST', url: '/api/accounts/connect', headers, payload: payload as object });
const bootstrapCalls = () => upstream.requests.filter((r) => r.url === '/session/bootstrap');

describe('POST /api/accounts/connect', () => {
  it('forwards to /session/bootstrap with the upstream token and passes the success body through', async () => {
    const res = await connect(dashboard(linked.cookie), { curl: CURL, nickname: 'Main', proxyUrl: 'http://u:p@proxy:8080' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accountId: 4242, username: 'fresh', status: 'connecting' });
    const call = bootstrapCalls().at(-1)!;
    expect(call.method).toBe('POST');
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.headers.cookie).toBeUndefined();
    expect(JSON.parse(call.body!)).toEqual({ curl: CURL, nickname: 'Main', proxy_url: 'http://u:p@proxy:8080' });
  });

  it("passes the upstream's 400 invalid_curl through unchanged", async () => {
    const res = await connect(dashboard(linked.cookie), { curl: "curl 'https://onlyfans.com/api2/v2/me' -b 'sess=x'" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: 'invalid_curl', message: 'the curl has no numeric user-id header' } });
  });

  it('refuses an unlinked workspace with 409 team_not_linked, like the account list, without calling the upstream', async () => {
    const before = bootstrapCalls().length;
    const res = await connect(dashboard(unlinked.cookie), { curl: CURL });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('team_not_linked');
    expect(bootstrapCalls().length).toBe(before);
  });

  it('needs the dashboard session and CSRF headers; an API key cannot use it', async () => {
    const before = bootstrapCalls().length;
    expect((await connect({ cookie: linked.cookie }, { curl: CURL })).json().error.code).toBe('csrf_failed');
    expect((await connect(bearer(key), { curl: CURL })).statusCode).toBe(401);
    expect((await connect(dashboard(linked.cookie), { nickname: 'x' })).statusCode).toBe(400);
    expect(bootstrapCalls().length).toBe(before);
  });

  it('never stores the cURL in request_log', async () => {
    // A logged /v1 call after the connects: once its row is written, any row the connects produced would be too.
    const logged = await app.inject({ method: 'GET', url: '/v1/accounts', headers: bearer(key) });
    await waitForLogs([String(logged.headers['x-request-id'])]);
    const { rows } = await pool.query(
      `SELECT id FROM request_log r WHERE r.path LIKE '/api/accounts%' OR r::text LIKE '%sess=%'`,
    );
    expect(rows).toEqual([]);
  });
});
