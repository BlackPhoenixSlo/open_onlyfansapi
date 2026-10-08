import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { db, pool } from '../src/db/index.js';
import { apiKey, chatCoverage, messageFact, purchaseFact, script } from '../src/db/schema.js';
import { CHAT_COLUMNS, MESSAGE_COLUMNS, REPLY_TIME_COLUMNS, TRANSACTION_COLUMNS, readCsv } from '../src/cli/analytics-csv.js';
import { accountTeam, readAutomationTexts, writeExport, writeRowsExport } from '../src/cli/analytics-export.js';
import { AppError } from '../src/lib/errors.js';
import { createUpstream, type Upstream } from '../src/lib/upstream.js';
import { backfill, type BackfillOptions, type BackfillRows } from '../src/modules/analytics/backfill.js';
import { replyTimes } from '../src/modules/analytics/turns.js';
import { claimAccount } from '../src/modules/analytics/workspace.js';
import { startFakeUpstream, type FakeOf } from './fake-upstream.js';
import { createKey, linkTeam, resetDb, signUp } from './helpers.js';

// vitest's fake timers do not reach `node:timers/promises`: route its setTimeout through the global one they fake.
vi.mock('node:timers/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:timers/promises')>()),
  setTimeout: (ms: number, value?: unknown, opts?: { signal?: AbortSignal }) =>
    new Promise((resolve, reject) => {
      const signal = opts?.signal;
      if (signal?.aborted) return reject(signal.reason);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal!.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
}));

const TOKEN = 'test-only-upstream-token';
const ACCOUNT = 1001;
const FROM = new Date('2026-09-01T00:00:00.000Z');
const TO = new Date('2026-09-04T00:00:00.000Z');
/** The clock during a run: mass history is read up to now. */
const NOW = new Date('2026-09-05T00:00:00.000Z');
const HOUR = 3_600_000;

const app = await buildApp({ logger: false });
const fake = await startFakeUpstream(TOKEN);
const upstream = createUpstream({ url: fake.url, token: TOKEN, timeoutMs: 2000 });

const msg = (id: number, at: string, from: number, over: Record<string, unknown> = {}) => ({
  id,
  createdAt: `2026-${at}:00.000Z`,
  fromUser: { id: from },
  text: `<p>text ${id}</p>`,
  price: 0,
  isTip: false,
  mediaCount: 0,
  media: [],
  queueId: null,
  ...over,
});
const chat = (id: number, last: { id: number; createdAt: string }, username?: string) => ({ withUser: { id, username }, lastMessage: last });

/** Three chats in the range and one before it; OF pages hold at most 3 messages; chat 2002 ignores its cursor. */
function ofData(): FakeOf {
  const messages = {
    2001: [
      msg(110, '09-02T12:00', ACCOUNT), // the reply
      msg(109, '09-02T10:00', 2001),
      msg(108, '09-02T09:00', ACCOUNT, { queueId: 900, isFromQueue: true }), // mass
      msg(107, '09-01T09:30', ACCOUNT, { text: '<p>Welcome &amp;  HI!</p>' }), // the welcome message
      msg(106, '09-01T09:00', 2001),
      msg(105, '08-31T20:00', ACCOUNT), // the boundary page ends here
      msg(104, '08-31T19:00', 2001),
      msg(101, '08-20T10:00', 2001),
    ],
    2002: [
      msg(204, '09-01T15:00', 2002, { fromUser: { id: 2002, username: 'fan_two' } }), // the chat list names no username
      msg(203, '09-01T14:30', ACCOUNT),
      msg(202, '09-01T14:00', 2002),
      msg(201, '09-01T13:00', 2002),
    ],
    2003: [
      msg(303, '09-02T20:00', 2003),
      msg(302, '09-02T09:00', ACCOUNT, { queueId: 901, isFromQueue: true }), // a 1:1 queued send: a DM
      msg(301, '09-02T08:00', 2003, { isTip: true, price: 5 }),
    ],
    2004: [msg(401, '08-25T10:00', 2004)],
    2005: [msg(501, '08-24T10:00', 2005)],
  };
  return {
    chats: [
      chat(2003, messages[2003][0]!, 'fan_three'),
      chat(2001, messages[2001][0]!, 'fan_one'),
      chat(2002, messages[2002][0]!),
      chat(2004, messages[2004][0]!), // before the range: the chat list stops here
      chat(2005, messages[2005][0]!),
    ],
    messages,
    mass: [
      { id: 900, date: '2026-09-02T09:00:00Z', sentCount: 250 },
      { id: 901, date: '2026-09-02T09:00:00Z', sentCount: 1 },
      { id: 902, date: '2026-09-03T18:00:00Z', sentCount: 40 },
    ],
    transactions: [
      { id: 'tx4', type: 'tip', amount: 1, net: 0.8, currency: 'USD', createdAt: '2026-09-04T05:00:00Z', user: { id: 2001 } }, // after `to`
      {
        id: 'tx2',
        type: 'message',
        amount: 19.99,
        net: 15.99,
        currency: 'USD',
        createdAt: '2026-09-02T12:30:00Z',
        description: 'Payment for message from <a href="https://onlyfans.com/u2001">fan</a>',
        user: { id: 2001 },
      },
      { id: 'tx1', type: 'tip', amount: 5, net: 4, currency: 'USD', createdAt: '2026-09-02T08:00:00Z', description: 'Tip from <a href="https://onlyfans.com/u2003">u2003</a>' },
      { id: 'tx0', type: 'tip', amount: 2, net: 1.6, currency: 'USD', createdAt: '2026-09-01T01:00:00Z', description: 'Tip from <a href="https://onlyfans.com/somefan">x</a>' },
    ],
    welcome: { id: '7001', template: 'reply_on_subscribe', text: '<p>welcome &amp; hi!</p>', media: [] },
    pageCap: 3,
    stuckChats: [2002],
  };
}

let teamA: string;
let teamB: string;
const opts = (over: Partial<BackfillOptions> = {}): BackfillOptions => ({
  upstream,
  teamId: teamA,
  accountId: ACCOUNT,
  from: FROM,
  to: TO,
  config: { pageDelayMs: 0 },
  ...over,
});
/** `upstream`, recording when each request starts (`Date.now()`) and counting the answers; hooks run before and after. */
function probe(hooks: { before?: (n: number) => void; after?: () => void } = {}) {
  const started: number[] = [];
  let answered = 0;
  const wrapped: Upstream = {
    ...upstream,
    forward: async (req) => {
      hooks.before?.(started.length);
      started.push(Date.now());
      try {
        return await upstream.forward(req);
      } finally {
        answered++;
        hooks.after?.();
      }
    },
  };
  return { upstream: wrapped, started, answered: () => answered };
}
/** Real event-loop turns until `cond` holds (setImmediate is never faked here). */
async function until(cond: () => boolean) {
  while (!cond()) await new Promise((resolve) => setImmediate(resolve));
}
/** Fake setTimeout and Date from NOW: time moves only when the test advances it. */
function fakeClock() {
  vi.useRealTimers();
  vi.useFakeTimers({ toFake: ['setTimeout', 'Date'], now: NOW });
}
/** The `/of` GETs the fake upstream got since `start`, as path + query. */
const ofCalls = (start: number) => fake.requests.slice(start).map((r) => r.url).filter((u) => u.startsWith('/of/'));
const counts = async () => ({
  messages: await db.$count(messageFact),
  coverage: await db.$count(chatCoverage),
  purchases: await db.$count(purchaseFact),
  scripts: await db.$count(script),
});

beforeAll(async () => {
  await resetDb();
  const a = await signUp(app, 'analytics-a@example.test');
  const b = await signUp(app, 'analytics-b@example.test');
  teamA = a.teamId;
  teamB = b.teamId;
  await linkTeam(teamA);
  await linkTeam(teamB);
  await createKey(app, a.cookie, { scope: 'read', allowedAccountIds: [ACCOUNT] });
  await createKey(app, b.cookie, { scope: 'read' }); // no allowlist: still none of workspace A's accounts
});
beforeEach(async () => {
  await pool.query('TRUNCATE message_fact, chat_coverage, purchase_fact');
  fake.state.of = ofData();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(async () => {
  await app.close();
  await fake.close();
  await pool.end();
});

describe('analytics backfill', () => {
  it('reads mass in day windows from a day before the range to now, the welcome once, chats down to the range, messages down to the boundary, then transactions', async () => {
    const start = fake.requests.length;
    const result = await backfill(opts());
    expect(result).toEqual({
      stopped: false,
      requests: 13,
      retries: 0,
      chats: 3,
      messages: 12,
      broadcasts: 3,
      transactions: 3,
      welcome: true,
      unmatchedQueueIds: 0,
      incompleteChats: 1, // 2002: OF ignored the cursor before the walk reached the range start
    });
    expect(ofCalls(start)).toEqual([
      '/of/mass-messaging/overview?startDate=2026-08-31+00%3A00%3A00&endDate=2026-08-31+23%3A59%3A59&limit=100',
      '/of/mass-messaging/overview?startDate=2026-09-01+00%3A00%3A00&endDate=2026-09-01+23%3A59%3A59&limit=100',
      '/of/mass-messaging/overview?startDate=2026-09-02+00%3A00%3A00&endDate=2026-09-02+23%3A59%3A59&limit=100',
      '/of/mass-messaging/overview?startDate=2026-09-03+00%3A00%3A00&endDate=2026-09-03+23%3A59%3A59&limit=100',
      '/of/mass-messaging/overview?startDate=2026-09-04+00%3A00%3A00&endDate=2026-09-04+23%3A59%3A59&limit=100',
      '/of/settings/welcome-message',
      '/of/chats?limit=50&offset=0&order=recent&skip_users=none',
      // A full chat: the page holding the range start is the last one read.
      '/of/chats/2003/messages?limit=100&order=desc',
      '/of/chats/2001/messages?limit=100&order=desc',
      '/of/chats/2001/messages?limit=100&order=desc&first_id=108',
      // OF ignores the cursor here: the second page adds no new id, so paging stops.
      '/of/chats/2002/messages?limit=100&order=desc',
      '/of/chats/2002/messages?limit=100&order=desc&first_id=202',
      '/of/payouts/transactions?limit=100&offset=0&startDate=2026-09-01%2000%3A00%3A00',
    ]);

    const coverage = await db.select().from(chatCoverage).orderBy(chatCoverage.chatId);
    expect(coverage.map((c) => [c.chatId, c.fanUsername, c.oldestMessageId, c.oldestAt?.toISOString(), c.reachedStart])).toEqual([
      [2001, 'fan_one', 105, '2026-08-31T20:00:00.000Z', false],
      [2002, 'fan_two', 202, '2026-09-01T14:00:00.000Z', false],
      [2003, 'fan_three', 301, '2026-09-02T08:00:00.000Z', true],
    ]);

    const rows = await db.select().from(messageFact).orderBy(messageFact.messageId);
    const byId = Object.fromEntries(rows.map((r) => [r.messageId, r]));
    expect(rows.map((r) => r.messageId)).toEqual([105, 106, 107, 108, 109, 110, 202, 203, 204, 301, 302, 303]);
    expect(byId[108]).toMatchObject({ direction: 'outbound', isMass: true, queueId: 900, isAutomated: false });
    expect(byId[107]).toMatchObject({ isAutomated: true, automatedReason: 'welcome', isMass: false });
    expect(byId[302]).toMatchObject({ isMass: false, queueId: 901 });
    expect(byId[301]).toMatchObject({ direction: 'inbound', isTip: true, priceCents: 500, textHash: null, teamId: teamA });
    expect(byId[110]).toMatchObject({ textHash: null, normaliserVersion: 1 }); // "text 110": under 4 words and 20 characters
    expect(byId[301]!.normaliserVersion).toBeNull();
    expect(byId[110]!.raw).toMatchObject({ id: 110, text: '<p>text 110</p>' });

    const tx = await db.select().from(purchaseFact).orderBy(purchaseFact.txId);
    expect(tx.map((t) => [t.txId, t.fanId, t.fanIdSource, t.kind, t.grossCents, t.netCents, t.currency])).toEqual([
      ['tx0', null, null, 'tip', 200, 160, 'USD'],
      ['tx1', 2003, 'description', 'tip', 500, 400, 'USD'],
      ['tx2', 2001, 'field', 'message', 1999, 1599, 'USD'],
    ]);
  });

  it('upserts: a second run stores the same rows', async () => {
    await backfill(opts());
    const first = await counts();
    fake.state.of!.messages[2001]![0]!.text = '<p>edited</p>';
    await backfill(opts());
    expect(await counts()).toEqual(first);
    expect(first).toMatchObject({ messages: 12, coverage: 3, purchases: 3 });
    const [edited] = await db.select().from(messageFact).where(eq(messageFact.messageId, 110));
    expect(edited!.raw.text).toBe('<p>edited</p>');
  });

  it('computes reply times per fan turn from the stored messages', async () => {
    await backfill(opts());
    const turns = await replyTimes(teamA, ACCOUNT, FROM, TO, new Date('2026-09-02T21:00:00.000Z'));
    const d = (s: string) => new Date(`2026-${s}:00.000Z`);
    const ids = (inbound: number, last: number, dm: number | null) => ({ inboundMessageId: inbound, lastInboundMessageId: last, dmMessageId: dm });
    expect(turns).toEqual([
      // The welcome went out during the turn; the mass did not end it.
      { chatId: 2001, inboundAt: d('09-01T09:00'), lastInboundAt: d('09-02T10:00'), ...ids(106, 109, 110), dmAt: d('09-02T12:00'), waitSeconds: 27 * 3600, status: 'late', isAutomated: true },
      { chatId: 2002, inboundAt: d('09-01T14:00'), lastInboundAt: d('09-01T14:00'), ...ids(202, 202, 203), dmAt: d('09-01T14:30'), waitSeconds: 1800, status: 'in_cap', isAutomated: false },
      { chatId: 2002, inboundAt: d('09-01T15:00'), lastInboundAt: d('09-01T15:00'), ...ids(204, 204, null), dmAt: null, waitSeconds: null, status: 'breached', isAutomated: false },
      // The queued 1:1 send (302) is a DM: it ends the turn.
      { chatId: 2003, inboundAt: d('09-02T08:00'), lastInboundAt: d('09-02T08:00'), ...ids(301, 301, 302), dmAt: d('09-02T09:00'), waitSeconds: 3600, status: 'in_cap', isAutomated: false },
      { chatId: 2003, inboundAt: d('09-02T20:00'), lastInboundAt: d('09-02T20:00'), ...ids(303, 303, null), dmAt: null, waitSeconds: null, status: 'pending', isAutomated: false },
    ]);
  });

  it('reads mass history outside the range too, and counts queue ids it does not list', async () => {
    const of = fake.state.of!;
    of.messages[2001]!.find((m) => m.id === 105)!.queueId = 903; // before the range
    of.messages[2001]!.find((m) => m.id === 110)!.queueId = 999; // in no mass history
    of.messages[2003]!.unshift(msg(304, '09-04T10:00', ACCOUNT, { queueId: 904 })); // after the range
    of.mass.push({ id: 903, date: '2026-08-31T20:00:00Z', sentCount: 30 }, { id: 904, date: '2026-09-04T10:00:00Z', sentCount: 12 });
    const result = await backfill(opts());
    expect(result).toMatchObject({ broadcasts: 5, unmatchedQueueIds: 1 });
    const byId = Object.fromEntries((await db.select().from(messageFact)).map((r) => [r.messageId, r]));
    expect([byId[105]!.isMass, byId[304]!.isMass, byId[110]!.isMass, byId[110]!.queueId]).toEqual([true, true, false, 999]);
  });

  it('only inserts messages older than the mass window, and counts none of their queue ids', async () => {
    const of = fake.state.of!;
    of.pageCap = 4; // chat 2001's boundary page now reaches 101 (2026-08-20), before the mass window (from 08-31)
    Object.assign(of.messages[2001]!.find((m) => m.id === 101)!, { fromUser: { id: ACCOUNT }, queueId: 905 });
    of.mass.push({ id: 905, date: '2026-08-20T10:00:00Z', sentCount: 50 }); // outside the windows read
    expect(await backfill(opts())).toMatchObject({ unmatchedQueueIds: 0 });
    const stored = async () => (await db.select().from(messageFact).where(eq(messageFact.messageId, 101)))[0]!;
    expect(await stored()).toMatchObject({ direction: 'outbound', queueId: 905, isMass: false });

    // A wider run reads 905's mass history and derives 101 as mass; a later narrower run leaves it so.
    await backfill(opts({ from: new Date('2026-08-15T00:00:00.000Z') }));
    expect((await stored()).isMass).toBe(true);
    of.messages[2001]!.find((m) => m.id === 101)!.text = '<p>edited</p>';
    expect(await backfill(opts())).toMatchObject({ unmatchedQueueIds: 0 });
    expect(await stored()).toMatchObject({ isMass: true, raw: expect.objectContaining({ text: '<p>text 101</p>' }) });
  });

  it('lists chats past an older pinned chat', async () => {
    const of = fake.state.of!;
    of.chats.unshift(of.chats.splice(3, 1)[0]!); // 2004, quiet since before the range, listed first
    expect(await backfill(opts())).toMatchObject({ chats: 3 });
  });

  it('walks a chat whose last message was deleted (lastMessage null)', async () => {
    const of = fake.state.of!;
    of.messages[2006] = [msg(602, '09-02T11:00', 2006), msg(601, '09-02T10:00', ACCOUNT)]; // its newer last message is gone
    of.chats.splice(3, 0, { withUser: { id: 2006, username: 'fan_six' }, lastMessage: null });
    expect(await backfill(opts())).toMatchObject({ chats: 4 });
    const stored = await db.select().from(messageFact).where(eq(messageFact.chatId, 2006)).orderBy(messageFact.messageId);
    expect(stored.map((r) => r.messageId)).toEqual([601, 602]);
  });

  it.each([
    ['nextOffset', false],
    ['the chats returned, without nextOffset', true],
  ])('pages the chat list by %s, past one page with none active, down to two in a row', async (_, noNextOffset) => {
    const of = fake.state.of!;
    const at = (id: number, active: boolean) => chat(id, { id, createdAt: active ? '2026-09-02T10:00:00.000Z' : '2026-08-20T10:00:00.000Z' }, `fan_${id}`);
    // OF pages of 10 (asked for 50): 10 active, 10 quiet, 1 active among 9 quiet, then 20 quiet; the active one after them is not read.
    of.chats = Array.from({ length: 51 }, (_, i) => at(3000 + i, i < 10 || i === 25 || i === 50));
    of.noNextOffset = noNextOffset;
    const start = fake.requests.length;
    expect(await backfill(opts())).toMatchObject({ chats: 11 });
    expect(ofCalls(start).filter((u) => u.startsWith('/of/chats?'))).toEqual(
      [0, 10, 20, 30, 40].map((o) => `/of/chats?limit=50&offset=${o}&order=recent&skip_users=none`),
    );
    const coverage = await db.select().from(chatCoverage).orderBy(chatCoverage.chatId);
    expect(coverage.map((c) => [c.chatId, c.fanUsername])).toEqual([...Array.from({ length: 10 }, (_, i) => 3000 + i), 3025].map((id) => [id, `fan_${id}`]));
  });

  it('splits a full mass window in halves, and fails on a full hour', async () => {
    const at = (h: number, m: number) => `2026-09-02T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;
    const many = Array.from({ length: 120 }, (_, i) => ({ id: 5000 + i, date: i < 60 ? at(3, i) : at(15, i - 60), sentCount: 2 }));
    fake.state.of!.mass.push(...many);
    const start = fake.requests.length;
    expect(await backfill(opts())).toMatchObject({ broadcasts: 123 });
    expect(ofCalls(start).filter((u) => u.includes('startDate=2026-09-02'))).toEqual([
      '/of/mass-messaging/overview?startDate=2026-09-02+00%3A00%3A00&endDate=2026-09-02+23%3A59%3A59&limit=100',
      '/of/mass-messaging/overview?startDate=2026-09-02+00%3A00%3A00&endDate=2026-09-02+11%3A59%3A59&limit=100',
      '/of/mass-messaging/overview?startDate=2026-09-02+12%3A00%3A00&endDate=2026-09-02+23%3A59%3A59&limit=100',
    ]);

    fake.state.of!.mass.push(...Array.from({ length: 100 }, (_, i) => ({ id: 6000 + i, date: '2026-09-03T05:00:00Z', sentCount: 2 })));
    await expect(backfill(opts())).rejects.toThrow(/a full page/);
  });

  it('merges coverage: a narrower run keeps the older oldest message and reached_start', async () => {
    await backfill(opts({ from: new Date('2026-08-01T00:00:00.000Z') }));
    const walked = async () => (await db.select().from(chatCoverage).where(eq(chatCoverage.chatId, 2001)))[0]!;
    expect(await walked()).toMatchObject({ oldestMessageId: 101, reachedStart: true });
    const later = new Date(NOW.getTime() + HOUR);
    vi.setSystemTime(later);
    await backfill(opts());
    expect(await walked()).toMatchObject({
      oldestMessageId: 101,
      oldestAt: new Date('2026-08-20T10:00:00.000Z'),
      reachedStart: true,
      walkedAt: later,
      fanUsername: 'fan_one',
    });
  });

  it('stops at once when the signal aborts during a backoff wait', async () => {
    const stop = new AbortController();
    // 5 mass windows, the welcome, the chat list, chat 2003 (one page), chat 2001's first page; its second gets a 429.
    const p = probe({
      before: (n) => {
        if (n === 9) Object.assign(fake.state.of!, { rateLimit: 1, retryAfter: '42' });
      },
    });
    const run = backfill(opts({ upstream: p.upstream, signal: stop.signal }));
    await until(() => p.answered() === 10); // the 429 is in, the 42 s wait has begun (real timers)
    stop.abort();
    const result = await run;
    expect(result).toMatchObject({ stopped: true, requests: 10, chats: 1, transactions: 0 });
    expect(p.started).toHaveLength(10);
    // Chat 2001's walk was cut short, so it records no coverage.
    expect(await counts()).toMatchObject({ messages: 6, coverage: 1, purchases: 0 });
  });

  it('backs off on 429 for Retry-After, then carries on', async () => {
    fakeClock();
    Object.assign(fake.state.of!, { rateLimit: 1, retryAfter: '42' });
    const start = fake.requests.length;
    const p = probe();
    const run = backfill(opts({ upstream: p.upstream }));
    await until(() => p.answered() === 1); // the 429 is in and the wait has begun
    await vi.advanceTimersByTimeAsync(41_999);
    expect(p.started).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => p.started.length === 2);
    expect(p.started[1]! - p.started[0]!).toBe(42_000);
    vi.useRealTimers();
    const result = await run;
    expect(result.requests).toBe(14);
    expect(ofCalls(start).slice(0, 2)).toEqual([ofCalls(start)[0], ofCalls(start)[0]]); // the same window, retried
    expect((await counts()).messages).toBe(12);
  });

  it('caps requests per hour: the third of a cap of 2 waits until the first is an hour old', async () => {
    fakeClock();
    const stop = new AbortController();
    const p = probe();
    const run = backfill(opts({ upstream: p.upstream, signal: stop.signal, config: { pageDelayMs: 0, requestsPerHourPerAccount: 2 } }));
    await until(() => p.answered() === 2);
    await vi.advanceTimersByTimeAsync(HOUR - 1);
    expect(p.started).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => p.started.length === 3);
    expect(p.started[2]! - p.started[0]!).toBe(HOUR);
    stop.abort();
    expect(await run).toMatchObject({ stopped: true });
  });

  it('waits pageDelayMs from the end of the previous response', async () => {
    fakeClock();
    const stop = new AbortController();
    // Each response takes a second of the fake clock.
    const p = probe({ after: () => vi.setSystemTime(Date.now() + 1000) });
    const run = backfill(opts({ upstream: p.upstream, signal: stop.signal, config: { pageDelayMs: 5000 } }));
    await until(() => p.answered() === 1);
    await vi.advanceTimersByTimeAsync(4999);
    expect(p.started).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => p.started.length === 2);
    expect(p.started[1]! - p.started[0]!).toBe(6000); // the 1 s response, then the 5 s delay
    stop.abort();
    expect(await run).toMatchObject({ stopped: true });
  });

  it('retries a 502 after 1 s, then carries on', async () => {
    fakeClock();
    Object.assign(fake.state.of!, { badGateway: 1 });
    const start = fake.requests.length;
    const p = probe();
    const run = backfill(opts({ upstream: p.upstream }));
    await until(() => p.answered() === 1);
    await vi.advanceTimersByTimeAsync(999);
    expect(p.started).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => p.started.length === 2);
    expect(p.started[1]! - p.started[0]!).toBe(1000);
    vi.useRealTimers();
    expect(await run).toMatchObject({ requests: 14, retries: 1, messages: 12 });
    expect(ofCalls(start).slice(0, 2)).toEqual([ofCalls(start)[0], ofCalls(start)[0]]); // the same window, retried
  });

  it('fails the run on the 4th 502 in a row, after waits of 1, 3 and 9 s', async () => {
    fakeClock();
    Object.assign(fake.state.of!, { badGateway: 4 });
    const p = probe();
    const run = backfill(opts({ upstream: p.upstream }));
    const failed = expect(run).rejects.toThrow(/answered 502 to GET \/mass-messaging\/overview/);
    for (const [i, wait] of [1000, 3000, 9000].entries()) {
      await until(() => p.answered() === i + 1);
      await vi.advanceTimersByTimeAsync(wait);
      await until(() => p.started.length === i + 2);
    }
    expect(p.started.slice(1).map((t, i) => t - p.started[i]!)).toEqual([1000, 3000, 9000]);
    vi.useRealTimers();
    await failed;
    expect(p.started).toHaveLength(4);
  });

  it('retries a network error, and does not retry a 4xx', async () => {
    const down: Upstream = { ...upstream, forward: async () => Promise.reject(new AppError(502, 'upstream_unavailable', 'The upstream is unreachable')) };
    await expect(backfill(opts({ upstream: down, config: { pageDelayMs: 0, transientDelaysMs: [0, 0] } }))).rejects.toMatchObject({ code: 'upstream_unavailable' });
    let calls = 0;
    const gone: Upstream = {
      ...upstream,
      forward: async () => {
        calls++;
        return { status: 404, ok: false, headers: new Headers(), body: Buffer.from('{}') };
      },
    };
    await expect(backfill(opts({ upstream: gone }))).rejects.toThrow(/answered 404/);
    expect(calls).toBe(1);
  });

  it('names an expired OF session when the upstream answers 401', async () => {
    let calls = 0;
    const expired: Upstream = {
      ...upstream,
      forward: async () => {
        calls++;
        return { status: 401, ok: false, headers: new Headers(), body: Buffer.from('{"error":{"code":"of_error","status":401}}') };
      },
    };
    await expect(backfill(opts({ upstream: expired }))).rejects.toMatchObject({
      code: 'session_expired',
      message: `OF session expired for account ${ACCOUNT}: re-connect it in Accounts`,
    });
    expect(calls).toBe(1);
  });

  it('fails the run after maxRetries 429s in a row', async () => {
    Object.assign(fake.state.of!, { rateLimit: 3, retryAfter: '0' });
    await expect(backfill(opts({ config: { pageDelayMs: 0, maxRetries: 2 } }))).rejects.toThrow(/answered 429/);
  });
});

describe('analytics tenancy', () => {
  it('scopes reply times to the workspace', async () => {
    await backfill(opts());
    expect(await replyTimes(teamB, ACCOUNT, FROM, TO)).toEqual([]);
    expect(await replyTimes(teamA, ACCOUNT, FROM, TO)).toHaveLength(5);
  });

  it('refuses an account the workspace does not list, and one two workspaces name', async () => {
    await expect(backfill(opts({ teamId: teamB }))).rejects.toMatchObject({ statusCode: 403, code: 'account_not_allowed' });
    const [keyB] = await db.select().from(apiKey).where(eq(apiKey.teamId, teamB));
    await db.update(apiKey).set({ allowedAccountIds: [ACCOUNT] }).where(eq(apiKey.id, keyB!.id));
    await expect(claimAccount(teamB, ACCOUNT)).rejects.toMatchObject({ statusCode: 409, code: 'account_workspace_conflict' });
    await expect(claimAccount(teamA, ACCOUNT)).rejects.toMatchObject({ statusCode: 409, code: 'account_workspace_conflict' });
    await db.update(apiKey).set({ allowedAccountIds: null }).where(eq(apiKey.id, keyB!.id));
  });
});

describe('analytics CSV export', () => {
  it('backfills, then writes the range to four CSVs, with no message text', async () => {
    await backfill(opts());
    expect(await accountTeam(ACCOUNT)).toBe(teamA);
    await expect(accountTeam(9999)).rejects.toThrow(/analytics:claim/);
    const dir = await mkdtemp(join(tmpdir(), 'analytics-'));
    const asOf = new Date('2026-09-02T21:00:00.000Z');
    expect(await writeExport({ teamId: teamA, accountId: ACCOUNT, from: FROM, to: TO, outDir: dir, asOf })).toEqual({
      messages: 11, // 105 is before the range
      chats: 3,
      transactions: 3,
      replyTimes: 5,
    });
    const file = (name: string) => readFile(join(dir, name), 'utf8');
    const header = async (name: string) => (await file(name)).split('\n')[0];
    expect(await header('messages.csv')).toBe(MESSAGE_COLUMNS.join(','));
    expect(await header('chats.csv')).toBe(CHAT_COLUMNS.join(','));
    expect(await header('transactions.csv')).toBe(TRANSACTION_COLUMNS.join(','));
    expect(await header('reply_times.csv')).toBe(REPLY_TIME_COLUMNS.join(','));

    const messages = readCsv(await file('messages.csv'));
    expect(messages.map((m) => m.message_id)).toEqual(['106', '107', '202', '203', '204', '301', '108', '302', '109', '110', '303']);
    expect(messages.find((m) => m.message_id === '108')).toMatchObject({ is_mass: 'true', queue_id: '900', direction: 'outbound', automated_reason: '' });
    expect(messages.find((m) => m.message_id === '107')).toMatchObject({ is_automated: 'true', automated_reason: 'welcome' });
    expect(messages.find((m) => m.message_id === '301')).toMatchObject({ is_tip: 'true', price_cents: '500', text_hash: '', created_at: '2026-09-02T08:00:00.000Z' });
    expect(await file('messages.csv')).not.toMatch(/text 1\d\d|&amp;/); // the raw text stays in the database

    const chats = readCsv(await file('chats.csv'));
    expect(chats.map((c) => [c.chat_id, c.fan_username, c.reached_start, c.messages_total, c.inbound, c.outbound, c.dm, c.mass, c.automated])).toEqual([
      ['2001', 'fan_one', 'false', '5', '2', '3', '1', '1', '1'],
      ['2002', 'fan_two', 'false', '3', '2', '1', '1', '0', '0'],
      ['2003', 'fan_three', 'true', '3', '2', '1', '1', '0', '0'],
    ]);
    expect(chats[0]).toMatchObject({ oldest_message_id: '105', oldest_at: '2026-08-31T20:00:00.000Z' });

    const tx = readCsv(await file('transactions.csv'));
    expect(tx.map((t) => [t.tx_id, t.kind, t.gross_cents, t.net_cents, t.currency, t.fan_id, t.fan_id_source])).toEqual([
      ['tx0', 'tip', '200', '160', 'USD', '', ''],
      ['tx1', 'tip', '500', '400', 'USD', '2003', 'description'],
      ['tx2', 'message', '1999', '1599', 'USD', '2001', 'field'],
    ]);

    const turns = readCsv(await file('reply_times.csv'));
    expect(turns.map((t) => [t.chat_id, t.inbound_at, t.dm_at, t.wait_seconds, t.status, t.breached, t.is_automated])).toEqual([
      ['2001', '2026-09-01T09:00:00.000Z', '2026-09-02T12:00:00.000Z', '97200', 'late', 'false', 'true'],
      ['2002', '2026-09-01T14:00:00.000Z', '2026-09-01T14:30:00.000Z', '1800', 'in_cap', 'false', 'false'],
      ['2002', '2026-09-01T15:00:00.000Z', '', '', 'breached', 'true', 'false'],
      ['2003', '2026-09-02T08:00:00.000Z', '2026-09-02T09:00:00.000Z', '3600', 'in_cap', 'false', 'false'],
      ['2003', '2026-09-02T20:00:00.000Z', '', '', 'pending', 'false', 'false'],
    ]);
  });

  it('dry run: makes the same requests, stores nothing, and writes the same CSVs as a stored run', async () => {
    const asOf = new Date('2026-09-02T21:00:00.000Z');
    const before = await counts();
    expect(before).toMatchObject({ messages: 0, coverage: 0, purchases: 0 });
    const start = fake.requests.length;
    const rows: BackfillRows = { messages: [], chats: [], transactions: [] };
    // Workspace B cannot claim the account (see analytics tenancy): the dry run passing proves it claims nothing.
    const dry = await backfill(opts({ teamId: teamB, rows }));
    const dryCalls = ofCalls(start);
    expect(await counts()).toEqual(before); // no rows, coverage, purchases or scripts
    const dryDir = await mkdtemp(join(tmpdir(), 'analytics-'));
    expect(await writeRowsExport({ rows, from: FROM, to: TO, outDir: dryDir, asOf })).toEqual({ messages: 11, chats: 3, transactions: 3, replyTimes: 5 });

    const storedStart = fake.requests.length;
    expect(await backfill(opts())).toEqual(dry);
    expect(ofCalls(storedStart)).toEqual(dryCalls);
    const dir = await mkdtemp(join(tmpdir(), 'analytics-'));
    await writeExport({ teamId: teamA, accountId: ACCOUNT, from: FROM, to: TO, outDir: dir, asOf });
    for (const name of ['messages.csv', 'chats.csv', 'transactions.csv', 'reply_times.csv']) {
      expect(await readFile(join(dryDir, name), 'utf8')).toBe(await readFile(join(dir, name), 'utf8'));
    }
  });

  it('reads the automation texts file: one per line, blank lines ignored', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'analytics-'));
    await writeFile(join(dir, 'automation.txt'), 'brb babe\r\n\n  \nHey, you up?\n');
    expect(await readAutomationTexts(join(dir, 'automation.txt'))).toEqual(['brb babe', 'Hey, you up?']);
  });

  it('exports only the rows of the given workspace', async () => {
    await backfill(opts());
    const dir = await mkdtemp(join(tmpdir(), 'analytics-'));
    expect(await writeExport({ teamId: teamB, accountId: ACCOUNT, from: FROM, to: TO, outDir: dir })).toEqual({
      messages: 0,
      chats: 0,
      transactions: 0,
      replyTimes: 0,
    });
  });
});
