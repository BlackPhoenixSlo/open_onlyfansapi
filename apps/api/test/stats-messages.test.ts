import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { db, pool } from '../src/db/index.js';
import { purchaseFact } from '../src/db/schema.js';
import { createUpstream } from '../src/lib/upstream.js';
import { messageExport } from '../src/modules/analytics/messages.js';
import { startFakeUpstream, type FakeOf } from './fake-upstream.js';
import { bearer, claimAndBackfill, createKey, dashboard, linkTeam, resetDb, signUp } from './helpers.js';

// The stored messages per fan (`GET /v1/stats/fans`) and the transcript export (`GET /v1/stats/messages`), over a
// backfill from the fake upstream.

const TOKEN = 'test-only-upstream-token';
const A1 = 1001;
const A2 = 1002;

const app = await buildApp({ logger: false });
const fake = await startFakeUpstream(TOKEN);
const upstream = createUpstream({ url: fake.url, token: TOKEN, timeoutMs: 2000 });

const msg = (id: number, at: string, from: number, over: Record<string, unknown> = {}) => ({
  id,
  createdAt: `2026-${at}:00.000Z`,
  fromUser: { id: from },
  text: '<p>ok</p>',
  price: 0,
  isFree: true,
  isOpened: false,
  isLiked: false,
  previews: [],
  giphyId: null,
  isTip: false,
  mediaCount: 0,
  media: [],
  queueId: null,
  ...over,
});
const of = (messages: FakeOf['messages'], usernames: Record<number, string> = {}): FakeOf => ({
  chats: Object.entries(messages).map(([id, [last]]) => ({
    withUser: { id: Number(id), ...(usernames[Number(id)] ? { username: usernames[Number(id)] } : {}) },
    lastMessage: { id: Number(last!.id), createdAt: String(last!.createdAt) },
  })),
  messages,
  mass: [{ id: 900, date: '2026-09-02T09:00:00Z', sentCount: 50 }],
  transactions: [],
  welcome: { id: '7001', template: 'reply_on_subscribe', text: '<p>welcome!</p>', media: [] },
});

const media = (id: number, type: string) => ({ id, type, canView: true, hasError: false, isReady: true, files: {} });
const ppv = (price: number, isOpened: boolean) => ({ price, isFree: false, isOpened, canPurchaseReason: isOpened ? 'opened' : '' });

/**
 * Account 1001: fan 3001 (@fan_a) with a message before the range and two at the same instant (a tip, and a liked GIPHY
 * reply that is deleted below), a bought PPV and a mass PPV; fan 3002 (@fan_b, but its coverage row is moved to
 * workspace B below) with an unbought PPV; 3003 only got the welcome message and a mass message. Account 1002: fan
 * 4001 (@fan_c, its coverage row deleted below).
 */
const DATA_A1 = of(
  {
    3001: [
      msg(8, '09-02T10:00', 3001, { text: '<p title="1 > 0">lo<b>ve</b> &#39;u&#x27;</p>', giphyId: 'g1', isLiked: true, replyToMessage: { id: 2 } }),
      msg(4, '09-02T10:00', 3001, { text: '<p>-_- @name +1, "quoted"</p>', isTip: true, tipAmount: 5 }),
      msg(3, '09-02T09:00', A1, { queueId: 900, isFromQueue: true, ...ppv(10, true) }),
      msg(2, '09-01T10:05', A1, { text: '<p>Hello <b>You</b></p>', ...ppv(12.5, true), mediaCount: 2, media: [media(51, 'photo'), media(52, 'video')], previews: [51] }),
      msg(1, '09-01T10:00', 3001, { text: '<p>Hey &amp; hi 😊</p>' }),
      msg(5, '08-20T10:00', 3001),
    ],
    3002: [msg(7, '09-03T08:30', A1, { ...ppv(3, false), mediaCount: 1, media: [media(53, 'audio')] }), msg(6, '09-03T08:00', 3002, { text: null })],
    3003: [msg(32, '09-02T09:00', A1, { queueId: 900, isFromQueue: true }), msg(31, '09-01T08:00', A1, { text: '<p>welcome!</p>' })],
  },
  { 3001: 'fan_a', 3002: 'fan_b' },
);
const DATA_A2 = of({ 4001: [msg(22, '09-01T22:20', A2), msg(21, '09-01T22:00', 4001)] }, { 4001: 'fan_c' });

let teamA: string;
let cookieA: string;
let keyA: string;
let limitedKeyA: string;
let keyB: string;

const get = (url: string, key = keyA) => app.inject({ method: 'GET', url, headers: bearer(key) });
const RANGE = 'from=2026-09-01&to=2026-09-04';
const HEADER =
  'account_id,chat_id,fan_username,message_id,created_at,direction,text,price_cents,is_free,is_opened,is_tip,tip_cents,media_count,photos,videos,gifs,audios,has_preview,is_mass,is_automated,automated_reason,is_reply,is_liked,deleted_at\n';
const DELETED_AT = '2026-09-03T12:00:00.000Z';
const ALL_IDS = [1, 2, 3, 4, 8, 6, 7, 31, 32, 21, 22];
const fans = async (q: string, key = keyA) => {
  const res = await get(`/v1/stats/fans?${q}`, key);
  expect(res.statusCode).toBe(200);
  return (res.json().items as { accountId: number; chatId: number }[]).map((f) => [f.accountId, f.chatId]);
};
const messageIds = async (q: string, key = keyA) => {
  const res = await get(`/v1/stats/messages?${q}`, key);
  expect(res.statusCode).toBe(200);
  return (res.json().items as { messageId: number }[]).map((m) => m.messageId);
};
const csvIds = (body: string) => body.split('\n').slice(1, -1).map((line) => Number(line.split(',')[3]));

beforeAll(async () => {
  await resetDb();
  const a = await signUp(app, 'messages-a@example.test');
  const b = await signUp(app, 'messages-b@example.test');
  teamA = a.teamId;
  cookieA = a.cookie;
  await linkTeam(a.teamId);
  await linkTeam(b.teamId);
  keyA = (await createKey(app, a.cookie, { scope: 'read', allowedAccountIds: [A1, A2] })).secret;
  limitedKeyA = (await createKey(app, a.cookie, { scope: 'read', allowedAccountIds: [A2] })).secret;
  keyB = (await createKey(app, b.cookie, { scope: 'read' })).secret;

  await pool.query('TRUNCATE message_fact, chat_coverage, purchase_fact, stats_config');
  const run = { upstream, teamId: a.teamId, from: new Date('2026-08-01T00:00:00Z'), to: new Date('2026-09-05T00:00:00Z'), config: { pageDelayMs: 0 } };
  fake.state.of = DATA_A1;
  await claimAndBackfill({ ...run, accountId: A1 });
  fake.state.of = DATA_A2;
  await claimAndBackfill({ ...run, accountId: A2 });
  // Another workspace's coverage row for the chat must not name the fan; a chat with no coverage row has no name.
  await pool.query('UPDATE chat_coverage SET team_id = $1 WHERE account_id = $2 AND chat_id = 3002', [b.teamId, A1]);
  await pool.query('DELETE FROM chat_coverage WHERE account_id = $1 AND chat_id = 4001', [A2]);
  // An unsent message stays, marked.
  await pool.query('UPDATE message_fact SET deleted_at = $1 WHERE account_id = $2 AND message_id = 8', [DELETED_AT, A1]);
});
afterAll(async () => {
  await app.close();
  await fake.close();
  await pool.end();
});

describe('stats fans', () => {
  it('splits each fan\'s messages into fan, DM, mass and automated; latest fan message first, silent fans last', async () => {
    const res = await get(`/v1/stats/fans?${RANGE}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ timezone: 'UTC', configVersion: 1, from: '2026-09-01', to: '2026-09-04', total: 4 });
    const fan = (accountId: number, chatId: number, fanUsername: string | null, counts: number[], firstAt: string, lastAt: string, lastFanAt: string | null) => {
      const [fanMessages, dmMessages, massMessages, automatedMessages, ppvSent, ppvOpened, tips, tipCents] = counts;
      const iso = (t: string | null) => (t ? `2026-${t}:00.000Z` : null);
      return {
        accountId,
        chatId,
        fanUsername,
        fanMessages,
        dmMessages,
        massMessages,
        automatedMessages,
        ppvSent,
        ppvOpened,
        tips,
        tipCents,
        firstAt: iso(firstAt),
        lastAt: iso(lastAt),
        lastFanAt: iso(lastFanAt),
        gross: 0,
        grossAllTime: 0,
        isDeleted: false,
        hasChat: true,
      };
    };
    expect(body.items).toEqual([
      fan(A1, 3002, null, [1, 1, 0, 0, 1, 0, 0, 0], '09-03T08:00', '09-03T08:30', '09-03T08:00'), // coverage row is workspace B's
      // The deleted message 8 still counts; the mass PPV 3 is not a PPV sent.
      fan(A1, 3001, 'fan_a', [3, 1, 1, 0, 1, 1, 1, 500], '09-01T10:00', '09-02T10:00', '09-02T10:00'),
      fan(A2, 4001, null, [1, 1, 0, 0, 0, 0, 0, 0], '09-01T22:00', '09-01T22:20', '09-01T22:00'), // no coverage row
      fan(A1, 3003, null, [0, 0, 1, 1, 0, 0, 0, 0], '09-01T08:00', '09-02T09:00', null), // later lastAt than 4001, but no fan message
    ]);
    const limited = (await get(`/v1/stats/fans?${RANGE}&limit=1`)).json();
    expect([limited.total, limited.items.map((f: { chatId: number }) => f.chatId)]).toEqual([4, [3002]]);
    expect(await fans('from=2026-08-01&to=2026-08-31')).toEqual([[A1, 3001]]);
  });

  it('carries booked spend in the range and all time, most in the range first; lists payers with no stored chat; searches', async () => {
    const tx = (txId: string, accountId: number, fanId: number | null, gross: number, at: string, status: string, user?: Record<string, unknown>) => ({
      teamId: teamA,
      accountId,
      txId,
      fanId,
      fanIdSource: fanId === null ? null : ('field' as const),
      kind: 'message',
      grossCents: gross,
      netCents: gross - 100,
      currency: 'USD',
      createdAt: new Date(`2026-${at}:00.000Z`),
      raw: { id: txId, status, ...(user && { user }) },
    });
    await db.insert(purchaseFact).values([
      tx('s1', A1, 3003, 700, '09-02T12:00', 'done'),
      tx('s2', A1, 3003, 900, '08-15T12:00', 'done'), // before the range: all time only
      tx('s3', A1, 3001, 500, '09-01T12:00', 'loading'),
      tx('s4', A1, 3001, 9000, '09-02T12:00', 'undo'), // refunded: not booked
      tx('s5', A1, 3009, 600, '09-02T13:00', 'done', { id: 3009, name: 'Gone Fan', username: 'gone', isDeleted: true }), // no stored chat
      tx('s6', A1, 3010, 400, '08-20T12:00', 'done', { id: 3010, username: 'old_payer' }), // no chat, paid before the range only: not listed
      tx('s7', A1, null, 800, '09-02T14:00', 'done'), // unknown fan
      tx('s8', A2, 4009, 50, '09-03T12:00', 'done', { id: 4009, username: 'other' }), // no chat, on account A2
    ]);
    try {
      const body = (await get(`/v1/stats/fans?${RANGE}`)).json();
      const spend = (f: { accountId: number; chatId: number; gross: number; grossAllTime: number; isDeleted: boolean; hasChat: boolean }) => [
        f.accountId,
        f.chatId,
        f.gross,
        f.grossAllTime,
        f.isDeleted,
        f.hasChat,
      ];
      expect(body.total).toBe(6);
      // Most gross in the range first; the rest keep the latest-fan-message order.
      expect(body.items.map(spend)).toEqual([
        [A1, 3003, 700, 1600, false, true],
        [A1, 3009, 600, 600, true, false],
        [A1, 3001, 500, 500, false, true],
        [A2, 4009, 50, 50, false, false],
        [A1, 3002, 0, 0, false, true],
        [A2, 4001, 0, 0, false, true],
      ]);
      expect(body.items[1]).toMatchObject({ fanUsername: 'gone', fanMessages: 0, dmMessages: 0, ppvSent: 0, firstAt: null, lastAt: null, lastFanAt: null });

      // Search: trimmed, any case, a leading @; username (chat list or the payer's transaction), name or chat id.
      expect(await fans(`${RANGE}&search=${encodeURIComponent('  @FAN_A ')}`)).toEqual([[A1, 3001]]);
      expect(await fans(`${RANGE}&search=gone%20f`)).toEqual([[A1, 3009]]);
      expect(await fans(`${RANGE}&search=4001`)).toEqual([[A2, 4001]]);
      expect(await fans(`${RANGE}&search=nobody`)).toEqual([]);
      expect(await fans(`${RANGE}&search=%20`)).toHaveLength(6);
      expect(await fans(`${RANGE}&accountId=${A2}`)).toEqual([
        [A2, 4009],
        [A2, 4001],
      ]);
    } finally {
      await pool.query('TRUNCATE purchase_fact');
    }
  });
});

describe('stats messages', () => {
  it('returns the plain-text messages by account, chat and time, with the money, media, kind and deleted columns', async () => {
    const res = await get(`/v1/stats/messages?${RANGE}&accountId=${A1}&chatId=3001`);
    expect(res.statusCode).toBe(200);
    const m = {
      accountId: A1,
      chatId: 3001,
      fanUsername: 'fan_a',
      priceCents: 0,
      isFree: true,
      isOpened: false,
      isTip: false,
      tipCents: 0,
      mediaCount: 0,
      photos: 0,
      videos: 0,
      gifs: 0,
      audios: 0,
      hasPreview: false,
      isMass: false,
      isAutomated: false,
      automatedReason: null,
      isReply: false,
      isLiked: false,
      deletedAt: null,
    };
    const bought = { priceCents: 1250, isFree: false, isOpened: true, mediaCount: 2, photos: 1, videos: 1, hasPreview: true };
    expect(res.json()).toMatchObject({ truncated: false });
    expect(res.json().items).toEqual([
      { ...m, messageId: 1, createdAt: '2026-09-01T10:00:00.000Z', direction: 'inbound', text: 'Hey & hi 😊' },
      { ...m, messageId: 2, createdAt: '2026-09-01T10:05:00.000Z', direction: 'outbound', text: 'Hello You', ...bought },
      { ...m, messageId: 3, createdAt: '2026-09-02T09:00:00.000Z', direction: 'outbound', text: 'ok', isMass: true, priceCents: 1000, isFree: false, isOpened: true },
      { ...m, messageId: 4, createdAt: '2026-09-02T10:00:00.000Z', direction: 'inbound', text: '-_- @name +1, "quoted"', isTip: true, tipCents: 500 },
      { ...m, messageId: 8, createdAt: '2026-09-02T10:00:00.000Z', direction: 'inbound', text: "love 'u'", gifs: 1, isReply: true, isLiked: true, deletedAt: DELETED_AT },
    ]);
    const unbought = (await get(`/v1/stats/messages?${RANGE}&chatId=3002&direction=out`)).json().items;
    expect(unbought).toMatchObject([{ messageId: 7, priceCents: 300, isFree: false, isOpened: false, mediaCount: 1, audios: 1 }]);
    const other = (await get(`/v1/stats/messages?${RANGE}&chatId=3002`)).json().items;
    expect(other.map((x: { fanUsername: string | null }) => x.fanUsername)).toEqual([null, null]);
    expect(await messageIds(RANGE)).toEqual(ALL_IDS);
    const cut = (await get(`/v1/stats/messages?${RANGE}&limit=3`)).json();
    expect([cut.truncated, cut.items.map((x: { messageId: number }) => x.messageId)]).toEqual([true, [1, 2, 3]]);
    expect((await get(`/v1/stats/messages?${RANGE}&limit=${ALL_IDS.length}`)).json()).toMatchObject({ truncated: false, nextCursor: null });
    const welcome = (await get(`/v1/stats/messages?${RANGE}&chatId=3003`)).json().items;
    expect(welcome.map((x: { isAutomated: boolean; automatedReason: string | null }) => [x.isAutomated, x.automatedReason])).toEqual([
      [true, 'welcome'],
      [false, null],
    ]);
  });

  it('pages JSON with cursor = nextCursor, across messages of the same instant, to the whole range', async () => {
    const ids: number[] = [];
    let cursor: string | null = null;
    for (let pages = 1; ; pages++) {
      const res = await get(`/v1/stats/messages?${RANGE}&limit=4${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.statusCode).toBe(200);
      const page = res.json();
      ids.push(...page.items.map((x: { messageId: number }) => x.messageId));
      expect(page.truncated).toBe(page.nextCursor !== null);
      cursor = page.nextCursor;
      if (!cursor) {
        expect(pages).toBe(3); // [1 2 3 4] [8 6 7 31] [32 21 22]: 4 and 8 share a created_at
        break;
      }
    }
    expect(ids).toEqual(ALL_IDS);
    // The cursor holds within a filter too: chat 3001's messages, two at a time.
    const first = (await get(`/v1/stats/messages?${RANGE}&chatId=3001&limit=2`)).json();
    const rest = (await get(`/v1/stats/messages?${RANGE}&chatId=3001&limit=2&cursor=${first.nextCursor}`)).json();
    expect(rest.items.map((x: { messageId: number }) => x.messageId)).toEqual([3, 4]);
    for (const bad of ['nope', Buffer.from('[1,2,"x",3]').toString('base64url')]) {
      const res = await get(`/v1/stats/messages?${RANGE}&cursor=${bad}`);
      expect([res.statusCode, res.json().error.code]).toEqual([400, 'invalid_cursor']);
    }
  });

  it('filters by direction: in is the fan messages only, out the creator side', async () => {
    expect(await messageIds(`${RANGE}&direction=in`)).toEqual([1, 4, 8, 6, 21]);
    expect(await messageIds(`${RANGE}&direction=out`)).toEqual([2, 3, 7, 31, 32, 22]);
    expect(await messageIds(`${RANGE}&direction=in&chatId=3002`)).toEqual([6]);
    const bad = await get(`/v1/stats/messages?${RANGE}&direction=fans`);
    expect([bad.statusCode, bad.json().error.code]).toEqual([400, 'validation_error']);
  });

  it('writes plain UTF-8 CSV with the text verbatim, ignoring limit', async () => {
    const res = await get(`/v1/stats/messages?${RANGE}&accountId=${A1}&chatId=3001&direction=in&format=csv&limit=1`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="messages_3001_in_2026-09-01_2026-09-04.csv"');
    expect(res.body).toBe(
      HEADER +
        '1001,3001,fan_a,1,2026-09-01T10:00:00.000Z,inbound,Hey & hi 😊,0,true,false,false,0,0,0,0,0,0,false,false,false,,false,false,\n' +
        '1001,3001,fan_a,4,2026-09-02T10:00:00.000Z,inbound,"-_- @name +1, ""quoted""",0,true,false,true,500,0,0,0,0,0,false,false,false,,false,false,\n' +
        `1001,3001,fan_a,8,2026-09-02T10:00:00.000Z,inbound,love 'u',0,true,false,false,0,0,0,0,1,0,false,false,false,,true,true,${DELETED_AT}\n`,
    );
  });

  it('streams the whole range in keyset batches, joining across a boundary between messages of the same instant', async () => {
    const before = messageExport.batchSize;
    messageExport.batchSize = 4; // batches [1 2 3 4] [8 6 7 31] [32 21 22]: 4 and 8 share a created_at
    try {
      const res = await get(`/v1/stats/messages?${RANGE}&format=csv&limit=1`);
      expect(res.body.startsWith(HEADER)).toBe(true);
      expect(csvIds(res.body)).toEqual(ALL_IDS);
      messageExport.batchSize = ALL_IDS.length; // a full last batch ends with one empty query
      expect(csvIds((await get(`/v1/stats/messages?${RANGE}&format=csv`)).body)).toEqual(ALL_IDS);
    } finally {
      messageExport.batchSize = before;
    }
  });
});

describe('stats fans and messages scoping', () => {
  it('follow the key allowlist and the accountId filter; another account is 403', async () => {
    expect(await fans(RANGE, limitedKeyA)).toEqual([[A2, 4001]]);
    expect(await messageIds(RANGE, limitedKeyA)).toEqual([21, 22]);
    expect(await fans(`${RANGE}&accountId=${A2}`)).toEqual([[A2, 4001]]);
    for (const path of ['fans', 'messages']) {
      const denied = await get(`/v1/stats/${path}?${RANGE}&accountId=${A1}`, limitedKeyA);
      expect([denied.statusCode, denied.json().error.code]).toEqual([403, 'account_not_allowed']);
      const csv = await get(`/v1/stats/${path}?${RANGE}&accountId=${A1}&format=csv`, limitedKeyA);
      expect(csv.statusCode).toBe(403);
    }
    const session = await app.inject({ method: 'GET', url: `/v1/stats/fans?${RANGE}`, headers: dashboard(cookieA) });
    expect(session.json().items).toHaveLength(4);
  });

  it("a second workspace's key sees none of the first's messages", async () => {
    for (const q of [RANGE, `${RANGE}&accountId=${A1}`]) {
      const res = (await get(`/v1/stats/fans?${q}`, keyB)).json();
      expect([res.total, res.items]).toEqual([0, []]);
      expect(await messageIds(q, keyB)).toEqual([]);
      expect((await get(`/v1/stats/messages?${q}&format=csv`, keyB)).body).toBe(HEADER);
    }
  });
});
