import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { db, pool } from '../src/db/index.js';
import { messageFact, purchaseFact } from '../src/db/schema.js';
import { bearer, createKey, dashboard, linkTeam, resetDb, signUp } from './helpers.js';

// Revenue (`GET /v1/stats/revenue`) over transactions and messages stored by hand. The range is 2026-09-01..03 in UTC,
// the default stats timezone.

const A1 = 1001;
const A2 = 1002;
const B1 = 2001;
const FETCHED = new Date('2026-09-10T00:00:00.000Z');

const app = await buildApp({ logger: false });

let teamA: string;
let cookieA: string;
let keyA: string;
let limitedKeyA: string;
let keyB: string;

const purchase = (
  teamId: string,
  accountId: number,
  txId: string,
  fanId: number | null,
  kind: string | null,
  gross: number,
  net: number,
  at: string,
  user?: Record<string, unknown>,
  status?: string,
) => ({
  teamId,
  accountId,
  txId,
  fanId,
  fanIdSource: fanId === null ? null : ('field' as const),
  kind,
  grossCents: gross,
  netCents: net,
  currency: 'USD',
  createdAt: new Date(`2026-${at}:00.000Z`),
  raw: { id: txId, ...(user && { user }), ...(status && { status }) },
});

const message = (accountId: number, messageId: number, chatId: number, at: string, over: Partial<typeof messageFact.$inferInsert> = {}) => ({
  teamId: teamA,
  accountId,
  messageId,
  chatId,
  direction: 'outbound' as const,
  createdAt: new Date(`2026-${at}:00.000Z`),
  isMass: false,
  isAutomated: false,
  priceCents: 0,
  isTip: false,
  tipCents: 0,
  isOpened: false,
  mediaCount: 0,
  raw: { id: messageId },
  fetchedAt: FETCHED,
  ...over,
});

const get = async (q: string, headers: Record<string, string> = bearer(keyA)) => {
  const res = await app.inject({ method: 'GET', url: `/v1/stats/revenue?${q}`, headers });
  expect(res.statusCode).toBe(200);
  return res.json();
};
const RANGE = 'from=2026-09-01&to=2026-09-03';

beforeAll(async () => {
  await resetDb();
  const a = await signUp(app, 'revenue-a@example.test');
  const b = await signUp(app, 'revenue-b@example.test');
  teamA = a.teamId;
  cookieA = a.cookie;
  await linkTeam(a.teamId);
  await linkTeam(b.teamId);
  keyA = (await createKey(app, a.cookie, { scope: 'read', allowedAccountIds: [A1, A2] })).secret;
  limitedKeyA = (await createKey(app, a.cookie, { scope: 'read', allowedAccountIds: [A2] })).secret;
  keyB = (await createKey(app, b.cookie, { scope: 'read' })).secret;

  await pool.query('TRUNCATE message_fact, purchase_fact, stats_config');
  await db.insert(purchaseFact).values([
    purchase(teamA, A1, 't1', 3001, 'message', 1000, 800, '09-01T10:00', { id: 3001, name: 'Ann', username: 'ann' }, 'done'),
    purchase(teamA, A1, 't2', 3001, 'tips', 500, 400, '09-03T12:00', { id: 3001, username: 'ann2' }, 'loading'),
    purchase(teamA, A1, 't3', 3002, 'subscription', 2000, 1600, '09-01T11:00', { id: 3002 }, 'done'),
    // Refunded or reversed: not booked, so in no sum, payer count or name.
    // t9 is 3001's newest transaction in the range, so 3001's name must not come from it.
    purchase(teamA, A1, 't9', 3001, 'message', 5000, 4000, '09-03T15:00', { id: 3001, name: 'Refunded', isDeleted: true }, 'undo'),
    purchase(teamA, A1, 't10', 3009, 'tips', 2000, 1600, '09-02T11:00', { id: 3009, name: 'Reversed' }, 'pending_return'),
    purchase(teamA, A1, 't4', null, null, 300, 240, '09-03T13:00', undefined, 'done'),
    purchase(teamA, A1, 't5', 3008, 'post', 100, 80, '09-03T14:00', { id: 3008, name: 'Hal', isDeleted: true }, 'loading'),
    purchase(teamA, A1, 't6', 3001, 'message', 999, 799, '09-05T10:00', { id: 3001, name: 'Ann' }, 'done'),
    purchase(teamA, A2, 't7', 4001, 'message', 700, 560, '09-03T09:00', { id: 4001, name: 'Cy' }, 'done'),
    purchase(b.teamId, B1, 't8', 5001, 'tips', 4000, 3200, '09-02T10:00', { id: 5001, name: 'Bo' }, 'done'),
  ]);
  await db.insert(messageFact).values([
    message(A1, 1, 3001, '09-01T09:00', { direction: 'inbound' }),
    message(A1, 2, 3001, '09-01T09:30', { priceCents: 1000, isOpened: true }),
    message(A1, 3, 3001, '09-02T09:00'),
    message(A1, 4, 3003, '09-02T10:00', { priceCents: 500 }),
    message(A1, 5, 3003, '09-02T11:00', { isMass: true, priceCents: 900, isOpened: true }),
    message(A1, 6, 3004, '09-02T11:00', { isMass: true, priceCents: 900 }),
    // Unsent: not a fan messaged, but still a PPV sent.
    message(A1, 7, 3005, '09-02T11:00', { isMass: true, priceCents: 900, deletedAt: new Date('2026-09-02T12:00:00.000Z') }),
    // Before the range: not a fan messaged in it, but the payer 3002 has a chat.
    message(A1, 8, 3002, '08-20T10:00', { direction: 'inbound' }),
    message(A2, 9, 4001, '09-02T10:00', { direction: 'inbound' }),
    message(A2, 10, 4002, '09-02T11:00', { isMass: true, priceCents: 500 }),
    // Automated: a PPV sent, but not a DM for the golden ratio.
    message(A1, 11, 3003, '09-02T12:00', { isAutomated: true, priceCents: 300, isOpened: true }),
    message(A1, 12, 3001, '09-02T09:30'),
  ]);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('stats revenue', () => {
  it('sums the booked range by kind and by day (every day, zeros included) and rates payers and DM PPVs', async () => {
    const body = await get(RANGE);
    expect(body).toMatchObject({ timezone: 'UTC', configVersion: 1, from: '2026-09-01', to: '2026-09-03' });
    // Fan CVR: payers (A1 3001, 3002, 3008; A2 4001) over fans messaged in the range (A1 3001, 3003, 3004; A2 4001, 4002).
    // Golden ratio: DM PPVs (2, 4) over DMs (2, 3, 4, 12); mass and automated messages are not DMs.
    // Settled: t1, t3, t4 and t7 (`done`); pending: t2 and t5 (`loading`).
    expect(body.totals).toEqual({
      gross: 4600,
      settledGross: 4000,
      pendingGross: 600,
      net: 3680,
      transactions: 6,
      payers: 4,
      fansMessaged: 5,
      fanCvr: 80,
      dmMessages: 4,
      dmPpvs: 2,
      goldenRatio: 50,
    });
    expect(body.byKind).toEqual([
      { kind: 'subscription', gross: 2000, net: 1600, transactions: 1 },
      { kind: 'message', gross: 1700, net: 1360, transactions: 2 },
      { kind: 'tips', gross: 500, net: 400, transactions: 1 },
      { kind: 'unknown', gross: 300, net: 240, transactions: 1 },
      { kind: 'post', gross: 100, net: 80, transactions: 1 },
    ]);
    expect(body.byDay).toEqual([
      { day: '2026-09-01', gross: 3000, net: 2400, transactions: 2 },
      { day: '2026-09-02', gross: 0, net: 0, transactions: 0 },
      { day: '2026-09-03', gross: 1600, net: 1280, transactions: 4 },
    ]);
  });

  it('rates DM PPV unlocks in percent, automated ones included, mass ones not', async () => {
    expect((await get(RANGE)).ppv).toEqual({ sent: 3, opened: 2, rate: (2 / 3) * 100 });
  });

  it('lists the top payers by gross with the newest name, a deleted account and whether their chat is stored', async () => {
    const body = await get(RANGE, dashboard(cookieA));
    expect(body.topPayers).toEqual([
      { accountId: A1, fanId: 3002, name: null, isDeleted: false, gross: 2000, net: 1600, transactions: 1, lastAt: '2026-09-01T11:00:00.000Z', hasChat: true },
      { accountId: A1, fanId: 3001, name: 'ann2', isDeleted: false, gross: 1500, net: 1200, transactions: 2, lastAt: '2026-09-03T12:00:00.000Z', hasChat: true },
      { accountId: A2, fanId: 4001, name: 'Cy', isDeleted: false, gross: 700, net: 560, transactions: 1, lastAt: '2026-09-03T09:00:00.000Z', hasChat: true },
      { accountId: A1, fanId: 3008, name: 'Hal', isDeleted: true, gross: 100, net: 80, transactions: 1, lastAt: '2026-09-03T14:00:00.000Z', hasChat: false },
    ]);
    expect(body.withoutChat).toEqual({ payers: 1, gross: 100 });
  });

  it('counts fans messaged only on accounts with a booked transaction in the range, DMs and PPVs on all', async () => {
    // 09-01..02: A1 has t1 and t3; A2 has none, so its fans 4001 and 4002 are left out.
    expect((await get('from=2026-09-01&to=2026-09-02')).totals).toMatchObject({ payers: 2, fansMessaged: 3, fanCvr: (2 / 3) * 100 });
    // 09-02 alone: A1's only transaction is being reversed, so no fan counts, but its DMs (3, 4, 12) and PPVs (4, 11) do.
    const body = await get('from=2026-09-02&to=2026-09-02');
    expect(body.totals).toMatchObject({ transactions: 0, fansMessaged: 0, fanCvr: null, dmMessages: 3, dmPpvs: 1, goldenRatio: (1 / 3) * 100 });
    expect(body.ppv).toEqual({ sent: 2, opened: 1, rate: 50 });
  });

  it('has no fan CVR, golden ratio or PPV rate when nothing was sent', async () => {
    const body = await get('from=2026-09-05&to=2026-09-05');
    expect(body.totals).toEqual({ gross: 999, settledGross: 999, pendingGross: 0, net: 799, transactions: 1, payers: 1, fansMessaged: 0, fanCvr: null, dmMessages: 0, dmPpvs: 0, goldenRatio: null });
    expect(body.ppv).toEqual({ sent: 0, opened: 0, rate: null });
  });

  it("scopes to the key's accounts, `accountId` and the workspace's own rows", async () => {
    const a2 = { gross: 700, settledGross: 700, pendingGross: 0, net: 560, transactions: 1, payers: 1, fansMessaged: 2, fanCvr: 50, dmMessages: 0, dmPpvs: 0, goldenRatio: null };
    expect((await get(RANGE, bearer(limitedKeyA))).totals).toEqual(a2);
    expect((await get(`${RANGE}&accountId=${A2}`)).totals).toEqual(a2);
    const denied = await app.inject({ method: 'GET', url: `/v1/stats/revenue?${RANGE}&accountId=${A1}`, headers: bearer(limitedKeyA) });
    expect([denied.statusCode, denied.json().error.code]).toEqual([403, 'account_not_allowed']);

    const other = await get(RANGE, bearer(keyB));
    expect(other.totals).toMatchObject({ gross: 4000, payers: 1, fansMessaged: 0 });
    expect(other.topPayers.map((p: { fanId: number }) => p.fanId)).toEqual([5001]);
    const none = await get(`${RANGE}&accountId=${A1}`, bearer(keyB));
    expect(none.totals).toEqual({ gross: 0, settledGross: 0, pendingGross: 0, net: 0, transactions: 0, payers: 0, fansMessaged: 0, fanCvr: null, dmMessages: 0, dmPpvs: 0, goldenRatio: null });
    expect(none.topPayers).toEqual([]);
    expect(none.withoutChat).toEqual({ payers: 0, gross: 0 });
  });

  it('buckets the range and its days in the stats timezone', async () => {
    // UTC+14: the range is 08-31T10:00Z..09-03T10:00Z, so t1 and t3 fall on 09-02, t7 on 09-03, and t2, t4, t5 after it.
    const put = await app.inject({ method: 'PUT', url: '/v1/stats/config', headers: dashboard(cookieA), payload: { timezone: 'Pacific/Kiritimati' } });
    expect(put.statusCode).toBe(200);
    expect((await get(RANGE)).byDay).toEqual([
      { day: '2026-09-01', gross: 0, net: 0, transactions: 0 },
      { day: '2026-09-02', gross: 3000, net: 2400, transactions: 2 },
      { day: '2026-09-03', gross: 700, net: 560, transactions: 1 },
    ]);
  });
});
