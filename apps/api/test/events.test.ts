import type { FastifyBaseLogger } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { db, pool } from '../src/db/index.js';
import { env } from '../src/env.js';
import { subscribe, type GatewayEvent } from '../src/lib/event-bus.js';
import { startEventSource, type SourceTimings } from '../src/modules/events/source.js';
import { startFakeUpstream } from './fake-upstream.js';
import { bearer, createKey, linkTeam, resetDb, signUp } from './helpers.js';

const app = await buildApp({ logger: false });
const fake = await startFakeUpstream(env.UPSTREAM_TOKEN);
const wsUrl = fake.url.replace(/^http/, 'ws') + '/ws';
const defaults = { ...env };

const log = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as unknown as FastifyBaseLogger & {
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};
const FAST: SourceTimings = { backoffMinMs: 20, backoffMaxMs: 100, staleMs: 5000 };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** Workspace A: linked, endpoint on every event. B: linked, message.received only. C: not linked. */
const teams: Record<'a' | 'b' | 'c', string> = { a: '', b: '', c: '' };
const seen: GatewayEvent[] = [];
const unsubscribe = subscribe((e) => seen.push(e));
let source: { stop: () => Promise<void> } | null = null;

beforeAll(async () => {
  await resetDb();
  for (const [name, events] of [['a', []], ['b', ['message.received']], ['c', []]] as const) {
    const user = await signUp(app, `events-${name}@example.test`);
    teams[name] = user.teamId;
    const key = (await createKey(app, user.cookie, { scope: 'write' })).secret;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: bearer(key),
      payload: { url: `https://${name}.example.test/hook`, events },
    });
    expect(res.statusCode).toBe(201);
  }
  await linkTeam(teams.a);
  await linkTeam(teams.b);
});
beforeEach(async () => {
  await pool.query('TRUNCATE event, webhook_delivery');
  seen.length = 0;
  log.warn.mockClear();
  log.error.mockClear();
  fake.ws.connections = 0;
  fake.ws.maxOpen = 0;
  env.UPSTREAM_WS_URL = wsUrl;
});
afterEach(async () => {
  await source?.stop();
  source = null;
  await waitFor(() => fake.sockets.size === 0, 'the fake to see the socket close');
  Object.assign(env, defaults);
});
afterAll(async () => {
  unsubscribe();
  await app.close();
  await fake.close();
  await pool.end();
});

async function connected(timings = FAST) {
  source = startEventSource(log, timings);
  await waitFor(() => fake.sockets.size === 1, 'the source to connect');
}

const frame = (over: Record<string, unknown> = {}) => ({
  id: 'message.received:117183:5551234',
  type: 'message.received',
  account_id: 117183,
  ts: '2026-10-02T12:00:00.000Z',
  payload: { messageId: 5551234, fanId: 42, text: 'hi', price: 0, mediaCount: 0 },
  ...over,
});

const eventRows = async () =>
  (await pool.query('SELECT id, account_id, type, amount_cents, dedup_key, created_at FROM event ORDER BY created_at, type')).rows;
const deliveries = async () =>
  (await pool.query('SELECT team_id, event_type, account_id, payload, status FROM webhook_delivery ORDER BY team_id, event_type')).rows as {
    team_id: string;
    event_type: string;
    account_id: number;
    payload: unknown;
    status: string;
  }[];

describe('upstream event source', () => {
  it('the fake /ws needs bearer + bearer.<token> and selects bearer', async () => {
    const outcome = (protocols: string[]) =>
      new Promise<string>((resolve) => {
        const ws = new WebSocket(wsUrl, protocols);
        ws.onopen = () => {
          resolve(`open:${ws.protocol}`);
          ws.close();
        };
        ws.onerror = () => resolve('refused');
      });
    expect(await outcome(['bearer', `bearer.${env.UPSTREAM_TOKEN}`])).toBe('open:bearer');
    expect(await outcome(['bearer', 'bearer.wrong-token'])).toBe('refused');
    expect(await outcome([`bearer.${env.UPSTREAM_TOKEN}`])).toBe('refused');
  });

  it('one frame: one ledger row, one bus event, a pending delivery per linked workspace with a matching endpoint', async () => {
    await connected();
    fake.pushFrame(frame());
    await waitFor(async () => (await deliveries()).length === 2, 'two deliveries');

    const rows = await eventRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      account_id: 117183,
      type: 'message.received',
      amount_cents: null,
      dedup_key: 'message.received:117183:5551234',
      created_at: new Date('2026-10-02T12:00:00.000Z'),
    });
    expect(rows[0].id).toMatch(/^evt_/);

    expect(seen).toEqual([
      { id: rows[0].id, type: 'message.received', createdAt: new Date('2026-10-02T12:00:00.000Z'), accountId: 117183, data: frame().payload },
    ]);
    const queued = await deliveries();
    expect(queued.map((d) => d.team_id).sort()).toEqual([teams.a, teams.b].sort());
    for (const d of queued) {
      expect(d).toMatchObject({ event_type: 'message.received', account_id: 117183, payload: frame().payload, status: 'pending' });
    }
  });

  it('the same id twice: one row, one delivery; a null id is never deduplicated; amount types fill amount_cents', async () => {
    await connected();
    const tip = frame({ id: 'tip.received:117183:9', type: 'tip.received', payload: { fanId: 42, amountCents: 500 } });
    const post = frame({ id: null, type: 'post.expired', ts: '2026-10-02T12:01:00.000Z', payload: { postId: 7 } });
    fake.pushFrame(tip);
    fake.pushFrame(tip);
    fake.pushFrame(post);
    fake.pushFrame(post);
    await waitFor(() => seen.length === 3, 'three bus events');
    await waitFor(async () => (await deliveries()).length === 3, 'three deliveries');

    const rows = await eventRows();
    expect(rows.map((r) => [r.type, r.amount_cents, r.dedup_key])).toEqual([
      ['tip.received', 500, 'tip.received:117183:9'],
      ['post.expired', null, null],
      ['post.expired', null, null],
    ]);
    expect(seen.map((e) => e.type)).toEqual(['tip.received', 'post.expired', 'post.expired']);
    // A subscribes to everything, B only to message.received.
    expect((await deliveries()).map((d) => [d.team_id, d.event_type])).toEqual([
      [teams.a, 'post.expired'],
      [teams.a, 'post.expired'],
      [teams.a, 'tip.received'],
    ]);
  });

  it('an amount outside int32 is stored as null; a failed ledger insert is published, not emitted', async () => {
    await connected();
    fake.pushFrame(frame({ id: 'tip.received:117183:10', type: 'tip.received', payload: { fanId: 42, amountCents: 2 ** 40 } }));
    await waitFor(async () => (await deliveries()).length === 1, 'the tip delivery');
    expect((await eventRows()).map((r) => [r.type, r.amount_cents])).toEqual([['tip.received', null]]);

    const insert = vi.spyOn(db, 'insert').mockImplementationOnce(() => {
      throw new Error('Failed query: insert … params: hi', { cause: new Error('connection refused') });
    });
    fake.pushFrame(frame());
    await waitFor(() => seen.length === 2, 'the second bus event');
    await sleep(100);
    insert.mockRestore();
    expect(seen[1]!.type).toBe('message.received');
    expect(await eventRows()).toHaveLength(1);
    expect(await deliveries()).toHaveLength(1);
    expect(log.error).toHaveBeenCalledOnce();
    expect(log.error.mock.calls[0]![0].err.message).toBe('connection refused');
  });

  it('upstream.<name>: delivered and published with a fresh evt_ id, not stored', async () => {
    await connected();
    fake.pushFrame(frame({ id: 'upstream.chat_typing:1', type: 'upstream.chat_typing', payload: { raw: true } }));
    await waitFor(async () => (await deliveries()).length === 1, 'one delivery');

    expect(await eventRows()).toEqual([]);
    expect((await deliveries())[0]).toMatchObject({ team_id: teams.a, event_type: 'upstream.chat_typing', payload: { raw: true } });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.id).toMatch(/^evt_/);
  });

  it('drops malformed frames, unknown types and heartbeats; the socket stays up', async () => {
    await connected();
    fake.pushFrame('not json');
    fake.pushFrame({ type: 'message.received', account_id: 1 }); // no ts
    fake.pushFrame(frame({ account_id: 'x' }));
    fake.pushFrame(frame({ ts: 'yesterday' }));
    fake.pushFrame(frame({ type: 'nope.thing' }));
    fake.pushFrame(frame({ type: 'webhook.test' }));
    fake.pushFrame(frame({ id: undefined })); // id is required (null allowed)
    fake.pushFrame({ type: 'heartbeat', ts: '2026-10-02T12:00:30.000Z' });
    fake.pushFrame(frame());
    await waitFor(async () => (await deliveries()).length === 2, 'the valid frame');

    expect(seen.map((e) => e.type)).toEqual(['message.received']);
    expect(await eventRows()).toHaveLength(1);
    expect(fake.ws.connections).toBe(1);
    expect(fake.sockets.size).toBe(1);

    // Drops are summarised (at most one warning a minute; the rest is flushed on stop), not logged per frame.
    await source!.stop();
    source = null;
    const reports = log.warn.mock.calls.filter((c) => c[1] === 'upstream event frames dropped');
    expect(reports.length).toBeLessThanOrEqual(2);
    const total = { malformed: 0, unknown_type: 0, queue_full: 0 };
    for (const [{ dropped }] of reports) for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += dropped[k];
    expect(total).toEqual({ malformed: 5, unknown_type: 2, queue_full: 0 });
  });

  it('dropSockets(): exactly one reconnect, never two sockets; a second start reuses the running source', async () => {
    await connected();
    expect(startEventSource(log, FAST)).toBe(source);
    fake.dropSockets();
    await waitFor(() => fake.ws.connections === 2 && fake.sockets.size === 1, 'the reconnect');
    await sleep(300); // several backoff periods
    expect(fake.ws.connections).toBe(2);
    expect(fake.ws.maxOpen).toBe(1);

    fake.pushFrame(frame());
    await waitFor(() => seen.length === 1, 'an event on the new socket');
  });

  it('stop() right after a drop does not reconnect', async () => {
    await connected();
    fake.dropSockets();
    await source!.stop();
    source = null;
    await sleep(200);
    expect(fake.ws.connections).toBe(1);
  });

  it('a refused handshake is retried with growing backoff and a hint', async () => {
    env.UPSTREAM_TOKEN = 'wrong-token-0123';
    source = startEventSource(log, { ...FAST, backoffMinMs: 20, backoffMaxMs: 1000 });
    const attempts = () => fake.requests.filter((r) => r.url === '/ws').length;
    const before = attempts();
    await sleep(600);
    expect(fake.ws.connections).toBe(0);
    expect(attempts() - before).toBeGreaterThanOrEqual(2);
    expect(attempts() - before).toBeLessThanOrEqual(6);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('refused or unreachable: check UPSTREAM_WS_URL / UPSTREAM_TOKEN'));
  });

  it('reconnects after the stale window when the upstream goes silent; heartbeats keep it open', async () => {
    await connected({ ...FAST, staleMs: 250 });
    const started = Date.now();
    for (let i = 0; i < 5; i++) {
      await sleep(100);
      fake.pushFrame({ type: 'heartbeat', ts: new Date().toISOString() });
    }
    expect(fake.ws.connections).toBe(1);

    await waitFor(() => fake.ws.connections === 2, 'the stale reconnect');
    expect(Date.now() - started).toBeGreaterThanOrEqual(500 + 250);
    await waitFor(() => fake.sockets.size === 1, 'one open socket');
    expect(fake.ws.maxOpen).toBe(1);
  });

  it('a stale socket whose upstream never answers the close is torn down, not left open', async () => {
    fake.state.ignoreClose = true;
    await connected({ ...FAST, staleMs: 250 });
    fake.state.ignoreClose = false;
    await waitFor(() => fake.ws.connections === 2, 'the stale reconnect');
    await waitFor(() => fake.sockets.size === 1, 'the unanswered socket to be closed', 2000);
  });

  it('opens no socket when UPSTREAM_WS_URL is unset', async () => {
    env.UPSTREAM_WS_URL = undefined;
    source = startEventSource(log, FAST);
    await sleep(100);
    expect(fake.ws.connections).toBe(0);
  });
});
