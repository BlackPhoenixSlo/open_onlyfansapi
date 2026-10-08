import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/index.js';
import { createUpstream } from '../src/lib/upstream.js';
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

/** Account 1001: fan 3001 (@fan_a) with a message before the range, fan 3002 (no username). Account 1002: fan 4001. */
const DATA_A1 = of(
  {
    3001: [
      msg(4, '09-02T10:00', 3001, { text: '<p>=cmd, "quoted"</p>', price: 5, isTip: true }),
      msg(3, '09-02T09:00', A1, { queueId: 900, isFromQueue: true }),
      msg(2, '09-01T10:05', A1, { text: '<p>Hello <b>You</b></p>', mediaCount: 2 }),
      msg(1, '09-01T10:00', 3001, { text: '<p>Hey &amp; hi 😊</p>' }),
      msg(5, '08-20T10:00', 3001),
    ],
    3002: [msg(7, '09-03T08:30', A1), msg(6, '09-03T08:00', 3002, { text: null })],
  },
  { 3001: 'fan_a' },
);
const DATA_A2 = of({ 4001: [msg(22, '09-01T22:20', A2), msg(21, '09-01T22:00', 4001)] });

let cookieA: string;
let keyA: string;
let limitedKeyA: string;
let keyB: string;

const get = (url: string, key = keyA) => app.inject({ method: 'GET', url, headers: bearer(key) });
const RANGE = 'from=2026-09-01&to=2026-09-04';
const HEADER = '﻿account_id,chat_id,fan_username,message_id,created_at,direction,text,price_cents,is_tip,media_count,is_mass,is_automated\n';
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

beforeAll(async () => {
  await resetDb();
  const a = await signUp(app, 'messages-a@example.test');
  const b = await signUp(app, 'messages-b@example.test');
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
});
afterAll(async () => {
  await app.close();
  await fake.close();
  await pool.end();
});

describe('stats fans', () => {
  it('counts fan, creator and mass messages per fan in the range, latest message first', async () => {
    const res = await get(`/v1/stats/fans?${RANGE}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ timezone: 'UTC', configVersion: 1, from: '2026-09-01', to: '2026-09-04' });
    expect(body.items).toEqual([
      { accountId: A1, chatId: 3002, fanUsername: null, fanMessages: 1, creatorMessages: 1, massMessages: 0, firstAt: '2026-09-03T08:00:00.000Z', lastAt: '2026-09-03T08:30:00.000Z' },
      { accountId: A1, chatId: 3001, fanUsername: 'fan_a', fanMessages: 2, creatorMessages: 1, massMessages: 1, firstAt: '2026-09-01T10:00:00.000Z', lastAt: '2026-09-02T10:00:00.000Z' },
      { accountId: A2, chatId: 4001, fanUsername: null, fanMessages: 1, creatorMessages: 1, massMessages: 0, firstAt: '2026-09-01T22:00:00.000Z', lastAt: '2026-09-01T22:20:00.000Z' },
    ]);
    expect(await fans(`${RANGE}&limit=1`)).toEqual([[A1, 3002]]);
    expect(await fans('from=2026-08-01&to=2026-08-31')).toEqual([[A1, 3001]]);
  });
});

describe('stats messages', () => {
  it('returns the plain-text messages by account, chat and time, with the money and kind columns', async () => {
    const res = await get(`/v1/stats/messages?${RANGE}&accountId=${A1}&chatId=3001`);
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([
      { accountId: A1, chatId: 3001, fanUsername: 'fan_a', messageId: 1, createdAt: '2026-09-01T10:00:00.000Z', direction: 'inbound', text: 'Hey & hi 😊', priceCents: 0, isTip: false, mediaCount: 0, isMass: false, isAutomated: false },
      { accountId: A1, chatId: 3001, fanUsername: 'fan_a', messageId: 2, createdAt: '2026-09-01T10:05:00.000Z', direction: 'outbound', text: 'Hello You', priceCents: 0, isTip: false, mediaCount: 2, isMass: false, isAutomated: false },
      { accountId: A1, chatId: 3001, fanUsername: 'fan_a', messageId: 3, createdAt: '2026-09-02T09:00:00.000Z', direction: 'outbound', text: 'ok', priceCents: 0, isTip: false, mediaCount: 0, isMass: true, isAutomated: false },
      { accountId: A1, chatId: 3001, fanUsername: 'fan_a', messageId: 4, createdAt: '2026-09-02T10:00:00.000Z', direction: 'inbound', text: '=cmd, "quoted"', priceCents: 500, isTip: true, mediaCount: 0, isMass: false, isAutomated: false },
    ]);
    expect(await messageIds(RANGE)).toEqual([1, 2, 3, 4, 6, 7, 21, 22]);
    expect(await messageIds(`${RANGE}&limit=3`)).toEqual([1, 2, 3]);
  });

  it('filters by direction: in is the fan messages only, out the creator side', async () => {
    expect(await messageIds(`${RANGE}&direction=in`)).toEqual([1, 4, 6, 21]);
    expect(await messageIds(`${RANGE}&direction=out`)).toEqual([2, 3, 7, 22]);
    expect(await messageIds(`${RANGE}&direction=in&chatId=3002`)).toEqual([6]);
    const bad = await get(`/v1/stats/messages?${RANGE}&direction=fans`);
    expect([bad.statusCode, bad.json().error.code]).toEqual([400, 'validation_error']);
  });

  it('writes the whole range as Excel-safe CSV, ignoring limit', async () => {
    const res = await get(`/v1/stats/messages?${RANGE}&accountId=${A1}&chatId=3001&direction=in&format=csv&limit=1`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="messages_3001_in_2026-09-01_2026-09-04.csv"');
    expect(res.body).toBe(
      HEADER +
        '1001,3001,fan_a,1,2026-09-01T10:00:00.000Z,inbound,Hey & hi 😊,0,false,0,false,false\n' +
        `1001,3001,fan_a,4,2026-09-02T10:00:00.000Z,inbound,"'=cmd, ""quoted""",500,true,0,false,false\n`,
    );
    const all = await get(`/v1/stats/messages?${RANGE}&format=csv`);
    expect(all.body.split('\n').length).toBe(1 + 8 + 1);
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
    }
    const session = await app.inject({ method: 'GET', url: `/v1/stats/fans?${RANGE}`, headers: dashboard(cookieA) });
    expect(session.json().items).toHaveLength(3);
  });

  it("a second workspace's key sees none of the first's messages", async () => {
    for (const q of [RANGE, `${RANGE}&accountId=${A1}`]) {
      expect(await fans(q, keyB)).toEqual([]);
      expect(await messageIds(q, keyB)).toEqual([]);
      expect((await get(`/v1/stats/messages?${q}&format=csv`, keyB)).body).toBe(HEADER);
    }
  });
});
