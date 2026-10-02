import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { db, pool } from '../src/db/index.js';
import { event } from '../src/db/schema.js';
import { newId } from '../src/lib/ids.js';
import { bearer, createKey, dashboard, linkTeam, resetDb, signUp } from './helpers.js';

const app = await buildApp({ logger: false });

const DAY = 86_400_000;
const today = new Date(Math.floor(Date.now() / DAY) * DAY); // 00:00 UTC
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

let cookie: string;
let fullKey: string;
let limitedKey: string;

const ev = (accountId: number, type: string, createdAt: string | Date, amountCents: number | null = null) => ({
  id: newId('evt'),
  accountId,
  type,
  amountCents,
  createdAt: new Date(createdAt),
});

const get = (url: string, headers: Record<string, string>) => app.inject({ method: 'GET', url, headers });

beforeAll(async () => {
  await resetDb();
  await pool.query('TRUNCATE event');
  const owner = await signUp(app, 'stats@example.test');
  cookie = owner.cookie;
  await linkTeam(owner.teamId);
  fullKey = (await createKey(app, cookie, { scope: 'read' })).secret;
  limitedKey = (await createKey(app, cookie, { scope: 'read', allowedAccountIds: [12] })).secret;
  await db.insert(event).values([
    ev(12, 'messages.received', '2026-03-09T23:59:59.999Z'), // before `from`
    ev(12, 'messages.received', '2026-03-10T23:59:59.999Z'), // last ms of the 10th
    ev(12, 'messages.received', '2026-03-11T00:00:00.000Z'), // first ms of the 11th
    ev(12, 'tips.received', '2026-03-10T10:00:00Z', 2_000_000_000),
    ev(12, 'tips.received', '2026-03-10T11:00:00Z', 2_000_000_000), // sum beyond int4
    ev(13, 'messages.received', '2026-03-10T12:00:00Z'),
    ev(13, 'tips.received', '2026-03-11T12:00:00Z', 500),
    ev(12, 'messages.received', '2026-03-12T00:00:00.000Z'), // after `to`
    ev(14, 'messages.received', today), // default range
    ev(14, 'tips.received', new Date(today.getTime() - 29 * DAY), 100), // first day of the default range
    ev(14, 'messages.ppv.unlocked', new Date(today.getTime() - 30 * DAY + DAY - 1), 100), // last ms before it
  ]);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const RANGE = 'from=2026-03-10&to=2026-03-11';

describe('stats', () => {
  it('returns sparse UTC-day rows with to inclusive, the midnight boundary split and amounts beyond int4', async () => {
    const res = await get(`/v1/stats?${RANGE}`, bearer(fullKey));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      rows: [
        { day: '2026-03-10', accountId: 12, type: 'messages.received', count: 1, amountCents: 0 },
        { day: '2026-03-10', accountId: 12, type: 'tips.received', count: 2, amountCents: 4_000_000_000 },
        { day: '2026-03-10', accountId: 13, type: 'messages.received', count: 1, amountCents: 0 },
        { day: '2026-03-11', accountId: 12, type: 'messages.received', count: 1, amountCents: 0 },
        { day: '2026-03-11', accountId: 13, type: 'tips.received', count: 1, amountCents: 500 },
      ],
    });
  });

  it('filters by types', async () => {
    const res = await get(`/v1/stats?${RANGE}&types=tips.received,messages.ppv.unlocked`, bearer(fullKey));
    expect(res.json().rows.map((r: { day: string; accountId: number; type: string }) => [r.day, r.accountId, r.type])).toEqual([
      ['2026-03-10', 12, 'tips.received'],
      ['2026-03-11', 13, 'tips.received'],
    ]);
  });

  it('scopes to the key allowlist and the accountId filter', async () => {
    const limited = await get(`/v1/stats?${RANGE}`, bearer(limitedKey));
    expect(limited.statusCode).toBe(200);
    expect(new Set(limited.json().rows.map((r: { accountId: number }) => r.accountId))).toEqual(new Set([12]));
    expect(limited.json().rows).toHaveLength(3);

    const allowed = await get(`/v1/stats?${RANGE}&accountId=12`, bearer(limitedKey));
    expect(allowed.json().rows).toHaveLength(3);

    const denied = await get(`/v1/stats?${RANGE}&accountId=13`, bearer(limitedKey));
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('account_not_allowed');

    const one = await get(`/v1/stats?${RANGE}&accountId=13`, bearer(fullKey));
    expect(one.json().rows.map((r: { accountId: number; type: string }) => [r.accountId, r.type])).toEqual([
      [13, 'messages.received'],
      [13, 'tips.received'],
    ]);
  });

  it('defaults to the last 30 UTC days and works with a dashboard session', async () => {
    const res = await get('/v1/stats', dashboard(cookie));
    expect(res.statusCode).toBe(200);
    expect(res.json().rows).toEqual([
      { day: iso(today.getTime() - 29 * DAY), accountId: 14, type: 'tips.received', count: 1, amountCents: 100 },
      { day: iso(today.getTime()), accountId: 14, type: 'messages.received', count: 1, amountCents: 0 },
    ]);
  });

  it('validates the range: format, from after to, at most 366 days', async () => {
    const status = async (q: string) => {
      const res = await get(`/v1/stats?${q}`, bearer(fullKey));
      return [res.statusCode, res.json().error?.code];
    };
    expect(await status('from=2026-3-10')).toEqual([400, 'validation_error']);
    expect(await status('from=2026-02-30')).toEqual([400, 'validation_error']);
    expect(await status('accountId=abc')).toEqual([400, 'validation_error']);
    expect(await status('from=2026-03-11&to=2026-03-10')).toEqual([400, 'invalid_range']);
    expect(await status('from=2025-01-01&to=2026-01-01')).toEqual([200, undefined]); // 366 days
    expect(await status('from=2025-01-01&to=2026-01-02')).toEqual([400, 'range_too_large']);
    expect(await status('from=2026-03-11&to=2026-03-11')).toEqual([200, undefined]);
  });

  it('an unlinked workspace gets 409 team_not_linked', async () => {
    const other = await signUp(app, 'stats-unlinked@example.test');
    const { secret } = await createKey(app, other.cookie, { scope: 'read' });
    const res = await get(`/v1/stats?${RANGE}`, bearer(secret));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('team_not_linked');
  });
});
