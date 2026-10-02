import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/index.js';
import { env } from '../src/env.js';
import { emit } from '../src/modules/webhooks/service.js';
import { assertDeliverable, claimDeliveries, completeDelivery, deliverDue, isPrivateAddress } from '../src/modules/webhooks/worker.js';
import { bearer, createKey, dashboard, resetDb, signUp } from './helpers.js';

type Received = { headers: Record<string, string | string[] | undefined>; body: string };

/** A local receiver that records every POST and answers `receiver.status`. */
const received: Received[] = [];
const receiver = { status: 200 };
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk: Buffer) => (body += chunk.toString()));
  req.on('end', () => {
    received.push({ headers: req.headers, body });
    res.writeHead(receiver.status).end();
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const hookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;

const app = await buildApp({ logger: false });
const defaults = { ...env };

let writeKey: string;
let readKey: string;
let cookie: string;
let teamId: string;

beforeAll(async () => {
  await resetDb();
  const user = await signUp(app, 'webhooks@example.test');
  cookie = user.cookie;
  teamId = user.teamId;
  writeKey = (await createKey(app, cookie, { scope: 'write' })).secret;
  readKey = (await createKey(app, cookie, { scope: 'read' })).secret;
});
beforeEach(async () => {
  // The test receiver is plain http on loopback.
  env.ALLOW_HTTP_WEBHOOKS = true;
  received.length = 0;
  receiver.status = 200;
  await pool.query('TRUNCATE webhook_endpoint CASCADE');
});
afterEach(() => {
  Object.assign(env, defaults);
});
afterAll(async () => {
  await app.close();
  server.close();
  await pool.end();
});

type Endpoint = { id: string; secret: string; enabled: boolean; pausedReason: string | null; consecutiveFailures: number };

async function createEndpoint(body: Record<string, unknown> = {}): Promise<Endpoint> {
  const res = await app.inject({ method: 'POST', url: '/v1/webhooks', headers: bearer(writeKey), payload: { url: hookUrl, ...body } });
  expect(res.statusCode).toBe(201);
  return res.json().endpoint;
}

async function sendTest(endpointId: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: `/v1/webhooks/${endpointId}/test`, headers: bearer(writeKey) });
  expect(res.statusCode).toBe(202);
  return res.json().delivery.id;
}

async function delivery(id: string) {
  const { rows } = await pool.query(
    `SELECT status, attempts, last_status_code, last_error, replay_of,
       extract(epoch from next_attempt_at - now())::float AS due_in FROM webhook_delivery WHERE id = $1`,
    [id],
  );
  return rows[0] as { status: string; attempts: number; last_status_code: number | null; last_error: string | null; replay_of: string | null; due_in: number };
}

const makeDue = (id: string) => pool.query('UPDATE webhook_delivery SET next_attempt_at = now() WHERE id = $1', [id]);

const getEndpoint = async (id: string): Promise<Endpoint> =>
  (await app.inject({ method: 'GET', url: `/v1/webhooks/${id}`, headers: bearer(readKey) })).json().endpoint;

/** Written from the Standard Webhooks spec, independently of lib/signature.ts. */
function standardWebhooksVerify(secret: string, headers: Record<string, string | string[] | undefined>, payload: string) {
  const id = String(headers['webhook-id']);
  const timestamp = String(headers['webhook-timestamp']);
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.substring(6) : secret, 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${payload}`).digest('base64');
  const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) <= 300;
  return fresh && String(headers['webhook-signature']).split(' ').some((s) => s === `v1,${expected}`);
}

describe('webhooks API', () => {
  it('manages endpoints: https-only, write scope, team-scoped, event catalogue', async () => {
    env.ALLOW_HTTP_WEBHOOKS = false;
    const http = await app.inject({ method: 'POST', url: '/v1/webhooks', headers: bearer(writeKey), payload: { url: 'http://example.com/h' } });
    expect(http.statusCode).toBe(400);
    expect(http.json().error.code).toBe('invalid_webhook_url');

    const created = await app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: bearer(writeKey),
      payload: { url: 'https://example.com/h', description: 'mine', events: ['message.received'] },
    });
    expect(created.statusCode).toBe(201);
    const endpoint = created.json().endpoint;
    expect(endpoint).toMatchObject({ url: 'https://example.com/h', description: 'mine', events: ['message.received'], enabled: true });
    expect(endpoint.id).toMatch(/^whe_/);
    expect(endpoint.secret).toMatch(/^whsec_[A-Za-z0-9+/]+=*$/);

    const bad = await app.inject({ method: 'POST', url: '/v1/webhooks', headers: bearer(writeKey), payload: { url: 'https://e.com', events: ['nope'] } });
    expect(bad.statusCode).toBe(400);

    const readOnly = await app.inject({ method: 'POST', url: '/v1/webhooks', headers: bearer(readKey), payload: { url: 'https://e.com' } });
    expect(readOnly.statusCode).toBe(403);
    const list = await app.inject({ method: 'GET', url: '/v1/webhooks', headers: bearer(readKey) });
    expect(list.json().items.map((e: Endpoint) => e.id)).toEqual([endpoint.id]);

    const events = await app.inject({ method: 'GET', url: '/v1/webhooks/events', headers: bearer(readKey) });
    expect(events.json().items.map((e: { type: string }) => e.type)).toEqual([
      'message.received',
      'account.session_expired',
      'webhook.test',
      'upstream.*',
    ]);

    // The dashboard session works too.
    const viaSession = await app.inject({
      method: 'PATCH',
      url: `/v1/webhooks/${endpoint.id}`,
      headers: dashboard(cookie),
      payload: { enabled: false },
    });
    expect(viaSession.json().endpoint).toMatchObject({ enabled: false, pausedReason: 'manual' });

    const other = await signUp(app, 'webhooks-other@example.test');
    const otherKey = (await createKey(app, other.cookie, { scope: 'write' })).secret;
    const foreign = await app.inject({ method: 'GET', url: `/v1/webhooks/${endpoint.id}`, headers: bearer(otherKey) });
    expect(foreign.statusCode).toBe(404);

    const del = await app.inject({ method: 'DELETE', url: `/v1/webhooks/${endpoint.id}`, headers: bearer(writeKey) });
    expect(del.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/v1/webhooks/${endpoint.id}`, headers: bearer(writeKey) })).statusCode).toBe(404);
  });

  it('lists deliveries with filters and a cursor, and redelivers as a new row', async () => {
    const endpoint = await createEndpoint();
    const first = await sendTest(endpoint.id);
    const second = await sendTest(endpoint.id);

    const page1 = await app.inject({ method: 'GET', url: `/v1/webhooks/${endpoint.id}/deliveries?limit=1`, headers: bearer(readKey) });
    expect(page1.json().items.map((d: { id: string }) => d.id)).toEqual([second]);
    const page2 = await app.inject({
      method: 'GET',
      url: `/v1/webhooks/${endpoint.id}/deliveries?limit=1&cursor=${page1.json().nextCursor}`,
      headers: bearer(readKey),
    });
    expect(page2.json()).toMatchObject({ items: [{ id: first, eventType: 'webhook.test', status: 'pending', attempts: 0 }], nextCursor: null });
    const none = await app.inject({ method: 'GET', url: `/v1/webhooks/${endpoint.id}/deliveries?status=failed`, headers: bearer(readKey) });
    expect(none.json().items).toEqual([]);

    const replay = await app.inject({
      method: 'POST',
      url: `/v1/webhooks/${endpoint.id}/deliveries/${first}/redeliver`,
      headers: bearer(writeKey),
    });
    expect(replay.statusCode).toBe(202);
    const copy = replay.json().delivery;
    expect(copy.id).not.toBe(first);
    expect(copy).toMatchObject({ replayOf: first, status: 'pending', attempts: 0, eventType: 'webhook.test' });
    const missing = await app.inject({
      method: 'POST',
      url: `/v1/webhooks/${endpoint.id}/deliveries/whd_missing/redeliver`,
      headers: bearer(writeKey),
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe('signature', () => {
  it('a Standard Webhooks verifier accepts the delivery', async () => {
    const endpoint = await createEndpoint();
    const id = await sendTest(endpoint.id);
    expect(await deliverDue()).toBe(1);

    expect(received).toHaveLength(1);
    const { headers, body } = received[0]!;
    expect(headers['webhook-id']).toBe(id);
    expect(headers['content-type']).toBe('application/json');
    expect(standardWebhooksVerify(endpoint.secret, headers, body)).toBe(true);
    expect(standardWebhooksVerify(endpoint.secret, headers, body + ' ')).toBe(false);
    expect(JSON.parse(body)).toMatchObject({ id, type: 'webhook.test', accountId: null, data: { message: expect.any(String) } });
    expect(await delivery(id)).toMatchObject({ status: 'succeeded', attempts: 1, last_status_code: 200, last_error: null });
  });

  it('matches the Standard Webhooks reference vector', async () => {
    const { sign } = await import('../src/lib/signature.js');
    expect(sign('whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', 'msg_p5jXN8AQM9LWM0D4loKWxJek', 1614265330, '{"test": 2432232314}')).toBe(
      'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
    );
  });
});

describe('worker', () => {
  it('retries on the backoff schedule (first retry 30 s), then fails and counts an endpoint failure', async () => {
    receiver.status = 500;
    const endpoint = await createEndpoint();
    const id = await sendTest(endpoint.id);
    const schedule = [30, 120, 600, 3600, 21_600];
    for (const [i, seconds] of schedule.entries()) {
      expect(await deliverDue()).toBe(1);
      const d = await delivery(id);
      expect(d).toMatchObject({ status: 'pending', attempts: i + 1, last_status_code: 500, last_error: 'HTTP 500' });
      expect(d.due_in).toBeGreaterThan(seconds - 5);
      expect(d.due_in).toBeLessThanOrEqual(seconds);
      expect(await deliverDue()).toBe(0); // not due yet
      await makeDue(id);
    }
    expect(await deliverDue()).toBe(1);
    expect(await delivery(id)).toMatchObject({ status: 'failed', attempts: env.WEBHOOK_MAX_ATTEMPTS });
    expect(received).toHaveLength(env.WEBHOOK_MAX_ATTEMPTS);
    expect(await getEndpoint(endpoint.id)).toMatchObject({ consecutiveFailures: 1, enabled: true });
  });

  it('pauses an endpoint at WEBHOOK_PAUSE_AFTER failures; re-enabling clears the breaker and resumes', async () => {
    env.WEBHOOK_MAX_ATTEMPTS = 1;
    env.WEBHOOK_PAUSE_AFTER = 2;
    receiver.status = 503;
    const endpoint = await createEndpoint();
    await sendTest(endpoint.id);
    await sendTest(endpoint.id);
    expect(await deliverDue()).toBe(2);
    expect(await getEndpoint(endpoint.id)).toMatchObject({ enabled: false, pausedReason: 'failures', consecutiveFailures: 2 });

    // Paused: queued deliveries wait.
    const waiting = await sendTest(endpoint.id);
    expect(await deliverDue()).toBe(0);

    receiver.status = 204;
    const res = await app.inject({ method: 'PATCH', url: `/v1/webhooks/${endpoint.id}`, headers: bearer(writeKey), payload: { enabled: true } });
    expect(res.json().endpoint).toMatchObject({ enabled: true, pausedReason: null, consecutiveFailures: 0 });
    expect(await deliverDue()).toBe(1);
    expect(await delivery(waiting)).toMatchObject({ status: 'succeeded', attempts: 1, last_status_code: 204 });
  });

  it('a 2xx resets consecutive failures', async () => {
    env.WEBHOOK_MAX_ATTEMPTS = 1;
    receiver.status = 500;
    const endpoint = await createEndpoint();
    await sendTest(endpoint.id);
    await deliverDue();
    expect((await getEndpoint(endpoint.id)).consecutiveFailures).toBe(1);
    receiver.status = 200;
    await sendTest(endpoint.id);
    await deliverDue();
    expect((await getEndpoint(endpoint.id)).consecutiveFailures).toBe(0);
  });

  it('counts attempts on completion: a crash after the claim does not burn an attempt', async () => {
    const endpoint = await createEndpoint();
    const id = await sendTest(endpoint.id);
    const [claimed] = await claimDeliveries();
    expect(claimed?.id).toBe(id);
    // The lease moved the row ~60 s out and left attempts alone.
    const leased = await delivery(id);
    expect(leased.attempts).toBe(0);
    expect(leased.due_in).toBeGreaterThan(55);
    expect(await claimDeliveries()).toEqual([]);

    // "Crash": never completed. Once the lease runs out the row is claimed again, still at attempt 0.
    await makeDue(id);
    expect(await deliverDue()).toBe(1);
    expect(await delivery(id)).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(received).toHaveLength(1);
  });

  it('concurrent claims never return the same delivery', async () => {
    const endpoint = await createEndpoint();
    await pool.query(
      `INSERT INTO webhook_delivery (id, team_id, endpoint_id, event_type, payload)
       SELECT 'whd_c' || g, $1, $2, 'webhook.test', '{}' FROM generate_series(1, 50) g`,
      [teamId, endpoint.id],
    );
    const batches = await Promise.all(Array.from({ length: 5 }, () => claimDeliveries()));
    const ids = batches.flat().map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(50);
  });

  it('refuses private and plain-http targets unless ALLOW_HTTP_WEBHOOKS', async () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '172.16.0.1', '192.168.1.1', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1']) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
    for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) expect(isPrivateAddress(a), a).toBe(false);

    const endpoint = await createEndpoint();
    env.ALLOW_HTTP_WEBHOOKS = false;
    await expect(assertDeliverable(new URL('https://localhost/h'))).rejects.toThrow('private address');
    await expect(assertDeliverable(new URL('https://[::1]/h'))).rejects.toThrow('private address');
    // An endpoint created while http was allowed is refused at delivery time, as a failed attempt.
    const id = await sendTest(endpoint.id);
    expect(await deliverDue()).toBe(1);
    expect(await delivery(id)).toMatchObject({ status: 'pending', attempts: 1, last_status_code: null, last_error: 'webhook URLs must use https://' });
    expect(received).toHaveLength(0);
  });

  it('completion only touches pending rows', async () => {
    const endpoint = await createEndpoint();
    const id = await sendTest(endpoint.id);
    await deliverDue();
    await completeDelivery(id, endpoint.id, { statusCode: 500, error: 'HTTP 500' });
    expect(await delivery(id)).toMatchObject({ status: 'succeeded', attempts: 1 });
  });
});

describe('emit', () => {
  it('queues one delivery per enabled, subscribed endpoint in one insert', async () => {
    const all = await createEndpoint();
    const messages = await createEndpoint({ events: ['message.received'] });
    const upstream = await createEndpoint({ events: ['upstream.*'] });
    await createEndpoint({ events: ['account.session_expired'] });
    const disabled = await createEndpoint();
    await app.inject({ method: 'PATCH', url: `/v1/webhooks/${disabled.id}`, headers: bearer(writeKey), payload: { enabled: false } });

    expect(await emit(teamId, 'message.received', 12, { text: 'hi' })).toBe(2);
    expect(await emit(teamId, 'upstream.chat_typing', 12, {})).toBe(2);
    const byKey = (a: { event_type: string; endpoint_id: string }, b: { event_type: string; endpoint_id: string }) =>
      `${a.event_type} ${a.endpoint_id}` < `${b.event_type} ${b.endpoint_id}` ? -1 : 1;
    const { rows } = await pool.query('SELECT endpoint_id, event_type, account_id, payload FROM webhook_delivery');
    expect(rows.sort(byKey)).toEqual(
      [
        { endpoint_id: all.id, event_type: 'message.received', account_id: 12, payload: { text: 'hi' } },
        { endpoint_id: messages.id, event_type: 'message.received', account_id: 12, payload: { text: 'hi' } },
        { endpoint_id: all.id, event_type: 'upstream.chat_typing', account_id: 12, payload: {} },
        { endpoint_id: upstream.id, event_type: 'upstream.chat_typing', account_id: 12, payload: {} },
      ].sort(byKey),
    );

    // A burst queues behind the concurrency cap instead of failing.
    const burst = await Promise.all(Array.from({ length: 30 }, () => emit(teamId, 'message.received', null, {})));
    expect(burst.every((n) => n === 2)).toBe(true);
  });
});
