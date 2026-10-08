import type { FastifyBaseLogger } from 'fastify';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { db, pool } from '../src/db/index.js';
import { messageFact } from '../src/db/schema.js';
import { createUpstream } from '../src/lib/upstream.js';
import { dbStore } from '../src/modules/analytics/backfill.js';
import { ingestFrame, type EventFrame } from '../src/modules/events/ingest.js';
import { startFakeUpstream } from './fake-upstream.js';
import { bearer, claimAndBackfill, createKey, linkTeam, resetDb, signUp } from './helpers.js';

const TOKEN = 'test-only-upstream-token';
const ACCOUNT = 1001;
const UNCLAIMED = 1002;
const FAN = { id: 2001, username: 'fan_one', name: 'Lucy' };

const app = await buildApp({ logger: false });
const fake = await startFakeUpstream(TOKEN);
const upstream = createUpstream({ url: fake.url, token: TOKEN, timeoutMs: 2000 });
const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as FastifyBaseLogger & { error: ReturnType<typeof vi.fn> };

const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
const base = { price: 0, isTip: false, mediaCount: 0, media: [], queueId: null };
/** A fan message and the account's reply naming the fan (the script hash replaces the name), an hour apart. */
const inbound = { ...base, id: 109, createdAt: at(3), fromUser: FAN, text: '<p>hey, are you there?</p>' };
const outbound = {
  ...base,
  id: 110,
  createdAt: at(2),
  fromUser: { id: ACCOUNT },
  text: '<p>Hi Lucy, thanks for the message, here is something special</p>',
  price: 5,
  mediaCount: 1,
  media: [{ id: 77 }],
};

/** The upstream's frame for an OF message (services/upstream/events.py): received gains `fanData`. */
function messageFrame(msg: Record<string, unknown>, accountId = ACCOUNT): EventFrame {
  const sent = (msg.fromUser as { id: number }).id === accountId;
  return {
    id: `message.${sent ? 'sent' : 'received'}:${accountId}:${String(msg.id)}`,
    type: sent ? 'messages.sent' : 'messages.received',
    account_id: accountId,
    ts: String(msg.createdAt),
    amount_cents: null,
    payload: sent ? msg : { ...msg, fanData: { available: false } },
  };
}
let seq = 0;
const frame = (type: string, payload: EventFrame['payload'], accountId = ACCOUNT): EventFrame => ({
  id: `test:${++seq}`,
  type,
  account_id: accountId,
  ts: at(1),
  amount_cents: null,
  payload,
});
const facts = () => db.select().from(messageFact).orderBy(asc(messageFact.messageId));
const derived = (rows: Awaited<ReturnType<typeof facts>>) => rows.map(({ fetchedAt: _f, raw: _r, ...d }) => d);

let readKey: string;
let teamId: string;

beforeAll(async () => {
  await resetDb();
  const a = await signUp(app, 'analytics-live@example.test');
  await linkTeam(a.teamId);
  teamId = a.teamId;
  readKey = (await createKey(app, a.cookie, { scope: 'read', allowedAccountIds: [ACCOUNT] })).secret;
  fake.state.of = {
    chats: [{ withUser: FAN, lastMessage: { id: 110, createdAt: outbound.createdAt } }],
    messages: { [FAN.id]: [outbound, inbound] },
    mass: [],
    transactions: [],
    welcome: null,
  };
  // Claims the account and stores what the backfill derives (the expected rows) and the chat's coverage.
  await claimAndBackfill({ upstream, teamId: a.teamId, accountId: ACCOUNT, from: new Date(Date.now() - 86_400_000), to: new Date(), config: { pageDelayMs: 0 } });
});
beforeEach(async () => {
  await pool.query('TRUNCATE event');
  log.error.mockClear();
});
afterAll(async () => {
  await app.close();
  await fake.close();
  await pool.end();
});

describe('analytics live updates', () => {
  it('messages.received and messages.sent store the rows the backfill derives', async () => {
    const backfilled = await facts();
    expect(backfilled).toHaveLength(2);
    expect(backfilled[1]!.textHash).not.toBeNull();
    await pool.query('TRUNCATE message_fact');

    await ingestFrame(messageFrame(inbound), log);
    // A live sent message has no `toUser`; OF's `chatUserId` names the fan.
    await ingestFrame(messageFrame({ ...outbound, chatUserId: FAN.id }), log);

    const live = await facts();
    expect(derived(live)).toEqual(derived(backfilled));
    expect(live[0]!.raw).toEqual(inbound); // the upstream's `fanData` is not OF's
    expect(log.error).not.toHaveBeenCalled();
  });

  it('a row already stored is kept; messages.deleted marks it deleted and keeps it', async () => {
    const before = await facts();
    expect(before.map((r) => r.deletedAt)).toEqual([null, null]);
    await ingestFrame({ ...messageFrame({ ...inbound, text: '<p>changed</p>' }), id: 'test:replay' }, log);
    expect(await facts()).toEqual(before);

    const t0 = Date.now();
    await ingestFrame(frame('messages.deleted', { id: String(inbound.id) }), log);
    await ingestFrame(frame('messages.deleted', { id: '999' }), log); // unknown: no row
    const after = await facts();
    expect(after.map((r) => r.messageId)).toEqual([inbound.id, outbound.id]);
    const deletedAt = after[0]!.deletedAt!;
    expect(deletedAt.getTime()).toBeGreaterThanOrEqual(t0 - 5);
    expect(after.map(({ deletedAt: _d, ...r }) => r)).toEqual(before.map(({ deletedAt: _d, ...r }) => r));
    // A second delete keeps the first mark.
    await ingestFrame(frame('messages.deleted', { id: String(inbound.id) }), log);
    expect((await facts())[0]!.deletedAt).toEqual(deletedAt);
  });

  it('a backfill that reads a deleted message again clears the mark, on either upsert', async () => {
    const mark = () => pool.query('UPDATE message_fact SET deleted_at = now() WHERE message_id = $1', [inbound.id]);
    const deletedAt = async () => (await facts()).find((r) => r.messageId === inbound.id)!.deletedAt;
    await mark();
    await claimAndBackfill({ upstream, teamId, accountId: ACCOUNT, from: new Date(Date.now() - 86_400_000), to: new Date(), config: { pageDelayMs: 0 } });
    expect(await deletedAt()).toBeNull();

    // A boundary message older than the mass window is only inserted, never re-derived, but is un-deleted too.
    await mark();
    const { teamId: _t, accountId: _a, deletedAt: _d, ...walked } = (await facts()).find((r) => r.messageId === inbound.id)!;
    await dbStore(teamId, ACCOUNT).messages([], [{ ...walked, priceCents: 999 }]);
    const [row] = (await facts()).filter((r) => r.messageId === inbound.id);
    expect([row!.deletedAt, row!.priceCents]).toEqual([null, walked.priceCents]);
  });

  it('an outbound message with a queueId counts as mass until a backfill re-derives it', async () => {
    await ingestFrame(messageFrame({ ...outbound, id: 111, queueId: 900, toUser: FAN }), log);
    const [row] = await db.select().from(messageFact).where(eq(messageFact.messageId, 111));
    expect(row).toMatchObject({ chatId: FAN.id, direction: 'outbound', isMass: true, queueId: 900, isAutomated: false });
    await db.delete(messageFact).where(eq(messageFact.messageId, 111));
  });

  it('an unclaimed account gets no row; the event is still ingested', async () => {
    const count = await db.$count(messageFact);
    await ingestFrame(messageFrame({ ...inbound, id: 501 }, UNCLAIMED), log);
    expect(await db.$count(messageFact)).toBe(count);
    const { rows } = await pool.query('SELECT account_id, type FROM event');
    expect(rows).toEqual([{ account_id: UNCLAIMED, type: 'messages.received' }]);
  });

  it('invalid payloads are skipped and a failed insert is logged once with the event id; ingest goes on', async () => {
    const count = await db.$count(messageFact);
    for (const payload of [null, 'garbage', [1], { id: 'x', fromUser: FAN, createdAt: at(1) }, { ...inbound, id: 601, createdAt: 'never' }]) {
      await ingestFrame(frame('messages.received', payload), log);
    }
    await ingestFrame(frame('messages.sent', { ...outbound, id: 602 }), log); // no `toUser` nor `chatUserId`
    await ingestFrame(frame('messages.deleted', { id: 'not-a-number' }), log);
    expect(await db.$count(messageFact)).toBe(count);
    expect(log.error).not.toHaveBeenCalled();

    const bad = frame('messages.received', { ...inbound, id: 603, price: 1e12 }); // price_cents overflows int4
    await ingestFrame(bad, log);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0]![0]).toMatchObject({ type: 'messages.received', accountId: ACCOUNT });
    expect(log.error.mock.calls[0]![0].eventId).toMatch(/^evt_/);

    await ingestFrame(messageFrame({ ...inbound, id: 604 }), log);
    expect(await db.$count(messageFact)).toBe(count + 1);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM event WHERE type LIKE 'messages.%'");
    expect(rows[0].n).toBe(9);
  });

  it('GET /v1/stats/config reports freshness for the claimed accounts', async () => {
    const empty = (await app.inject({ method: 'GET', url: '/v1/stats/config', headers: bearer(readKey) })).json();
    expect(empty.freshness).toEqual({ lastLiveAt: null, liveEvents24h: 0 });

    await ingestFrame(messageFrame(inbound), log);
    await ingestFrame(messageFrame({ ...outbound, toUser: FAN }), log);
    await ingestFrame({ ...messageFrame({ ...inbound, id: 120, createdAt: at(30) }), id: 'test:old' }, log); // older than 24 h
    await ingestFrame(messageFrame({ ...inbound, id: 701, createdAt: at(0) }, UNCLAIMED), log);
    const res = await app.inject({ method: 'GET', url: '/v1/stats/config', headers: bearer(readKey) });
    expect(res.statusCode).toBe(200);
    expect(res.json().freshness).toMatchObject({ lastLiveAt: new Date(outbound.createdAt).toISOString(), liveEvents24h: 2 });
  });
});
