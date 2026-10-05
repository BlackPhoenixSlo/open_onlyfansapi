import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/index.js';
import { createUpstream } from '../src/lib/upstream.js';
import { backfill } from '../src/modules/analytics/backfill.js';
import { quantile } from '../src/modules/analytics/metrics.js';
import { startFakeUpstream, type FakeOf } from './fake-upstream.js';
import { bearer, createKey, dashboard, linkTeam, resetDb, signUp } from './helpers.js';

// Reply time and reply SLA (spec §6 step 1) over a backfill from the fake upstream, with known answers.

const TOKEN = 'test-only-upstream-token';
const A1 = 1001;
const A2 = 1002;
/** The clock for every request: `as_of`, so T5 is pending and T4 breached. */
const NOW = new Date('2026-09-04T12:00:00.000Z');

const app = await buildApp({ logger: false });
const fake = await startFakeUpstream(TOKEN);
const upstream = createUpstream({ url: fake.url, token: TOKEN, timeoutMs: 2000 });

const LONG = '<p>hey babe, how are you <b>today</b>?</p>'; // 28 characters after tag strip
const msg = (id: number, at: string, from: number, over: Record<string, unknown> = {}) => ({
  id,
  createdAt: `2026-${at}:00.000Z`,
  fromUser: { id: from },
  text: LONG,
  price: 0,
  isTip: false,
  mediaCount: 0,
  media: [],
  queueId: null,
  ...over,
});
const of = (messages: FakeOf['messages']): FakeOf => ({
  chats: Object.entries(messages).map(([id, [last]]) => ({ withUser: { id: Number(id) }, lastMessage: { id: Number(last!.id), createdAt: String(last!.createdAt) } })),
  messages,
  mass: [{ id: 900, date: '2026-09-02T09:00:00Z', sentCount: 50 }],
  transactions: [],
  welcome: { id: '7001', template: 'reply_on_subscribe', text: '<p>welcome!</p>', media: [] },
});

/**
 * Fan turns, all times UTC (wait from the first / last fan message; SLA 15 min, cap 12 h):
 * T1 1001/3001 09-01 10:00 (msgs 1, 2 at 10:05) → DM 3 at 10:10: 600 / 300 s, in cap, SLA met
 * T2 1001/3001 09-01 12:00 (4) → "one sec" 5 at 12:02: 120 s, met; substantive: → DM 6 at 13:00, 3600 s, not met
 * T3 1001/3001 09-02 08:00 (7), mass 8 does not end it → DM 9 at 21:00: 46800 s, late
 * T4 1001/3002 09-02 23:30 (10, and 12 at 09-04 07:00), no reply: breached
 * T5 1001/3003 09-04 06:00 (11), no reply: pending
 * T6 1002/4001 09-01 22:00 (21) → DM 22 at 22:20: 1200 s, in cap, not met
 */
const DATA_A1 = of({
  3001: [
    msg(9, '09-02T21:00', A1),
    msg(8, '09-02T09:00', A1, { queueId: 900, isFromQueue: true }),
    msg(7, '09-02T08:00', 3001),
    msg(6, '09-01T13:00', A1),
    msg(5, '09-01T12:02', A1, { text: '<p>one sec</p>' }),
    msg(4, '09-01T12:00', 3001),
    msg(3, '09-01T10:10', A1),
    msg(2, '09-01T10:05', 3001),
    msg(1, '09-01T10:00', 3001),
  ],
  3002: [msg(12, '09-04T07:00', 3002), msg(10, '09-02T23:30', 3002)],
  3003: [msg(11, '09-04T06:00', 3003)],
});
const DATA_A2 = of({ 4001: [msg(22, '09-01T22:20', A2), msg(21, '09-01T22:00', 4001)] });

let cookieA: string;
let keyA: string;
let writeKeyA: string;
let limitedKeyA: string;
let keyB: string;
let writeKeyB: string;

const get = (url: string, key = keyA) => app.inject({ method: 'GET', url, headers: bearer(key) });
const put = (body: Record<string, unknown>, key = writeKeyA) =>
  app.inject({ method: 'PUT', url: '/v1/stats/config', headers: bearer(key), payload: body });
const RANGE = 'from=2026-09-01&to=2026-09-04';
const series = async (id: string, groupBy: string, key = keyA, q = RANGE) => {
  const res = await get(`/v1/stats/metrics/${id}?${q}&groupBy=${groupBy}`, key);
  expect(res.statusCode).toBe(200);
  return res.json() as { rows: { group: string; value: number | null; n: number }[]; timezone: string; configVersion: number; asOf: string };
};
const tuples = (rows: { group: string; value: number | null; n: number }[]) => rows.map((r) => [r.group, r.value, r.n]);

beforeAll(async () => {
  await resetDb();
  const a = await signUp(app, 'metrics-a@example.test');
  const b = await signUp(app, 'metrics-b@example.test');
  cookieA = a.cookie;
  await linkTeam(a.teamId);
  await linkTeam(b.teamId);
  keyA = (await createKey(app, a.cookie, { scope: 'read', allowedAccountIds: [A1, A2] })).secret;
  writeKeyA = (await createKey(app, a.cookie, { scope: 'write' })).secret;
  limitedKeyA = (await createKey(app, a.cookie, { scope: 'read', allowedAccountIds: [A2] })).secret;
  keyB = (await createKey(app, b.cookie, { scope: 'read' })).secret; // no allowlist: still none of A's accounts
  writeKeyB = (await createKey(app, b.cookie, { scope: 'write' })).secret;

  await pool.query('TRUNCATE message_fact, chat_coverage, purchase_fact');
  vi.setSystemTime(NOW);
  const run = { upstream, teamId: a.teamId, from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-09-05T00:00:00Z'), config: { pageDelayMs: 0 } };
  fake.state.of = DATA_A1;
  await backfill({ ...run, accountId: A1 });
  fake.state.of = DATA_A2;
  await backfill({ ...run, accountId: A2 });
});
beforeEach(async () => {
  await pool.query('TRUNCATE stats_config');
});
afterAll(async () => {
  vi.useRealTimers();
  await app.close();
  await fake.close();
  await pool.end();
});

describe('stats metrics catalogue', () => {
  it('lists the reply-time, reply-SLA and opener metrics, unverified, by day, hour and account', async () => {
    const res = await get('/v1/stats/metrics');
    expect(res.statusCode).toBe(200);
    const items = res.json().items as { id: string; unit: string; groupings: string[]; verified: boolean; windows: string[] }[];
    expect(items.map((m) => [m.id, m.unit])).toEqual([
      ['reply_time', 'seconds'],
      ['reply_time_p90', 'seconds'],
      ['reply_time_mean', 'seconds'],
      ['reply_time_mean_last', 'seconds'],
      ['reply_sla', 'percent'],
      ['reply_time_substantive', 'seconds'],
      ['openers', 'count'],
      ['opener_reply_rate', 'percent'],
      ['opener_reply_rate_substantive', 'percent'],
      ['opener_fan_reply_time', 'seconds'],
    ]);
    expect(items.every((m) => !m.verified && m.groupings.join() === 'day,hour,account')).toBe(true);
    expect(items.find((m) => m.id === 'reply_time_substantive')!.windows).toContain('min_reply_chars');
  });
});

describe('stats metric series', () => {
  // [group, value, n] per metric and grouping, from the turns above.
  const EXPECTED: Record<string, Record<string, (string | number | null)[][]>> = {
    reply_time: {
      day: [['2026-09-01', 600, 3], ['2026-09-02', null, 0], ['2026-09-04', null, 0]],
      hour: [['06', null, 0], ['08', null, 0], ['10', 600, 1], ['12', 120, 1], ['22', 1200, 1], ['23', null, 0]],
      account: [['1001', 360, 2], ['1002', 1200, 1]],
    },
    reply_time_mean: {
      day: [['2026-09-01', 640, 3], ['2026-09-02', 46800, 1], ['2026-09-04', null, 0]],
      hour: [['06', null, 0], ['08', 46800, 1], ['10', 600, 1], ['12', 120, 1], ['22', 1200, 1], ['23', null, 0]],
      account: [['1001', 15840, 3], ['1002', 1200, 1]],
    },
    reply_time_mean_last: {
      day: [['2026-09-01', 540, 3], ['2026-09-02', 46800, 1], ['2026-09-04', null, 0]],
      hour: [['06', null, 0], ['08', 46800, 1], ['10', 300, 1], ['12', 120, 1], ['22', 1200, 1], ['23', null, 0]],
      account: [['1001', 15740, 3], ['1002', 1200, 1]],
    },
    reply_sla: {
      day: [['2026-09-01', (2 / 3) * 100, 3], ['2026-09-02', 0, 2], ['2026-09-04', null, 0]],
      hour: [['06', null, 0], ['08', 0, 1], ['10', 100, 1], ['12', 100, 1], ['22', 0, 1], ['23', 0, 1]],
      account: [['1001', 50, 4], ['1002', 0, 1]],
    },
    reply_time_substantive: {
      day: [['2026-09-01', 1200, 3], ['2026-09-02', null, 0], ['2026-09-04', null, 0]],
      hour: [['06', null, 0], ['08', null, 0], ['10', 600, 1], ['12', 3600, 1], ['22', 1200, 1], ['23', null, 0]],
      account: [['1001', 2100, 2], ['1002', 1200, 1]],
    },
  };
  for (const [id, byGroup] of Object.entries(EXPECTED)) {
    for (const [groupBy, rows] of Object.entries(byGroup)) {
      it(`${id} by ${groupBy}`, async () => {
        expect(tuples((await series(id, groupBy)).rows)).toEqual(rows);
      });
    }
  }

  it('reply_time_p90 is the 0.9 quantile of the in-cap waits, by day, hour and account, with the turn counts', async () => {
    // In cap: T1 600 and T2 120 (1001), T6 1200 (1002), all on 09-01.
    const close = (rows: { group: string; value: number | null; n: number }[], expected: (string | number | null)[][]) => {
      expect(rows.map((r) => [r.group, r.n])).toEqual(expected.map(([g, , n]) => [g, n]));
      for (const [i, [, value]] of expected.entries()) {
        if (value === null) expect(rows[i]!.value).toBeNull();
        else expect(rows[i]!.value).toBeCloseTo(value as number, 9);
      }
    };
    const day = (await series('reply_time_p90', 'day')).rows;
    close(day, [['2026-09-01', 1080, 3], ['2026-09-02', null, 0], ['2026-09-04', null, 0]]); // 600 + 0.8 * (1200 - 600)
    expect(day[1]).toMatchObject({ turns: 2, late: 1, breached: 1 });
    close((await series('reply_time_p90', 'hour')).rows, [['06', null, 0], ['08', null, 0], ['10', 600, 1], ['12', 120, 1], ['22', 1200, 1], ['23', null, 0]]);
    close((await series('reply_time_p90', 'account')).rows, [['1001', 552, 2], ['1002', 1200, 1]]); // 120 + 0.9 * (600 - 120)
    const csv = (await get(`/v1/stats/metrics/reply_time_p90?${RANGE}&groupBy=account&format=csv`)).body.split('\n');
    expect(csv[0]).toBe('group,value,n,turns,in_cap,late,breached,pending,sla_met');
    expect(csv[2]).toBe('1002,1200,1,1,1,0,0,0,0');
    const samples = async (id: string) => (await get(`/v1/stats/metrics/${id}/samples?${RANGE}`)).json().items;
    expect(await samples('reply_time_p90')).toEqual(await samples('reply_time'));
  });

  it('carries the turn counts by status, as_of, the timezone and the config version', async () => {
    const res = await series('reply_time', 'day');
    expect(res).toMatchObject({ timezone: 'UTC', configVersion: 1, asOf: NOW.toISOString() });
    expect(res.rows).toEqual([
      { group: '2026-09-01', value: 600, n: 3, turns: 3, inCap: 3, late: 0, breached: 0, pending: 0, slaMet: 2 },
      { group: '2026-09-02', value: null, n: 0, turns: 2, inCap: 0, late: 1, breached: 1, pending: 0, slaMet: 0 },
      { group: '2026-09-04', value: null, n: 0, turns: 1, inCap: 0, late: 0, breached: 0, pending: 1, slaMet: 0 },
    ]);
  });

  it('does not split a turn that started before from, however long before', async () => {
    // T4 started 09-02 23:30, 31.5 h before fan message 12: a fixed reply_cap lookback would start a turn at 12.
    expect((await series('reply_time', 'day', keyA, 'from=2026-09-04&to=2026-09-04')).rows).toEqual([
      { group: '2026-09-04', value: null, n: 0, turns: 1, inCap: 0, late: 0, breached: 0, pending: 1, slaMet: 0 },
    ]);
  });

  it('buckets days and hours, and reads from/to, in the config timezone', async () => {
    expect((await put({ timezone: 'Europe/Ljubljana' })).statusCode).toBe(200); // UTC+2 in September
    const day = await series('reply_time', 'day');
    expect(day).toMatchObject({ timezone: 'Europe/Ljubljana', configVersion: 2 });
    expect(tuples(day.rows)).toEqual([['2026-09-01', 360, 2], ['2026-09-02', 1200, 1], ['2026-09-03', null, 0], ['2026-09-04', null, 0]]);
    expect(tuples((await series('reply_time', 'hour')).rows).map((r) => r[0])).toEqual(['00', '01', '08', '10', '12', '14']);
    // 2026-09-02 local is 09-01T22:00Z to 09-02T22:00Z: T6 and T3.
    expect(tuples((await series('reply_time_mean', 'account', keyA, 'from=2026-09-02&to=2026-09-02')).rows)).toEqual([
      ['1001', 46800, 1],
      ['1002', 1200, 1],
    ]);
  });

  it('applies the config windows: reply_cap, sla and min_reply_chars', async () => {
    expect((await put({ replyCapSeconds: 50_000, slaSeconds: 1200, minReplyChars: 5 })).json().config.version).toBe(2);
    expect(tuples((await series('reply_time', 'account')).rows)).toEqual([['1001', 600, 3], ['1002', 1200, 1]]); // T3 now in cap
    expect(tuples((await series('reply_sla', 'account')).rows)).toEqual([['1001', 50, 4], ['1002', 100, 1]]);
    expect(tuples((await series('reply_time_substantive', 'account')).rows)).toEqual([['1001', 600, 3], ['1002', 1200, 1]]); // "one sec" is 7
  });

  it('writes CSV', async () => {
    const res = await get(`/v1/stats/metrics/reply_time?${RANGE}&groupBy=account&format=csv`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="reply_time_2026-09-01_2026-09-04.csv"');
    expect(res.body).toBe('group,value,n,turns,in_cap,late,breached,pending,sla_met\n1001,360,2,5,2,1,1,1,2\n1002,1200,1,1,1,0,0,0,0\n');
  });

  it('scopes to the key allowlist and the accountId filter', async () => {
    expect(tuples((await series('reply_time', 'account', limitedKeyA)).rows)).toEqual([['1002', 1200, 1]]);
    expect(tuples((await series('reply_time', 'account', keyA, `${RANGE}&accountId=${A1}`)).rows)).toEqual([['1001', 360, 2]]);
    const samples = (await get(`/v1/stats/metrics/reply_time/samples?${RANGE}`, limitedKeyA)).json().items;
    expect(samples.map((s: { accountId: number; fanMessageId: number }) => [s.accountId, s.fanMessageId])).toEqual([[A2, 21]]);
    expect((await get(`/v1/stats/metrics/reply_time?${RANGE}&groupBy=day&format=csv`, limitedKeyA)).body).toBe(
      'group,value,n,turns,in_cap,late,breached,pending,sla_met\n2026-09-01,1200,1,1,1,0,0,0,0\n',
    );
    for (const path of ['', '/samples']) {
      const denied = await get(`/v1/stats/metrics/reply_time${path}?${RANGE}&accountId=${A1}`, limitedKeyA);
      expect([denied.statusCode, denied.json().error.code]).toEqual([403, 'account_not_allowed']);
    }
    const session = await app.inject({ method: 'GET', url: `/v1/stats/metrics/reply_time?${RANGE}&groupBy=account`, headers: dashboard(cookieA) });
    expect(tuples(session.json().rows)).toEqual([['1001', 360, 2], ['1002', 1200, 1]]);
  });

  it('rejects an unknown metric with 404 and bad parameters with 400', async () => {
    const status = async (url: string) => {
      const res = await get(url);
      return [res.statusCode, res.json().error?.code];
    };
    expect(await status(`/v1/stats/metrics/nope?${RANGE}`)).toEqual([404, 'metric_not_found']);
    expect(await status(`/v1/stats/metrics/nope/samples?${RANGE}`)).toEqual([404, 'metric_not_found']);
    expect(await status(`/v1/stats/metrics/reply_time?${RANGE}&groupBy=shift`)).toEqual([400, 'validation_error']);
    expect(await status(`/v1/stats/metrics/reply_time?${RANGE}&format=xlsx`)).toEqual([400, 'validation_error']);
    expect(await status('/v1/stats/metrics/reply_time?from=2026-02-30')).toEqual([400, 'validation_error']);
    expect(await status('/v1/stats/metrics/reply_time?from=2026-13-01')).toEqual([400, 'validation_error']); // month 13
    expect(await status('/v1/stats/metrics/reply_time?to=2026-13-01')).toEqual([400, 'validation_error']);
    expect(await status('/v1/stats/scripts?from=2026-13-01')).toEqual([400, 'validation_error']);
    expect(await status('/v1/stats?from=2026-13-01')).toEqual([400, 'validation_error']);
    expect(await status('/v1/stats/metrics/reply_time?from=2026-09-04&to=2026-09-01')).toEqual([400, 'invalid_range']);
    expect(await status('/v1/stats/metrics/reply_time?from=2025-01-01&to=2026-01-02')).toEqual([400, 'range_too_large']);
    expect(await status(`/v1/stats/metrics/reply_time/samples?${RANGE}&limit=21`)).toEqual([400, 'validation_error']);
    expect(await status('/v1/stats/metrics/reply_time')).toEqual([200, undefined]); // the last 30 days
  });
});

describe('stats metric samples', () => {
  it('returns the turns behind a number, with chat and message ids to open in OF', async () => {
    const res = await get(`/v1/stats/metrics/reply_time_mean/samples?${RANGE}&groupBy=account&group=${A1}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ metric: 'reply_time_mean', timezone: 'UTC', configVersion: 1, asOf: NOW.toISOString() });
    expect(res.json().items[0]).toEqual({
      accountId: A1,
      chatId: 3001,
      fanMessageId: 1,
      fanAt: '2026-09-01T10:00:00.000Z',
      lastFanMessageId: 2,
      lastFanAt: '2026-09-01T10:05:00.000Z',
      replyMessageId: 3,
      replyAt: '2026-09-01T10:10:00.000Z',
      waitSeconds: 600,
      waitFromLastSeconds: 300,
      status: 'in_cap',
      slaMet: true,
    });
    expect(res.json().items.map((s: { fanMessageId: number }) => s.fanMessageId)).toEqual([1, 4, 7]);
  });

  it('follows each metric: in-cap replies, decided turns for the SLA, substantive replies; limit caps the rows', async () => {
    const ids = async (id: string, q = '') =>
      (await get(`/v1/stats/metrics/${id}/samples?${RANGE}${q}`)).json().items.map((s: { fanMessageId: number; replyMessageId: number | null }) => [s.fanMessageId, s.replyMessageId]);
    expect(await ids('reply_time')).toEqual([[1, 3], [4, 5], [21, 22]]);
    expect(await ids('reply_sla')).toEqual([[1, 3], [4, 5], [21, 22], [7, 9], [10, null]]);
    expect(await ids('reply_time_substantive')).toEqual([[1, 3], [4, 6], [21, 22]]);
    expect(await ids('reply_sla', '&groupBy=day&group=2026-09-02')).toEqual([[7, 9], [10, null]]);
    expect(await ids('reply_sla', '&limit=2')).toEqual([[1, 3], [4, 5]]);
    expect(await ids('reply_time', '&groupBy=hour&group=99')).toEqual([]);
  });
});

describe('quantile', () => {
  it('interpolates linearly between closest ranks (type 7), on unsorted input', () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([7], 0.5)).toBe(7);
    expect(quantile([7], 0.9)).toBe(7);
    expect(quantile([4, 1, 3, 2], 0.5)).toBe(2.5);
    expect(quantile([4, 1, 3, 2], 0.9)).toBeCloseTo(3.7, 12); // position 2.7: 3 + 0.7 * (4 - 3)
    expect(quantile([100, 90, 80, 70, 60, 50, 40, 30, 20, 10], 0.9)).toBeCloseTo(91, 12); // position 8.1
    expect(quantile([100, 90, 80, 70, 60, 50, 40, 30, 20, 10], 0.5)).toBe(55);
    expect(quantile([3, 1, 2], 0)).toBe(1);
    expect(quantile([3, 1, 2], 1)).toBe(3);
  });

  it('at 0.5 is exactly the previous median (mean of the two middle values for an even n)', () => {
    const oldMedian = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      const mid = (s.length - 1) / 2;
      return (s[Math.floor(mid)]! + s[Math.ceil(mid)]!) / 2;
    };
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 1e5;
    for (let n = 1; n <= 200; n++) {
      const xs = Array.from({ length: n }, () => (n % 3 ? Math.round(rand()) : rand() / 7));
      expect(quantile(xs, 0.5)).toBe(oldMedian(xs));
    }
  });
});

describe('stats config', () => {
  it('is made with the defaults on first read', async () => {
    const res = await get('/v1/stats/config');
    expect(res.statusCode).toBe(200);
    expect(res.json().config).toMatchObject({
      version: 1,
      replyCapSeconds: 12 * 3600,
      slaSeconds: 15 * 60,
      minReplyChars: 15,
      openGapSeconds: 7 * 86400,
      openReplySeconds: 24 * 3600,
      convertSeconds: 72 * 3600,
      timezone: 'UTC',
    });
  });

  it('PUT changes the given fields, bumps the version and needs a write key', async () => {
    const res = await put({ slaSeconds: 600, timezone: 'europe/ljubljana' });
    expect(res.statusCode).toBe(200);
    expect(res.json().config).toMatchObject({ version: 2, slaSeconds: 600, replyCapSeconds: 12 * 3600, timezone: 'Europe/Ljubljana' });
    expect((await get('/v1/stats/config')).json().config).toMatchObject({ version: 2, slaSeconds: 600 });
    expect((await put({ minReplyChars: 20 })).json().config).toMatchObject({ version: 3, slaSeconds: 600, minReplyChars: 20 });

    const code = async (body: Record<string, unknown>, key?: string) => {
      const r = await put(body, key);
      return [r.statusCode, r.json().error?.code];
    };
    expect(await code({ slaSeconds: 60 }, keyA)).toEqual([403, 'insufficient_scope']);
    expect(await code({ timezone: 'Mars/Olympus' })).toEqual([400, 'validation_error']);
    expect(await code({ replyCapSeconds: 0 })).toEqual([400, 'validation_error']);
    expect(await code({ slaSeconds: 13 * 3600 })).toEqual([400, 'invalid_config']);
    expect((await get('/v1/stats/config')).json().config.version).toBe(3);
  });
});

describe('stats metrics tenancy', () => {
  it("a second workspace's key sees none of the first's data or config, on every route", async () => {
    expect((await get('/v1/stats/metrics', keyB)).statusCode).toBe(200); // the catalogue holds no data
    for (const id of ['reply_time', 'reply_time_p90', 'reply_time_mean', 'reply_time_mean_last', 'reply_sla', 'reply_time_substantive']) {
      for (const q of [`${RANGE}&groupBy=account`, `${RANGE}&accountId=${A1}`]) {
        const s = await get(`/v1/stats/metrics/${id}?${q}`, keyB);
        expect([s.statusCode, s.json().rows]).toEqual([200, []]);
        const csv = await get(`/v1/stats/metrics/${id}?${q}&format=csv`, keyB);
        expect(csv.body).toBe('group,value,n,turns,in_cap,late,breached,pending,sla_met\n');
        const samples = await get(`/v1/stats/metrics/${id}/samples?${q}`, keyB);
        expect([samples.statusCode, samples.json().items]).toEqual([200, []]);
      }
    }
    await put({ slaSeconds: 60, timezone: 'Asia/Tokyo' }); // workspace A
    expect((await get('/v1/stats/config', keyB)).json().config).toMatchObject({ version: 1, slaSeconds: 900, timezone: 'UTC' });
    expect((await put({ slaSeconds: 120 }, writeKeyB)).json().config).toMatchObject({ version: 2, slaSeconds: 120 });
    expect((await get('/v1/stats/config')).json().config).toMatchObject({ version: 2, slaSeconds: 60, timezone: 'Asia/Tokyo' });
  });

  it('an unlinked workspace gets 409 team_not_linked', async () => {
    const other = await signUp(app, 'metrics-unlinked@example.test');
    const { secret } = await createKey(app, other.cookie, { scope: 'read' });
    for (const url of ['/v1/stats/metrics', '/v1/stats/metrics/reply_time', '/v1/stats/metrics/reply_time/samples', '/v1/stats/config']) {
      const res = await get(url, secret);
      expect([res.statusCode, res.json().error.code]).toEqual([409, 'team_not_linked']);
    }
  });
});
