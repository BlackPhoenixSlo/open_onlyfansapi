import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { LogList } from '../src/contracts.js';
import { pool } from '../src/db/index.js';
import { startFakeUpstream } from './fake-upstream.js';
import { bearer, createKey, linkTeam, ownAccounts, resetDb, signUp, waitForLogs } from './helpers.js';

const upstream = await startFakeUpstream(process.env.UPSTREAM_TOKEN!);
const app = await buildApp({ logger: false, upstreamUrl: upstream.url });

let owner: Awaited<ReturnType<typeof signUp>>;
let writeKey: { id: string; secret: string };
let readKey: { id: string; secret: string };
const ids: Record<'ok' | 'forbidden' | 'down', string> = { ok: '', forbidden: '', down: '' };

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

const logs = (query = '', cookie = owner.cookie) => app.inject({ method: 'GET', url: `/api/logs${query}`, headers: { cookie } });
const detail = (id: string, cookie = owner.cookie) => app.inject({ method: 'GET', url: `/api/logs/${id}`, headers: { cookie } });

beforeAll(async () => {
  await resetDb();
  owner = await signUp(app, 'logs@example.test');
  await linkTeam(owner.teamId);
  await ownAccounts(owner.teamId, 12);
  const w = await createKey(app, owner.cookie, { name: 'writer', scope: 'write' });
  const r = await createKey(app, owner.cookie, { name: 'reader', scope: 'read' });
  writeKey = { id: w.key.id, secret: w.secret };
  readKey = { id: r.key.id, secret: r.secret };

  const ok = await app.inject({ method: 'GET', url: '/v1/12/users/me?limit=5&access_token=abc', headers: bearer(writeKey.secret) });
  expect(ok.statusCode).toBe(200);
  ids.ok = ok.headers['x-request-id'] as string;

  const forbidden = await app.inject({
    method: 'POST',
    url: '/v1/12/chats/77/mute',
    headers: { ...bearer(readKey.secret), 'content-type': 'application/json' },
    payload: { password: 'hunter2', muted: true },
  });
  expect(forbidden.statusCode).toBe(403);
  ids.forbidden = forbidden.headers['x-request-id'] as string;

  const down = await buildApp({ logger: false, upstreamUrl: `http://127.0.0.1:${await freePort()}` });
  const res = await down.inject({ method: 'GET', url: '/v1/12/users/me', headers: bearer(writeKey.secret) });
  expect(res.statusCode).toBe(502);
  ids.down = res.headers['x-request-id'] as string;
  await down.close();

  await waitForLogs(Object.values(ids));
});
afterAll(async () => {
  await app.close();
  await upstream.close();
  await pool.end();
});

describe('request logs', () => {
  it('logs 200, 403 and 502 calls under their request ids, newest first', async () => {
    const res = await logs('?limit=3');
    expect(res.statusCode).toBe(200);
    const { items } = res.json();
    expect(items.map((i: { id: string }) => i.id)).toEqual([ids.down, ids.forbidden, ids.ok]);
    expect(items[0]).toMatchObject({ statusCode: 502, errorCode: 'upstream_unavailable', endpoint: 'GET /users/me', accountId: 12 });
    expect(items[1]).toMatchObject({
      statusCode: 403,
      errorCode: 'insufficient_scope',
      endpoint: 'POST /chats/:id/mute',
      method: 'POST',
      keyId: readKey.id,
      keyName: 'reader',
    });
    expect(items[2]).toMatchObject({ statusCode: 200, errorCode: null, path: '/v1/12/users/me', keyId: writeKey.id });
    expect(items[2]).not.toHaveProperty('respBody');
  });

  it('stores bodies only for errors (LOG_BODIES=errors), redacted; never auth headers', async () => {
    const ok = (await detail(ids.ok)).json();
    expect(ok).toMatchObject({ reqBody: null, respBody: null, query: 'limit=5&access_token=[redacted]' });
    expect(ok.reqHeaders).not.toHaveProperty('authorization');

    const forbidden = (await detail(ids.forbidden)).json();
    expect(JSON.parse(forbidden.reqBody)).toEqual({ password: '[redacted]', muted: true });
    expect(JSON.parse(forbidden.respBody).error).toMatchObject({ message: 'This API key is read-only', requestId: ids.forbidden });
    expect(forbidden.reqHeaders).toMatchObject({ 'content-type': 'application/json' });
    expect(JSON.stringify(forbidden)).not.toMatch(/hunter2|gk_/);
  });

  it("does not log requests without an actor, or the dashboard session's calls to gateway routes", async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/whoami', headers: bearer('gk_invalid') });
    expect(res.statusCode).toBe(401);
    const session = await app.inject({ method: 'GET', url: '/v1/whoami', headers: { cookie: owner.cookie, 'x-dashboard': '1' } });
    expect(session.statusCode).toBe(200);
    const who = await app.inject({ method: 'GET', url: '/v1/whoami', headers: bearer(writeKey.secret) });
    await waitForLogs([who.headers['x-request-id'] as string]);
    const { rows } = await pool.query('SELECT id, endpoint FROM request_log WHERE id = ANY($1)', [
      [res.headers['x-request-id'], session.headers['x-request-id']],
    ]);
    expect(rows).toEqual([]);
    expect((await detail(who.headers['x-request-id'] as string)).json().endpoint).toBe('GET /v1/whoami');
  });

  it('filters by status, key, method, endpoint, account and request id or path search', async () => {
    const pick = async (q: string) => (await logs(q)).json().items.map((i: { id: string }) => i.id);
    expect(await pick('?status=4xx')).toEqual([ids.forbidden]);
    expect(await pick('?status=5xx')).toEqual([ids.down]);
    expect(await pick('?status=error')).toEqual([ids.down, ids.forbidden]);
    expect(await pick(`?keyId=${readKey.id}`)).toEqual([ids.forbidden]);
    expect(await pick('?method=post')).toEqual([ids.forbidden]);
    expect(await pick('?endpoint=users%2Fme')).toEqual([ids.down, ids.ok]);
    expect(await pick('?accountId=13')).toEqual([]);
    expect(await pick(`?q=${ids.ok}`)).toEqual([ids.ok]);
    expect(await pick('?q=users%2Fme')).toEqual([ids.down, ids.ok]);
    expect(await pick('?q=%2F12%2Fchats')).toEqual([ids.forbidden]); // path only
    expect(await pick('?q=%3Aid%2FMUTE')).toEqual([ids.forbidden]); // endpoint only, case-insensitive
    expect(await pick('?q=%25')).toEqual([]); // LIKE wildcards are literal
    expect(await pick('?q=v1%2F12')).toEqual([ids.down, ids.forbidden, ids.ok]); // not an id: substring search
    expect(await pick(`?to=${new Date(Date.now() + 60_000).toISOString()}&from=2020-01-01T00:00:00Z&status=2xx`)).toContain(ids.ok);
  });

  it('pages with a keyset cursor', async () => {
    const reqIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'GET', url: `/v1/12/posts/${i}`, headers: bearer(writeKey.secret) });
      reqIds.push(res.headers['x-request-id'] as string);
    }
    await waitForLogs(reqIds);
    const seen: string[] = [];
    let cursor: string | null = '';
    while (cursor !== null) {
      const page: LogList = (await logs(`?endpoint=posts&limit=2${cursor ? `&cursor=${cursor}` : ''}`)).json();
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    }
    // Same-millisecond requests tie on created_at and are ordered by id, so compare with the unpaged list.
    const all = (await logs('?endpoint=posts&limit=50')).json().items.map((i: { id: string }) => i.id);
    expect(seen).toEqual(all);
    expect([...seen].sort()).toEqual([...reqIds].sort());
    expect((await logs('?cursor=garbage')).statusCode).toBe(400);
    // A non-ISO cursor time is the caller's error, not a 500.
    expect((await logs(`?cursor=${Buffer.from('["1","req_x"]').toString('base64url')}`)).statusCode).toBe(400);
  });

  it("another workspace cannot see this workspace's logs", async () => {
    const other = await signUp(app, 'other-logs@example.test');
    expect((await detail(ids.ok, other.cookie)).statusCode).toBe(404);
    expect((await logs('', other.cookie)).json().items).toEqual([]);
    expect((await detail(ids.ok)).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/logs', headers: bearer(writeKey.secret) })).statusCode).toBe(401);
  });
});
