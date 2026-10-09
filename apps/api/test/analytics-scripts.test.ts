import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { db, pool } from '../src/db/index.js';
import { messageFact, script } from '../src/db/schema.js';
import { createUpstream } from '../src/lib/upstream.js';
import { scriptHash } from '../src/modules/analytics/derive.js';
import { rehashAccount, syncScripts } from '../src/modules/analytics/scripts.js';
import { startFakeUpstream, type FakeOf } from './fake-upstream.js';
import { bearer, claimAndBackfill, createKey, linkTeam, resetDb, signUp } from './helpers.js';

// Script candidates (spec §6 step 3) over a backfill from the fake upstream, with known answers.

const TOKEN = 'test-only-upstream-token';
const A1 = 1001;
const A2 = 1002;
/** The clock for every request: `as_of`, so the send to Dee is pending. */
const NOW = new Date('2026-09-20T12:00:00.000Z');

const app = await buildApp({ logger: false });
const fake = await startFakeUpstream(TOKEN);
const upstream = createUpstream({ url: fake.url, token: TOKEN, timeoutMs: 2000 });

/** S1, personalised per fan: one script. S2: 5 sends in 2 chats, not a script. */
const S1 = (name: string) => `<p>Hey ${name}, I just made something special for you 😘</p>`;
const S2 = '<p>did you see my new post babe? 🔥</p>';
const msg = (id: number, at: string, from: number, text: string, over: Record<string, unknown> = {}) => ({
  id,
  createdAt: `2026-${at}:00.000Z`,
  fromUser: { id: from },
  text,
  price: 0,
  isTip: false,
  mediaCount: 0,
  media: [],
  queueId: null,
  ...over,
});
type User = { name?: string; username?: string; displayName?: string };
const of = (messages: FakeOf['messages'], users: Record<number, User>): FakeOf => ({
  chats: Object.entries(messages).map(([id, [last]]) => ({
    withUser: { id: Number(id), ...users[Number(id)] },
    lastMessage: { id: Number(last!.id), createdAt: String(last!.createdAt) },
  })),
  messages,
  mass: [{ id: 900, date: '2026-09-11T12:00:00Z', sentCount: 50 }],
  transactions: [],
  welcome: { id: '7001', template: 'reply_on_subscribe', text: '<p>welcome!</p>', media: [] },
});

/**
 * S1 sends, by outbound sequence (open_reply 24 h, min_reply_chars 15, as_of 09-20 12:00); all times UTC:
 * 1001/3001 Anna (name)       DM 101 09-11 10:00 → fan 102 "omg what is it?? show me" 1 h later: replied, substantive
 *                             (mass 103 with the same text is not a send)
 * 1001/3002 Bob (name)        DM 201 09-12 10:00 + DM 202 10:01 → fan 203 "ok" 20:00: replied, not substantive
 * 1001/3002 Bobby boy (custom) DM 204 09-14 10:00, no fan message: no reply
 * 1001/3003 carl99 (username) DM 301 09-13 10:00 + DM 302 12:00 (2 sends, 1 sequence) → fan 303 25 h after 302: no reply
 * 1001/3004 Dee (name)        DM 401 09-20 02:00, 10 h old: pending
 * 1002/4001 Eve (name)        DM 501 09-15 10:00 → fan 502 "hi! what did you make me" 30 min later: replied, substantive
 * S2: 3 sends in 3001 (11-13) and 2 in 3002 (21, 22), 09-01 to 09-03.
 */
const DATA_A1 = of(
  {
    3001: [
      msg(103, '09-11T12:00', A1, S1('Anna'), { queueId: 900, isFromQueue: true }),
      msg(102, '09-11T11:00', 3001, '<p>omg what is it?? show me</p>'),
      msg(101, '09-11T10:00', A1, S1('Anna')),
      msg(14, '09-04T10:00', 3001, 'hey'),
      msg(13, '09-03T10:00', A1, S2),
      msg(12, '09-02T10:00', A1, S2),
      msg(11, '09-01T10:00', A1, S2),
      msg(10, '09-01T09:00', 3001, 'hi'),
    ],
    3002: [
      msg(204, '09-14T10:00', A1, S1('Bobby boy')),
      msg(203, '09-12T20:00', 3002, 'ok'),
      msg(202, '09-12T10:01', A1, "<p>you'll love it</p>"),
      msg(201, '09-12T10:00', A1, S1('Bob')),
      msg(23, '09-03T10:00', 3002, 'lol'),
      msg(22, '09-02T10:00', A1, S2),
      msg(21, '09-01T10:00', A1, S2),
    ],
    3003: [msg(303, '09-14T13:00', 3003, 'hello there handsome'), msg(302, '09-13T12:00', A1, S1('carl99')), msg(301, '09-13T10:00', A1, S1('carl99'))],
    3004: [msg(401, '09-20T02:00', A1, S1('Dee'))],
  },
  { 3001: { name: 'Anna' }, 3002: { name: 'Bob', displayName: 'Bobby boy' }, 3003: { username: 'carl99' }, 3004: { name: 'Dee' } },
);
const DATA_A2 = of({ 4001: [msg(502, '09-15T10:30', 4001, 'hi! what did you make me'), msg(501, '09-15T10:00', A2, S1('Eve'))] }, { 4001: { name: 'Eve' } });

const HASH = scriptHash(S1('Anna'), ['Anna'])!;

let teamA: string;
let keyA: string;
let limitedKeyA: string;
let keyB: string;

const get = (url: string, key = keyA) => app.inject({ method: 'GET', url, headers: bearer(key) });
const RANGE = 'from=2026-09-10&to=2026-09-20';
const scripts = async (q = RANGE, key = keyA) => {
  const res = await get(`/v1/stats/scripts?${q}`, key);
  expect(res.statusCode).toBe(200);
  return res.json() as { items: Record<string, unknown>[]; normaliserVersion: number; asOf: string; from: string; to: string };
};
const hashes = async () =>
  (await db.select({ id: messageFact.messageId, hash: messageFact.textHash, v: messageFact.normaliserVersion }).from(messageFact).orderBy(asc(messageFact.messageId))).map(
    (r) => [r.id, r.hash, r.v],
  );
const scriptRows = () => db.select().from(script).orderBy(asc(script.teamId), asc(script.hash));

beforeAll(async () => {
  await resetDb();
  const a = await signUp(app, 'scripts-a@example.test');
  const b = await signUp(app, 'scripts-b@example.test');
  teamA = a.teamId;
  await linkTeam(a.teamId);
  await linkTeam(b.teamId);
  keyA = (await createKey(app, a.cookie, { scope: 'read', allowedAccountIds: [A1, A2] })).secret;
  limitedKeyA = (await createKey(app, a.cookie, { scope: 'read', allowedAccountIds: [A2] })).secret;
  keyB = (await createKey(app, b.cookie, { scope: 'read' })).secret; // no allowlist: still none of A's accounts

  await pool.query('TRUNCATE message_fact, chat_coverage, purchase_fact, script, stats_config');
  vi.setSystemTime(NOW);
  const run = { upstream, teamId: a.teamId, from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-09-21T00:00:00Z'), config: { pageDelayMs: 0 } };
  fake.state.of = DATA_A1;
  await claimAndBackfill({ ...run, accountId: A1 });
  fake.state.of = DATA_A2;
  await claimAndBackfill({ ...run, accountId: A2 });
});
afterAll(async () => {
  vi.useRealTimers();
  await app.close();
  await fake.close();
  await pool.end();
});

describe('script detection in the backfill', () => {
  it("hashes each send with the fan's name, username or custom name as <name>", async () => {
    const byId = Object.fromEntries((await hashes()).map(([id, hash, v]) => [id, { hash, v }]));
    for (const id of [101, 201, 204, 301, 302, 401, 501]) expect(byId[id]).toEqual({ hash: HASH, v: 1 });
    expect(byId[202]).toEqual({ hash: null, v: 1 }); // "you'll love it": 3 words, 14 characters
    expect(byId[102]).toEqual({ hash: null, v: null }); // inbound
    expect(byId[11]!.hash).toBe(scriptHash(S2));
  });

  it('stores only hashes sent 5+ times in 3+ chats within 30 days, as auto scripts', async () => {
    expect(await scriptRows()).toEqual([
      {
        teamId: teamA,
        hash: HASH,
        origin: 'auto',
        normaliserVersion: 1,
      },
    ]);
  });
});

describe('GET /v1/stats/scripts', () => {
  it('aggregates sends, chats, reply rate per outbound sequence with pending, and exact variants', async () => {
    const res = await scripts();
    expect(res).toMatchObject({ normaliserVersion: 1, asOf: NOW.toISOString(), from: '2026-09-10', to: '2026-09-20' });
    expect(res.items).toEqual([
      {
        hash: HASH,
        origin: 'auto',
        sends: 7,
        chats: 5,
        sendsAll: 7, // mass 103 with the same text is not a send
        chatsAll: 5,
        firstSentAt: '2026-09-11T10:00:00.000Z',
        lastSentAt: '2026-09-20T02:00:00.000Z',
        sequences: 6,
        replied: 3,
        noReply: 2,
        pending: 1,
        replyRate: 60,
        substantiveReplied: 2,
        substantiveNoReply: 3,
        substantivePending: 1,
        substantiveReplyRate: 40,
        variantCount: 6,
        variants: [
          { text: S1('carl99'), count: 2 },
          { text: S1('Anna'), count: 1 },
          { text: S1('Bob'), count: 1 },
          { text: S1('Bobby boy'), count: 1 },
          { text: S1('Dee'), count: 1 },
        ],
      },
    ]);
  });

  it('counts only sends in the range, and a sequence once', async () => {
    const [s] = (await scripts('from=2026-09-12&to=2026-09-13')).items; // 201, 301, 302
    expect(s).toMatchObject({ sends: 3, chats: 2, sendsAll: 7, chatsAll: 5, sequences: 2, replied: 1, noReply: 1, pending: 0, replyRate: 50, variantCount: 2 });
    expect((await scripts('from=2026-09-01&to=2026-09-05')).items).toEqual([]); // S2 only: not a script
  });

  it('a script found over the history with one send in range: sends 1, first and last send equal', async () => {
    // DM 501 to Eve (A2) is S1's only send on 09-15; S1 is a script by A1's sends.
    expect((await scripts(`from=2026-09-15&to=2026-09-15`)).items).toMatchObject([
      { hash: HASH, sends: 1, chats: 1, firstSentAt: '2026-09-15T10:00:00.000Z', lastSentAt: '2026-09-15T10:00:00.000Z' },
    ]);
  });

  it('sendsAll and chatsAll count every stored send of the accounts in scope, in range or not', async () => {
    // In range only 204 (A1, 09-14); all history: A1 101, 201, 204, 301, 302, 401 in 4 chats, A2 501 in 1.
    const one = async (q: string, key = keyA) => (await scripts(q, key)).items.map((i) => [i.sends, i.chats, i.sendsAll, i.chatsAll]);
    expect(await one(`from=2026-09-14&to=2026-09-14&accountId=${A1}`)).toEqual([[1, 1, 6, 4]]);
    expect(await one('from=2026-09-14&to=2026-09-14')).toEqual([[1, 1, 7, 5]]);
    expect(await one('from=2026-09-15&to=2026-09-15', limitedKeyA)).toEqual([[1, 1, 1, 1]]); // A2 only
    expect(await one('from=2026-08-01&to=2026-08-31')).toEqual([]); // no send in range: not listed
  });

  it("counts each script's own sends when one sequence holds two scripts", async () => {
    // A second (registered by hand) script sent 11 s before an S1 send, in one sequence on A2.
    const other = scriptHash(S2)!;
    const row = (messageId: number, at: string, text: string, textHash: string) => ({
      teamId: teamA,
      accountId: A2,
      messageId,
      chatId: 4002,
      direction: 'outbound' as const,
      createdAt: new Date(at),
      isMass: false,
      isAutomated: false,
      priceCents: 0,
      isTip: false,
      tipCents: 0,
      isOpened: false,
      mediaCount: 0,
      textHash,
      normaliserVersion: 1,
      raw: { id: messageId, text },
      fetchedAt: NOW,
    });
    await db.insert(script).values({ teamId: teamA, hash: other, normaliserVersion: 1 });
    await db.insert(messageFact).values([row(601, '2026-09-16T09:31:25.000Z', S2, other), row(602, '2026-09-16T09:31:36.000Z', S1('Fay'), HASH)]);
    try {
      const items = (await scripts(`from=2026-09-16&to=2026-09-16&accountId=${A2}`)).items;
      expect(Object.fromEntries(items.map((i) => [i.hash, [i.sends, i.chats, i.firstSentAt, i.lastSentAt, i.sequences]]))).toEqual({
        [HASH]: [1, 1, '2026-09-16T09:31:36.000Z', '2026-09-16T09:31:36.000Z', 1],
        [other]: [1, 1, '2026-09-16T09:31:25.000Z', '2026-09-16T09:31:25.000Z', 1],
      });
      // On A2: HASH 501 and 602 in 4001 and 4002; the other only 601.
      expect(Object.fromEntries(items.map((i) => [i.hash, [i.sendsAll, i.chatsAll]]))).toEqual({ [HASH]: [2, 2], [other]: [1, 1] });
    } finally {
      await pool.query('DELETE FROM message_fact WHERE message_id IN (601, 602)');
      await pool.query('DELETE FROM script WHERE hash = $1', [other]);
    }
  });

  it('leaves out hashes of another normaliser version, in sends and in detection', async () => {
    await pool.query('UPDATE message_fact SET normaliser_version = 0 WHERE message_id IN (301, 302)');
    try {
      expect((await scripts()).items).toMatchObject([{ hash: HASH, sends: 5, chats: 4, sendsAll: 5, chatsAll: 4 }]);
      expect(await syncScripts(teamA, A1)).toBe(0); // 4 current sends left on A1: not a script there
      await pool.query('UPDATE script SET normaliser_version = 0');
      expect((await scripts()).items).toEqual([]); // a script row of another version is not read
    } finally {
      await pool.query('UPDATE message_fact SET normaliser_version = 1 WHERE message_id IN (301, 302)');
      await pool.query('UPDATE script SET normaliser_version = 1');
    }
  });

  it('reads open_reply and min_reply_chars from the stats config', async () => {
    await pool.query(
      `INSERT INTO stats_config (team_id, open_reply_seconds, min_reply_chars) VALUES ($1, $2, 2)
       ON CONFLICT (team_id) DO UPDATE SET open_reply_seconds = excluded.open_reply_seconds, min_reply_chars = 2`,
      [teamA, 26 * 3600],
    );
    try {
      // 303 (25 h after 302) is now within open_reply, and "ok" is substantive.
      const [s] = (await scripts()).items;
      expect(s).toMatchObject({ replied: 4, noReply: 1, pending: 1, substantiveReplied: 4, substantiveNoReply: 1 });
    } finally {
      await pool.query('TRUNCATE stats_config');
    }
  });

  it('scopes to the key allowlist and the accountId filter; limit caps the items', async () => {
    const [a2] = (await scripts(RANGE, limitedKeyA)).items;
    expect(a2).toMatchObject({ sends: 1, chats: 1, sequences: 1, replied: 1, replyRate: 100, variantCount: 1, variants: [{ text: S1('Eve'), count: 1 }] });
    const [a1] = (await scripts(`${RANGE}&accountId=${A1}`)).items;
    expect(a1).toMatchObject({ sends: 6, chats: 4, sequences: 5, replied: 2, noReply: 2, pending: 1, replyRate: 50, substantiveReplyRate: 25 });
    const denied = await get(`/v1/stats/scripts?${RANGE}&accountId=${A1}`, limitedKeyA);
    expect([denied.statusCode, denied.json().error.code]).toEqual([403, 'account_not_allowed']);
    expect((await scripts(`${RANGE}&limit=1`)).items).toHaveLength(1);
    for (const limit of [0, 201]) expect((await get(`/v1/stats/scripts?${RANGE}&limit=${limit}`)).statusCode).toBe(400);
  });

  it("a second workspace's key sees none of the first's scripts", async () => {
    expect((await scripts(RANGE, keyB)).items).toEqual([]);
    expect((await scripts(`${RANGE}&accountId=${A1}`, keyB)).items).toEqual([]);
  });

  it('an unlinked workspace gets 409 team_not_linked', async () => {
    const other = await signUp(app, 'scripts-unlinked@example.test');
    const { secret } = await createKey(app, other.cookie, { scope: 'read' });
    const res = await get('/v1/stats/scripts', secret);
    expect([res.statusCode, res.json().error.code]).toEqual([409, 'team_not_linked']);
  });
});

describe('rehash', () => {
  it('rebuilds text_hash from the raw text and chat names, syncs scripts, and is idempotent', async () => {
    const before = await hashes();
    const rows = await scriptRows();
    await pool.query('UPDATE message_fact SET text_hash = NULL, normaliser_version = NULL');
    await pool.query('TRUNCATE script');

    expect(await rehashAccount(teamA, A1)).toEqual({ outbound: 13, updated: 13, scripts: 1 });
    expect(await rehashAccount(teamA, A2)).toEqual({ outbound: 1, updated: 1, scripts: 0 }); // one send: a script only by A1's
    expect(await hashes()).toEqual(before);
    expect(await scriptRows()).toEqual(rows);

    expect(await rehashAccount(teamA, A1)).toEqual({ outbound: 13, updated: 0, scripts: 1 });
    expect(await hashes()).toEqual(before);
    expect(await scriptRows()).toEqual(rows);
  });

  it("touches only the given workspace's rows", async () => {
    const other = await signUp(app, 'scripts-rehash@example.test');
    expect(await rehashAccount(other.teamId, A1)).toEqual({ outbound: 0, updated: 0, scripts: 0 });
    expect(await db.select().from(script).where(eq(script.teamId, other.teamId))).toEqual([]);
  });
});
