import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/index.js';
import { createUpstream } from '../src/lib/upstream.js';
import { startFakeUpstream, type FakeOf } from './fake-upstream.js';
import { bearer, claimAndBackfill, createKey, linkTeam, resetDb, signUp } from './helpers.js';

// Openers (spec §6 step 2) over a backfill from the fake upstream, with known answers.

const TOKEN = 'test-only-upstream-token';
const A1 = 1001;
const A2 = 1002;
/** The clock for every request: `as_of`, so O4 is pending. */
const NOW = new Date('2026-09-20T12:00:00.000Z');

const app = await buildApp({ logger: false });
const fake = await startFakeUpstream(TOKEN);
const upstream = createUpstream({ url: fake.url, token: TOKEN, timeoutMs: 2000 });

const WELCOME = '<p>welcome!</p>';
const msg = (id: number, at: string, from: number, over: Record<string, unknown> = {}) => ({
  id,
  createdAt: `2026-${at}:00.000Z`,
  fromUser: { id: from },
  text: '<p>hey babe, how are you today?</p>',
  price: 0,
  isTip: false,
  mediaCount: 0,
  media: [],
  queueId: null,
  ...over,
});
const mass = (id: number, at: string, from: number, queueId: number) => msg(id, at, from, { queueId, isFromQueue: true });
const of = (messages: FakeOf['messages'], over: Partial<FakeOf> = {}): FakeOf => ({
  chats: Object.entries(messages).map(([id, [last]]) => ({ withUser: { id: Number(id) }, lastMessage: { id: Number(last!.id), createdAt: String(last!.createdAt) } })),
  messages,
  mass: [
    { id: 900, date: '2026-09-12T09:00:00Z', sentCount: 50 },
    { id: 901, date: '2026-09-09T12:00:00Z', sentCount: 30 },
  ],
  transactions: [],
  welcome: { id: '7001', template: 'reply_on_subscribe', text: WELCOME, media: [] },
  ...over,
});

/**
 * Openers, all times UTC (open_gap 7 d, open_reply 24 h, as_of 09-20 12:00; range 09-10 to 09-20):
 * O2 1001/3003 DM 22 09-11 16:00 after only welcome 21: first_ever (one page, so the walk reached the start), no reply
 * O1 1001/3001 DM 5  09-14 10:00, 12 d 23 h 30 m after DM 2; mass 3 and welcome 4 in the gap do not reset it:
 *    reactivation, fan 7 "ok" at 11:00 → 3600 s, replied (DM 6 at 10:05 is a follow-up, not an opener); substantive:
 *    fan 8 (28 characters) at 11:30 → 5400 s, replied
 * O3 1001/3004 DM 31 09-14 20:00: first_ever, fan 32 at 09-16 08:00 → 129600 s, after open_reply: no reply
 * O5 1002/4001 DM 63 09-15 10:00: unknown (pages of 2: the walk stopped at mass 62 and welcome 61 before the range,
 *    not the start; fan 60 is never read), fan 64 "hi" at 10:30 → 1800 s, replied; substantive: no reply
 * O4 1001/3005 DM 41 09-20 02:00: first_ever, no fan message, 10 h old: pending
 * Not openers: 1001/3002 DM 13 (the fan wrote first: 12 at 09:00 broke 13 d of silence), 1001/3006 DM 52 (6 d 23 h
 * after DM 51, under open_gap), 1001/3007 DM 72 (13 d after fan 71, unanswered: a late reply, not an opener, whatever
 * open_gap), and 1001/3002 DM 11 (first_ever on 09-02, before the range).
 */
const DATA_A1 = of({
  3001: [
    msg(8, '09-14T11:30', 3001),
    msg(7, '09-14T11:00', 3001, { text: '<p>ok</p>' }),
    msg(6, '09-14T10:05', A1),
    msg(5, '09-14T10:00', A1),
    msg(4, '09-13T08:00', A1, { text: WELCOME }),
    mass(3, '09-12T09:00', A1, 900),
    msg(2, '09-01T10:30', A1),
    msg(1, '09-01T10:00', 3001),
  ],
  3002: [msg(13, '09-15T09:10', A1), msg(12, '09-15T09:00', 3002), msg(11, '09-02T10:00', A1)],
  3003: [msg(22, '09-11T16:00', A1), msg(21, '09-11T15:00', A1, { text: WELCOME })],
  3004: [msg(32, '09-16T08:00', 3004), msg(31, '09-14T20:00', A1)],
  3005: [msg(41, '09-20T02:00', A1)],
  3006: [msg(52, '09-15T11:00', A1), msg(51, '09-08T12:00', A1)],
  3007: [msg(72, '09-15T12:00', A1), msg(71, '09-02T10:00', 3007)],
});
const DATA_A2 = of(
  {
    4001: [
      msg(64, '09-15T10:30', 4001, { text: '<p>hi</p>' }),
      msg(63, '09-15T10:00', A2),
      mass(62, '09-09T12:00', A2, 901),
      msg(61, '09-05T08:00', A2, { text: WELCOME }),
      msg(60, '09-01T08:00', 4001),
    ],
  },
  { pageCap: 2 },
);

const IDS = ['openers', 'opener_reply_rate', 'opener_reply_rate_substantive', 'opener_fan_reply_time'];

let keyA: string;
let writeKeyA: string;
let limitedKeyA: string;
let keyB: string;

const get = (url: string, key = keyA) => app.inject({ method: 'GET', url, headers: bearer(key) });
const put = (body: Record<string, unknown>) => app.inject({ method: 'PUT', url: '/v1/stats/config', headers: bearer(writeKeyA), payload: body });
const RANGE = 'from=2026-09-10&to=2026-09-20';
type Row = { group: string; value: number | null; n: number };
const series = async (id: string, groupBy: string, key = keyA, q = RANGE) => {
  const res = await get(`/v1/stats/metrics/${id}?${q}&groupBy=${groupBy}`, key);
  expect(res.statusCode).toBe(200);
  return res.json() as { rows: (Row & Record<string, unknown>)[]; asOf: string };
};
const tuples = (rows: Row[]) => rows.map((r) => [r.group, r.value, r.n]);
const sampleIds = async (id: string, q = '') =>
  (await get(`/v1/stats/metrics/${id}/samples?${RANGE}${q}`)).json().items.map((s: { openerMessageId: number }) => s.openerMessageId);

beforeAll(async () => {
  await resetDb();
  const a = await signUp(app, 'openers-a@example.test');
  const b = await signUp(app, 'openers-b@example.test');
  await linkTeam(a.teamId);
  await linkTeam(b.teamId);
  keyA = (await createKey(app, a.cookie, { scope: 'read', allowedAccountIds: [A1, A2] })).secret;
  writeKeyA = (await createKey(app, a.cookie, { scope: 'write' })).secret;
  limitedKeyA = (await createKey(app, a.cookie, { scope: 'read', allowedAccountIds: [A2] })).secret;
  keyB = (await createKey(app, b.cookie, { scope: 'read' })).secret; // no allowlist: still none of A's accounts

  await pool.query('TRUNCATE message_fact, chat_coverage, purchase_fact');
  vi.setSystemTime(NOW);
  const run = { upstream, teamId: a.teamId, from: new Date('2026-09-10T00:00:00Z'), to: new Date('2026-09-21T00:00:00Z'), config: { pageDelayMs: 0 } };
  fake.state.of = DATA_A1;
  await claimAndBackfill({ ...run, accountId: A1 });
  fake.state.of = DATA_A2;
  await claimAndBackfill({ ...run, accountId: A2 });
});
beforeEach(async () => {
  await pool.query('TRUNCATE stats_config');
  vi.setSystemTime(NOW);
});
afterAll(async () => {
  vi.useRealTimers();
  await app.close();
  await fake.close();
  await pool.end();
});

describe('opener metrics catalogue', () => {
  it('lists the opener metrics after the reply-time ones, unverified, by day, hour and account', async () => {
    const items = (await get('/v1/stats/metrics')).json().items as { id: string; unit: string; groupings: string[]; verified: boolean; windows: string[] }[];
    expect(items.slice(-4).map((m) => [m.id, m.unit, m.windows])).toEqual([
      ['openers', 'count', ['open_gap', 'open_reply']],
      ['opener_reply_rate', 'percent', ['open_gap', 'open_reply']],
      ['opener_reply_rate_substantive', 'percent', ['open_gap', 'open_reply', 'min_reply_chars']],
      ['opener_fan_reply_time', 'seconds', ['open_gap', 'open_reply']],
    ]);
    expect(items.slice(-4).every((m) => !m.verified && m.groupings.join() === 'day,hour,account')).toBe(true);
  });
});

describe('opener metric series', () => {
  // [group, value, n] per metric and grouping, from the openers above.
  const EXPECTED: Record<string, Record<string, (string | number | null)[][]>> = {
    openers: {
      day: [['2026-09-11', 1, 1], ['2026-09-14', 2, 2], ['2026-09-15', 1, 1], ['2026-09-20', 1, 1]],
      hour: [['02', 1, 1], ['10', 2, 2], ['16', 1, 1], ['20', 1, 1]],
      account: [['1001', 4, 4], ['1002', 1, 1]],
    },
    opener_reply_rate: {
      day: [['2026-09-11', 0, 1], ['2026-09-14', 50, 2], ['2026-09-15', 100, 1], ['2026-09-20', null, 0]],
      hour: [['02', null, 0], ['10', 100, 2], ['16', 0, 1], ['20', 0, 1]],
      account: [['1001', (1 / 3) * 100, 3], ['1002', 100, 1]],
    },
    // Only fan 8 (O1) is long enough: fan 64 "hi" does not answer O5.
    opener_reply_rate_substantive: {
      day: [['2026-09-11', 0, 1], ['2026-09-14', 50, 2], ['2026-09-15', 0, 1], ['2026-09-20', null, 0]],
      hour: [['02', null, 0], ['10', 50, 2], ['16', 0, 1], ['20', 0, 1]],
      account: [['1001', (1 / 3) * 100, 3], ['1002', 0, 1]],
    },
    opener_fan_reply_time: {
      day: [['2026-09-11', null, 0], ['2026-09-14', 3600, 1], ['2026-09-15', 1800, 1], ['2026-09-20', null, 0]],
      hour: [['02', null, 0], ['10', 2700, 2], ['16', null, 0], ['20', null, 0]],
      account: [['1001', 3600, 1], ['1002', 1800, 1]],
    },
  };
  for (const [id, byGroup] of Object.entries(EXPECTED)) {
    for (const [groupBy, rows] of Object.entries(byGroup)) {
      it(`${id} by ${groupBy}`, async () => {
        expect(tuples((await series(id, groupBy)).rows)).toEqual(rows);
      });
    }
  }

  it('carries the opener counts by kind and by fan reply', async () => {
    expect((await series('opener_reply_rate', 'account')).rows).toEqual([
      { group: '1001', value: (1 / 3) * 100, n: 3, openers: 4, firstEver: 3, reactivation: 1, unknownKind: 0, replied: 1, noReply: 2, pending: 1, massOrAutomatedGap: 2 },
      { group: '1002', value: 100, n: 1, openers: 1, firstEver: 0, reactivation: 0, unknownKind: 1, replied: 1, noReply: 0, pending: 0, massOrAutomatedGap: 1 },
    ]);
  });

  it('counts the openers whose gap held mass or automated messages, per row', async () => {
    // O2 (welcome 21), O1 (mass 3, welcome 4), O5 (welcome 61, mass 62); O3 and O4 have none.
    const rows = (await series('openers', 'day')).rows;
    expect(rows.map((r) => [r.group, r.openers, r.massOrAutomatedGap])).toEqual([
      ['2026-09-11', 1, 1],
      ['2026-09-14', 2, 1],
      ['2026-09-15', 1, 1],
      ['2026-09-20', 1, 0],
    ]);
    expect((await series('opener_reply_rate_substantive', 'account')).rows.map((r) => r.massOrAutomatedGap)).toEqual([2, 1]);
  });

  it('substantive opener reply rate: only a fan message of min_reply_chars+ within open_reply is a reply', async () => {
    expect((await series('opener_reply_rate_substantive', 'account')).rows).toEqual([
      { group: '1001', value: (1 / 3) * 100, n: 3, openers: 4, firstEver: 3, reactivation: 1, unknownKind: 0, replied: 1, noReply: 2, pending: 1, massOrAutomatedGap: 2 },
      { group: '1002', value: 0, n: 1, openers: 1, firstEver: 0, reactivation: 0, unknownKind: 1, replied: 0, noReply: 1, pending: 0, massOrAutomatedGap: 1 },
    ]);
    const items = (await get(`/v1/stats/metrics/opener_reply_rate_substantive/samples?${RANGE}`)).json().items;
    expect(items.map((s: { openerMessageId: number; fanReplyMessageId: number | null; fanReplySeconds: number | null; status: string }) => [s.openerMessageId, s.fanReplyMessageId, s.fanReplySeconds, s.status])).toEqual([
      [22, null, null, 'no_reply'],
      [5, 8, 5400, 'replied'], // not "ok" (7)
      [31, 32, 129600, 'no_reply'],
      [63, null, null, 'no_reply'], // "hi" (64) is too short
    ]);
    // The plain rate still takes the first fan message, short or not.
    expect(tuples((await series('opener_fan_reply_time', 'account')).rows)).toEqual([['1001', 3600, 1], ['1002', 1800, 1]]);
    expect((await put({ minReplyChars: 2 })).statusCode).toBe(200); // "ok" and "hi" now count
    expect(tuples((await series('opener_reply_rate_substantive', 'account')).rows)).toEqual([['1001', (1 / 3) * 100, 3], ['1002', 100, 1]]);
    expect((await put({ minReplyChars: 29 })).statusCode).toBe(200); // fan 8 has 28 characters
    expect(tuples((await series('opener_reply_rate_substantive', 'account')).rows)).toEqual([['1001', 0, 3], ['1002', 0, 1]]);
  });

  it('keeps an opener pending until open_reply elapses at as_of, out of the reply-rate denominator', async () => {
    // As of the account's last backfill (refreshed_at: the run's start, NOW), else now.
    const refreshed = (at: Date | null) => pool.query('UPDATE account_workspace SET refreshed_at = $1 WHERE account_id = $2', [at, A1]);
    expect(tuples((await series('opener_reply_rate', 'day')).rows).at(-1)).toEqual(['2026-09-20', null, 0]);
    vi.setSystemTime(new Date('2026-09-25T00:00:00.000Z')); // days later, no backfill since: still judged at NOW
    expect((await series('opener_reply_rate', 'account')).rows[0]).toMatchObject({ group: '1001', n: 3, pending: 1 });
    await refreshed(new Date('2026-09-21T02:00:01.000Z')); // a backfill whose data ends a second past O4's 24 h
    expect((await series('opener_reply_rate', 'account')).rows[0]).toMatchObject({ group: '1001', value: 25, n: 4, noReply: 3, pending: 0 });

    await refreshed(null); // no backfill has ended since migration 0015: judged as of now
    try {
      vi.setSystemTime(new Date('2026-09-21T02:00:00.000Z')); // O4 is exactly 24 h old: still pending
      expect((await series('opener_reply_rate', 'account')).rows[0]).toMatchObject({ group: '1001', n: 3, pending: 1 });
      vi.setSystemTime(new Date('2026-09-21T02:00:01.000Z')); // one second later it has no reply
      const rows = (await series('opener_reply_rate', 'account')).rows;
      expect(rows[0]).toMatchObject({ group: '1001', value: 25, n: 4, replied: 1, noReply: 3, pending: 0 });
      expect(await sampleIds('opener_reply_rate')).toEqual([22, 5, 31, 63, 41]);
    } finally {
      await refreshed(NOW);
    }
  });

  it('applies the config windows: open_gap and open_reply', async () => {
    expect((await put({ openGapSeconds: 6 * 86400, openReplySeconds: 2 * 86400 })).statusCode).toBe(200);
    // DM 52 (6 d 23 h after DM 51) is now a reactivation (no fan reply); O3's fan reply (36 h) is now within open_reply.
    expect((await series('openers', 'account')).rows[0]).toMatchObject({ group: '1001', value: 5, reactivation: 2, replied: 2, noReply: 2, pending: 1 });
    expect(tuples((await series('opener_fan_reply_time', 'account')).rows)).toEqual([['1001', (3600 + 129600) / 2, 2], ['1002', 1800, 1]]);
    expect(await sampleIds('openers')).toEqual([22, 5, 31, 63, 52, 41]);
  });

  it('writes CSV with the opener columns', async () => {
    const res = await get(`/v1/stats/metrics/openers?${RANGE}&groupBy=account&format=csv`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="openers_2026-09-10_2026-09-20.csv"');
    expect(res.body).toBe('group,value,n,openers,first_ever,reactivation,unknown_kind,replied,no_reply,pending,mass_or_automated_gap\n1001,4,4,4,3,1,0,1,2,1,2\n1002,1,1,1,0,0,1,1,0,0,1\n');
  });

  it('scopes to the key allowlist and the accountId filter', async () => {
    expect(tuples((await series('openers', 'account', limitedKeyA)).rows)).toEqual([['1002', 1, 1]]);
    const samples = (await get(`/v1/stats/metrics/openers/samples?${RANGE}`, limitedKeyA)).json().items;
    expect(samples.map((s: { openerMessageId: number }) => s.openerMessageId)).toEqual([63]);
    expect((await get(`/v1/stats/metrics/openers?${RANGE}&groupBy=account&format=csv`, limitedKeyA)).body).toBe(
      'group,value,n,openers,first_ever,reactivation,unknown_kind,replied,no_reply,pending,mass_or_automated_gap\n1002,1,1,1,0,0,1,1,0,0,1\n',
    );
    expect(tuples((await series('openers', 'account', keyA, `${RANGE}&accountId=${A1}`)).rows)).toEqual([['1001', 4, 4]]);
  });
});

describe('opener samples', () => {
  it('returns the openers behind a number, with the gap and the fan reply', async () => {
    const res = await get(`/v1/stats/metrics/openers/samples?${RANGE}&groupBy=day&group=2026-09-14`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ metric: 'openers', timezone: 'UTC', configVersion: 1, asOf: NOW.toISOString() });
    expect(res.json().items).toEqual([
      {
        accountId: A1,
        chatId: 3001,
        openerMessageId: 5,
        sentAt: '2026-09-14T10:00:00.000Z',
        kind: 'reactivation',
        previousMessageId: 2,
        previousAt: '2026-09-01T10:30:00.000Z',
        gapSeconds: 12 * 86400 + 23.5 * 3600,
        massOrAutomatedInGap: 2, // mass 3 and welcome 4 did not reset the gap
        fanReplyMessageId: 7,
        fanReplyAt: '2026-09-14T11:00:00.000Z',
        fanReplySeconds: 3600,
        status: 'replied',
      },
      {
        accountId: A1,
        chatId: 3004,
        openerMessageId: 31,
        sentAt: '2026-09-14T20:00:00.000Z',
        kind: 'first_ever',
        previousMessageId: null,
        previousAt: null,
        gapSeconds: null,
        massOrAutomatedInGap: 0,
        fanReplyMessageId: 32,
        fanReplyAt: '2026-09-16T08:00:00.000Z',
        fanReplySeconds: 129600,
        status: 'no_reply',
      },
    ]);
  });

  it('follows each metric; a DM the fan wrote first to, or under open_gap, is never an opener', async () => {
    expect(await sampleIds('openers')).toEqual([22, 5, 31, 63, 41]);
    expect(await sampleIds('opener_reply_rate')).toEqual([22, 5, 31, 63]);
    expect(await sampleIds('opener_fan_reply_time')).toEqual([5, 63]);
    expect(await sampleIds('openers', '&groupBy=account&group=1002')).toEqual([63]);
    expect(await sampleIds('openers', '&limit=2')).toEqual([22, 5]);
    const kinds = (await get(`/v1/stats/metrics/openers/samples?${RANGE}`)).json().items.map((s: { kind: string; massOrAutomatedInGap: number }) => [s.kind, s.massOrAutomatedInGap]);
    expect(kinds).toEqual([['first_ever', 1], ['reactivation', 2], ['first_ever', 0], ['unknown', 2], ['first_ever', 0]]);
  });

  it('a DM after an unanswered fan message is a late reply, not an opener, however long the gap', async () => {
    expect(await sampleIds('openers')).not.toContain(72); // 13 d after fan 71, over open_gap
    expect((await put({ openGapSeconds: 3600 })).statusCode).toBe(200);
    const ids = await sampleIds('openers');
    expect(ids).toContain(52); // 6 d 23 h after a DM: an opener under a 1 h open_gap
    expect(ids).not.toContain(72);
  });
});

describe('opener metrics tenancy', () => {
  it("a second workspace's key sees none of the first's openers, on every route", async () => {
    for (const id of IDS) {
      for (const q of [`${RANGE}&groupBy=account`, `${RANGE}&accountId=${A1}`]) {
        const s = await get(`/v1/stats/metrics/${id}?${q}`, keyB);
        expect([s.statusCode, s.json().rows]).toEqual([200, []]);
        const csv = await get(`/v1/stats/metrics/${id}?${q}&format=csv`, keyB);
        expect(csv.body).toBe('group,value,n,openers,first_ever,reactivation,unknown_kind,replied,no_reply,pending,mass_or_automated_gap\n');
        const samples = await get(`/v1/stats/metrics/${id}/samples?${q}`, keyB);
        expect([samples.statusCode, samples.json().items]).toEqual([200, []]);
      }
    }
  });
});
