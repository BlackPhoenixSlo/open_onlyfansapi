import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { db, pool } from '../src/db/index.js';
import { requestLog } from '../src/db/schema.js';
import { deleteExpired } from '../src/jobs/retention.js';
import { newId } from '../src/lib/ids.js';
import { createKey, resetDb, signUp } from './helpers.js';

const app = await buildApp({ logger: false });

const DAY = 86_400_000;
const today = new Date(Math.floor(Date.now() / DAY) * DAY); // 00:00 UTC
let owner: Awaited<ReturnType<typeof signUp>>;
let keyId: string;

function row(teamId: string, endpoint: string, statusCode: number, createdAt: Date, extra: Partial<typeof requestLog.$inferInsert> = {}) {
  return {
    id: newId('req'),
    teamId,
    method: endpoint.split(' ')[0]!,
    path: '/v1/12' + endpoint.split(' ')[1]!,
    endpoint,
    ip: '127.0.0.1',
    statusCode,
    durationMs: 10,
    reqBytes: 0,
    respBytes: 100,
    reqHeaders: {},
    createdAt,
    ...extra,
  };
}

const get = (url: string, cookie = owner.cookie) => app.inject({ method: 'GET', url, headers: { cookie } });

beforeAll(async () => {
  await resetDb();
  owner = await signUp(app, 'usage@example.test');
  const other = await signUp(app, 'usage-other@example.test');
  keyId = (await createKey(app, owner.cookie, { name: 'prod' })).key.id;
  await createKey(app, owner.cookie, { name: 'revoked' }).then((k) =>
    app.inject({ method: 'DELETE', url: `/api/keys/${k.key.id}`, headers: { cookie: owner.cookie, origin: 'http://localhost:5173', 'x-dashboard': '1' } }),
  );
  const t = owner.teamId;
  const twoDaysAgo = new Date(today.getTime() - 2 * DAY + 12 * 3_600_000); // always > 24 h ago
  const recent = new Date(Math.max(Date.now() - 60_000, today.getTime())); // always today, < 24 h ago
  await db.insert(requestLog).values([
    ...Array.from({ length: 3 }, () => row(t, 'GET /users/me', 200, twoDaysAgo, { apiKeyId: keyId, accountId: 12 })),
    row(t, 'GET /users/me', 502, recent, { apiKeyId: keyId, accountId: 12, durationMs: 30 }),
    row(t, 'POST /chats/:id/messages', 403, recent, { accountId: 13 }),
    row(t, 'GET /v1/whoami', 200, recent),
    row(t, 'GET /users/me', 200, new Date(today.getTime() - 40 * DAY)), // outside the range
    row(other.teamId, 'GET /users/me', 500, recent), // another workspace
  ]);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('usage', () => {
  const range = () => `from=${new Date(today.getTime() - 6 * DAY).toISOString()}&to=${new Date(Date.now() + 60_000).toISOString()}`;

  it('groups by endpoint with counts, errors and share', async () => {
    const res = await get(`/api/usage?${range()}&groupBy=endpoint`);
    expect(res.statusCode).toBe(200);
    const [top, ...rest] = res.json().rows;
    expect(top).toEqual({ key: 'GET /users/me', label: 'GET /users/me', requests: 4, errors: 1, avgMs: 15, bytes: 400, share: 4 / 6 });
    expect(rest.map((r: { key: string; requests: number; errors: number }) => [r.key, r.requests, r.errors]).sort()).toEqual([
      ['GET /v1/whoami', 1, 0],
      ['POST /chats/:id/messages', 1, 1],
    ]);
  });

  it('builds a zero-filled daily series and groups by key and account', async () => {
    const body = (await get(`/api/usage?${range()}&groupBy=key`)).json();
    expect(body.series).toHaveLength(7);
    expect(body.series.at(-1)).toEqual({ day: today.toISOString().slice(0, 10), requests: 3, errors: 2 });
    expect(body.series.at(-3)).toMatchObject({ requests: 3, errors: 0 });
    expect(body.series[0]).toMatchObject({ requests: 0, errors: 0 });
    expect(body.rows).toEqual([
      expect.objectContaining({ key: keyId, label: 'prod', requests: 4 }),
      expect.objectContaining({ key: '', label: 'Dashboard', requests: 2 }),
    ]);
    const accounts = (await get(`/api/usage?${range()}&groupBy=account`)).json().rows;
    expect(accounts.map((r: { key: string; label: string; requests: number }) => [r.key, r.label, r.requests]).sort()).toEqual([
      ['', 'No account', 1],
      ['12', '#12', 4],
      ['13', '#13', 1],
    ]);
  });

  it('rejects ranges over 31 days and inverted ranges', async () => {
    const to = new Date();
    const from = new Date(to.getTime() - 32 * DAY);
    const tooLong = await get(`/api/usage?from=${from.toISOString()}&to=${to.toISOString()}`);
    expect(tooLong.statusCode).toBe(400);
    expect(tooLong.json().error.code).toBe('range_too_large');
    expect((await get(`/api/usage?from=${to.toISOString()}&to=${from.toISOString()}`)).statusCode).toBe(400);
  });

  it('overview returns the Home KPIs', async () => {
    const res = await get('/api/overview');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ requests24h: 3, requests7d: 6, errorRate24h: 2 / 3, activeKeys: 1 });
  });

  it('retention deletes only logs older than the cutoff', async () => {
    expect(await deleteExpired('request_log', 14)).toBe(1);
    expect((await get('/api/overview')).json().requests7d).toBe(6);
  });
});
