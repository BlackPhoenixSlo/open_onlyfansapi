import { createHmac } from 'node:crypto';
import { createServer, get } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { db, pool } from '../src/db/index.js';
import { event } from '../src/db/schema.js';
import { env } from '../src/env.js';
import { deleteExpired } from '../src/jobs/retention.js';
import { eventDescription, WEBHOOK_EVENTS, type WebhookEventInfo } from '../src/contracts.js';
import { envelope, sign, verifySignature } from '../src/lib/signature.js';
import { ingestFrame } from '../src/modules/events/ingest.js';
import { emit } from '../src/modules/webhooks/service.js';
import { assertDeliverable, claimDeliveries, completeDelivery, deliverDue, isPrivateAddress } from '../src/modules/webhooks/worker.js';
import { bearer, createKey, dashboard, linkTeam, ownAccounts, resetDb, signUp } from './helpers.js';

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
  await ownAccounts(teamId, 7, 8, 12);
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
    `SELECT status, attempts, last_status_code, last_error, replay_of, event_id,
       extract(epoch from next_attempt_at - now())::float AS due_in FROM webhook_delivery WHERE id = $1`,
    [id],
  );
  return rows[0] as {
    status: string;
    attempts: number;
    last_status_code: number | null;
    last_error: string | null;
    replay_of: string | null;
    event_id: string;
    due_in: number;
  };
}

const makeDue = (id: string) => pool.query('UPDATE webhook_delivery SET next_attempt_at = now() WHERE id = $1', [id]);

const getEndpoint = async (id: string): Promise<Endpoint> =>
  (await app.inject({ method: 'GET', url: `/v1/webhooks/${id}`, headers: bearer(readKey) })).json().endpoint;

/** The plan-v5 §2.3 scheme written with node:crypto, independently of lib/signature.ts. */
const hmacHex = (secret: string, body: string) => createHmac('sha256', Buffer.from(secret, 'utf8')).update(body).digest('hex');

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
      payload: { url: 'https://example.com/h', description: 'mine', events: ['messages.received'] },
    });
    expect(created.statusCode).toBe(201);
    const endpoint = created.json().endpoint;
    expect(endpoint).toMatchObject({ url: 'https://example.com/h', description: 'mine', events: ['messages.received'], enabled: true });
    expect(endpoint.id).toMatch(/^whe_/);
    expect(endpoint.secret).toMatch(/^whsec_[A-Za-z0-9+/]+=*$/);

    const bad = await app.inject({ method: 'POST', url: '/v1/webhooks', headers: bearer(writeKey), payload: { url: 'https://e.com', events: ['nope'] } });
    expect(bad.statusCode).toBe(400);
    // v4 names and out-of-scope names of the reference API are refused.
    for (const name of ['message.received', 'data_exports.completed']) {
      const refused = await app.inject({ method: 'POST', url: '/v1/webhooks', headers: bearer(writeKey), payload: { url: 'https://e.com', events: [name] } });
      expect(refused.statusCode, name).toBe(400);
    }

    const readOnly = await app.inject({ method: 'POST', url: '/v1/webhooks', headers: bearer(readKey), payload: { url: 'https://e.com' } });
    expect(readOnly.statusCode).toBe(403);
    const list = await app.inject({ method: 'GET', url: '/v1/webhooks', headers: bearer(readKey) });
    expect(list.json().items.map((e: Endpoint) => e.id)).toEqual([endpoint.id]);

    const events = await app.inject({ method: 'GET', url: '/v1/webhooks/events', headers: bearer(readKey) });
    const catalogue = events.json().items.map((e: { type: string }) => e.type);
    expect(catalogue).toEqual([
      'messages.received',
      'messages.sent',
      'messages.ppv.unlocked',
      'messages.deleted',
      'messages.liked',
      'messages.unliked',
      'chat_queue.updated',
      'chat_queue.finished',
      'subscriptions.new',
      'subscriptions.renewed',
      'subscriptions.expired',
      'users.typing',
      'users.online',
      'users.offline',
      'posts.liked',
      'posts.expired',
      'tips.received',
      'transactions.new',
      'accounts.connected',
      'accounts.reconnected',
      'accounts.disconnected',
      'accounts.session_expired',
      'accounts.authentication_failed',
      'accounts.otp_code_required',
      'accounts.face_otp_required',
      'media_uploads.completed',
      'media_uploads.failed',
      'webhook.test',
      'upstream.*',
    ]);
    // Each type's status is served as `status`, and the description carries it too (TBC, never, or unmarked = emitted).
    const items = events.json().items as WebhookEventInfo[];
    expect(items.every((e) => e.status === WEBHOOK_EVENTS[e.type].status && e.description === eventDescription(e.type))).toBe(true);
    expect(items.find((e) => e.type === 'messages.liked')?.description).toBe('A fan liked a message (TBC: not emitted yet).');
    const byStatus = (want: string) => items.filter((e) => e.status === want).map((e) => e.type);
    expect(byStatus('emitted')).toEqual([
      'messages.received',
      'messages.sent',
      'messages.deleted',
      'chat_queue.finished',
      'posts.expired',
      'accounts.connected',
      'accounts.reconnected',
      'accounts.session_expired',
      'webhook.test',
      'upstream.*',
    ]);
    expect(byStatus('never')).toEqual([
      'accounts.disconnected',
      'accounts.authentication_failed',
      'accounts.otp_code_required',
      'accounts.face_otp_required',
      'media_uploads.completed',
      'media_uploads.failed',
    ]);
    const all = await app.inject({ method: 'POST', url: '/v1/webhooks', headers: bearer(writeKey), payload: { url: 'https://e.com/all', events: catalogue } });
    expect(all.statusCode).toBe(201);
    expect(all.json().endpoint.events).toEqual(catalogue);
    await app.inject({ method: 'DELETE', url: `/v1/webhooks/${all.json().endpoint.id}`, headers: bearer(writeKey) });

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

  it('shows the secret only to write-scope actors and refuses account-limited keys', async () => {
    const endpoint = await createEndpoint();
    const asRead = await app.inject({ method: 'GET', url: `/v1/webhooks/${endpoint.id}`, headers: bearer(readKey) });
    expect(asRead.json().endpoint.id).toBe(endpoint.id);
    expect(asRead.json().endpoint).not.toHaveProperty('secret');
    const listed = await app.inject({ method: 'GET', url: '/v1/webhooks', headers: bearer(readKey) });
    expect(listed.json().items[0]).not.toHaveProperty('secret');
    const asWrite = await app.inject({ method: 'GET', url: `/v1/webhooks/${endpoint.id}`, headers: bearer(writeKey) });
    expect(asWrite.json().endpoint.secret).toBe(endpoint.secret);
    const asSession = await app.inject({ method: 'GET', url: '/v1/webhooks', headers: dashboard(cookie) });
    expect(asSession.json().items[0].secret).toBe(endpoint.secret);

    const limited = (await createKey(app, cookie, { scope: 'write', allowedAccountIds: [12] })).secret;
    for (const [method, url] of [
      ['GET', '/v1/webhooks'],
      ['GET', '/v1/webhooks/events'],
      ['GET', `/v1/webhooks/${endpoint.id}`],
      ['POST', `/v1/webhooks/${endpoint.id}/test`],
    ] as const) {
      const res = await app.inject({ method, url, headers: bearer(limited) });
      expect(res.statusCode, url).toBe(403);
      expect(res.json().error.code).toBe('account_not_allowed');
    }
  });

  it('lists deliveries with filters and a cursor, and redelivers as a new row', async () => {
    const endpoint = await createEndpoint();
    const first = await sendTest(endpoint.id);
    const second = await sendTest(endpoint.id);
    // Distinct timestamps so the newest-first order does not depend on the random ids.
    await pool.query(`UPDATE webhook_delivery SET created_at = now() - interval '1 minute' WHERE id = $1`, [first]);

    const page1 = await app.inject({ method: 'GET', url: `/v1/webhooks/${endpoint.id}/deliveries?limit=1`, headers: bearer(readKey) });
    expect(page1.json().items.map((d: { id: string }) => d.id)).toEqual([second]);
    const page2 = await app.inject({
      method: 'GET',
      url: `/v1/webhooks/${endpoint.id}/deliveries?limit=1&cursor=${page1.json().nextCursor}`,
      headers: bearer(readKey),
    });
    expect(page2.json()).toMatchObject({ items: [{ id: first, eventType: 'webhook.test', status: 'pending', attempts: 0 }], nextCursor: null });
    const forged = await app.inject({
      method: 'GET',
      url: `/v1/webhooks/${endpoint.id}/deliveries?cursor=${Buffer.from('["1","whd_x"]').toString('base64url')}`,
      headers: bearer(readKey),
    });
    expect([forged.statusCode, forged.json().error.code]).toEqual([400, 'invalid_cursor']);
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
    expect(copy.eventId).toBe((await delivery(first)).event_id);
    const missing = await app.inject({
      method: 'POST',
      url: `/v1/webhooks/${endpoint.id}/deliveries/whd_missing/redeliver`,
      headers: bearer(writeKey),
    });
    expect(missing.statusCode).toBe(404);
  });

  it('a null payload is stored as jsonb null, delivered as payload: null and redelivered as null', async () => {
    const endpoint = await createEndpoint();
    expect(await emit(teamId, 'evt_1001', 'posts.expired', 1001, null)).toBe(1);
    const { rows } = await pool.query('SELECT id, jsonb_typeof(payload) AS kind FROM webhook_delivery');
    expect(rows).toEqual([{ id: expect.any(String), kind: 'null' }]);
    expect(await deliverDue()).toBe(1);
    expect(received[0]!.body).toBe('{"event":"posts.expired","account_id":"1001","payload":null}');

    const replay = await app.inject({
      method: 'POST',
      url: `/v1/webhooks/${endpoint.id}/deliveries/${rows[0].id}/redeliver`,
      headers: bearer(writeKey),
    });
    expect(replay.statusCode).toBe(202);
    expect(replay.json().delivery).toMatchObject({ replayOf: rows[0].id, payload: null });
  });
});

describe('envelope and signature', () => {
  it('a fixed event serialises to exact bytes: event, account_id (a string), payload', () => {
    expect(envelope({ type: 'messages.received', accountId: 1001, data: { id: 1002, text: 'hi', fromUser: { id: 1003 } } })).toBe(
      '{"event":"messages.received","account_id":"1001","payload":{"id":1002,"text":"hi","fromUser":{"id":1003}}}',
    );
    expect(envelope({ type: 'webhook.test', accountId: null, data: { message: 'm' } })).toBe('{"event":"webhook.test","payload":{"message":"m"}}');
  });

  it('Signature matches a known vector computed with node:crypto, and verifySignature rejects one flipped byte', () => {
    const secret = 'whsec_dGVzdC1vbmx5LXNlY3JldC0wMTIzNDU2Nzg5YWJjZGVm';
    const body = '{"event":"messages.received","account_id":"1001","payload":{"id":1002}}';
    const expected = hmacHex(secret, body);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
    expect(sign(secret, body)).toBe(expected);
    expect(sign(secret, Buffer.from(body))).toBe(expected);

    expect(verifySignature(secret, expected, body)).toBe(true);
    const flipped = (expected[0] === 'a' ? 'b' : 'a') + expected.slice(1);
    expect(verifySignature(secret, flipped, body)).toBe(false);
    expect(verifySignature(secret, expected, body.replace('1002', '1003'))).toBe(false);
    expect(verifySignature(secret + 'x', expected, body)).toBe(false);
    for (const bad of ['', expected.slice(2), `v1,${expected}`, expected + '00', 'z'.repeat(64)]) {
      expect(verifySignature(secret, bad, body), bad).toBe(false);
    }
  });

  it('a delivery carries Signature and X-OFAPI-Idempotency-Key, no webhook-* header, and no account_id for webhook.test', async () => {
    const endpoint = await createEndpoint();
    const id = await sendTest(endpoint.id);
    expect(await deliverDue()).toBe(1);

    expect(received).toHaveLength(1);
    const { headers, body } = received[0]!;
    expect(body).toBe('{"event":"webhook.test","payload":{"message":"Test event from the gateway"}}');
    expect(headers['content-type']).toBe('application/json');
    expect(headers['user-agent']).toBe('Gateway-Webhooks');
    expect(headers.signature).toBe(hmacHex(endpoint.secret, body));
    expect(headers['x-ofapi-idempotency-key']).toBe((await delivery(id)).event_id);
    expect(headers['x-ofapi-idempotency-key']).toMatch(/^evt_/);
    expect(Object.keys(headers).filter((h) => h.startsWith('webhook-'))).toEqual([]);
    expect(await delivery(id)).toMatchObject({ status: 'succeeded', attempts: 1, last_status_code: 200, last_error: null });
  });

  it('the idempotency key is the event id, the same on an automatic retry and a manual redelivery', async () => {
    const endpoint = await createEndpoint();
    expect(await emit(teamId, 'evt_1001', 'messages.received', 1001, { id: 1002 })).toBe(1);
    const [{ id }] = (await pool.query('SELECT id FROM webhook_delivery')).rows;
    receiver.status = 500;
    expect(await deliverDue()).toBe(1);
    await makeDue(id);
    receiver.status = 200;
    expect(await deliverDue()).toBe(1);

    const replay = await app.inject({ method: 'POST', url: `/v1/webhooks/${endpoint.id}/deliveries/${id}/redeliver`, headers: bearer(writeKey) });
    expect(replay.json().delivery).toMatchObject({ eventId: 'evt_1001', replayOf: id });
    expect(replay.json().delivery.id).not.toBe(id);
    expect(await deliverDue()).toBe(1);

    expect(received.map((r) => r.headers['x-ofapi-idempotency-key'])).toEqual(['evt_1001', 'evt_1001', 'evt_1001']);
    expect(new Set(received.map((r) => r.body))).toEqual(new Set(['{"event":"messages.received","account_id":"1001","payload":{"id":1002}}']));

    // Two Test actions are two events: each gets a fresh key.
    received.length = 0;
    await sendTest(endpoint.id);
    await sendTest(endpoint.id);
    expect(await deliverDue()).toBe(2);
    const keys = received.map((r) => r.headers['x-ofapi-idempotency-key']);
    expect(new Set(keys).size).toBe(2);
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
      `INSERT INTO webhook_delivery (id, team_id, endpoint_id, event_id, event_type, payload)
       SELECT 'whd_c' || g, $1, $2, 'evt_c' || g, 'webhook.test', '{}' FROM generate_series(1, 50) g`,
      [teamId, endpoint.id],
    );
    const batches = await Promise.all(Array.from({ length: 5 }, () => claimDeliveries()));
    const ids = batches.flat().map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(50);
  });

  it('refuses private targets unless ALLOW_HTTP_WEBHOOKS, and link-local always', async () => {
    const privateAddresses = ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '192.0.0.8', '198.18.0.1', '224.0.0.1', '240.0.0.1'];
    for (const a of [...privateAddresses, '::1', 'fd00::1', '64:ff9b::7f00:1', '2002:7f00:1::1', '::ffff:127.0.0.1', '169.254.169.254', 'fe80::1']) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
    for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) expect(isPrivateAddress(a), a).toBe(false);

    // With the flag: loopback is fine, link-local (cloud metadata) is not.
    await expect(assertDeliverable(new URL('http://127.0.0.1/h'))).resolves.toBeUndefined();
    await expect(assertDeliverable(new URL('http://169.254.169.254/latest'))).rejects.toThrow('link-local');
    await expect(assertDeliverable(new URL('http://[fe80::1]/h'))).rejects.toThrow('link-local');

    const endpoint = await createEndpoint();
    env.ALLOW_HTTP_WEBHOOKS = false;
    await expect(assertDeliverable(new URL('https://localhost/h'))).rejects.toThrow('private address');
    await expect(assertDeliverable(new URL('https://[::1]/h'))).rejects.toThrow('private address');
    // An endpoint saved while the flag was on is refused at delivery time, as a failed attempt.
    const id = await sendTest(endpoint.id);
    expect(await deliverDue()).toBe(1);
    expect(await delivery(id)).toMatchObject({
      status: 'pending',
      attempts: 1,
      last_status_code: null,
      last_error: '127.0.0.1 resolves to a private address',
    });
    expect(received).toHaveLength(0);
  });

  it('a completion that outlived its lease changes nothing', async () => {
    const endpoint = await createEndpoint();
    const id = await sendTest(endpoint.id);
    const [stale] = await claimDeliveries();
    // The lease ran out and another worker claimed the row again.
    await pool.query(`UPDATE webhook_delivery SET next_attempt_at = now() + interval '60 seconds' WHERE id = $1`, [id]);
    await completeDelivery(stale!, { statusCode: 200, error: null });
    expect(await delivery(id)).toMatchObject({ status: 'pending', attempts: 0, last_status_code: null });
    expect((await delivery(id)).due_in).toBeGreaterThan(55);

    // The current lease holder completes normally; a repeat with the same lease is a no-op.
    await makeDue(id);
    const [current] = await claimDeliveries();
    await completeDelivery(current!, { statusCode: 200, error: null });
    await completeDelivery(current!, { statusCode: 500, error: 'HTTP 500' });
    expect(await delivery(id)).toMatchObject({ status: 'succeeded', attempts: 1, last_status_code: 200 });
  });

  it('never sends a dropped delivery (a pending v4 delivery cancelled by the 2.0 migration)', async () => {
    const endpoint = await createEndpoint();
    const id = await sendTest(endpoint.id);
    await pool.query(`UPDATE webhook_delivery SET status = 'dropped' WHERE id = $1`, [id]);
    expect(await deliverDue()).toBe(0);
    expect(received).toHaveLength(0);
    const listed = await app.inject({ method: 'GET', url: `/v1/webhooks/${endpoint.id}/deliveries?status=dropped`, headers: bearer(readKey) });
    expect(listed.json().items).toMatchObject([{ id, status: 'dropped' }]);
  });

  it('refuses to redeliver a dropped delivery or a 1.x event name with 409', async () => {
    const endpoint = await createEndpoint();
    const dropped = await sendTest(endpoint.id);
    await pool.query(`UPDATE webhook_delivery SET status = 'dropped' WHERE id = $1`, [dropped]);
    const legacy = await sendTest(endpoint.id);
    await pool.query(`UPDATE webhook_delivery SET status = 'succeeded', event_type = 'message.received' WHERE id = $1`, [legacy]);
    expect(await emit(teamId, 'evt_1001', 'upstream.chat_typing', 1001, {})).toBe(1);
    const { rows } = await pool.query(`SELECT id FROM webhook_delivery WHERE event_type = 'upstream.chat_typing'`);

    const list = await app.inject({ method: 'GET', url: `/v1/webhooks/${endpoint.id}/deliveries`, headers: bearer(readKey) });
    const flags = Object.fromEntries(list.json().items.map((d: { id: string; redeliverable: boolean }) => [d.id, d.redeliverable]));
    expect(flags).toEqual({ [dropped]: false, [legacy]: false, [rows[0].id]: true });

    for (const id of [dropped, legacy]) {
      const res = await app.inject({ method: 'POST', url: `/v1/webhooks/${endpoint.id}/deliveries/${id}/redeliver`, headers: bearer(writeKey) });
      expect(res.statusCode, id).toBe(409);
      expect(res.json().error.code).toBe('not_redeliverable');
    }
    const ok = await app.inject({ method: 'POST', url: `/v1/webhooks/${endpoint.id}/deliveries/${rows[0].id}/redeliver`, headers: bearer(writeKey) });
    expect(ok.statusCode).toBe(202);
  });

  it('retention keeps pending deliveries', async () => {
    const endpoint = await createEndpoint();
    const pending = await sendTest(endpoint.id);
    const done = await sendTest(endpoint.id);
    await pool.query(`UPDATE webhook_delivery SET status = 'succeeded' WHERE id = $1`, [done]);
    await pool.query(`UPDATE webhook_delivery SET created_at = now() - interval '30 days'`);
    expect(await deleteExpired('webhook_delivery', 7)).toBe(1);
    expect((await pool.query('SELECT id FROM webhook_delivery')).rows).toEqual([{ id: pending }]);
  });
});

describe('emit', () => {
  it('queues one delivery per enabled, subscribed endpoint in one insert', async () => {
    const all = await createEndpoint();
    const messages = await createEndpoint({ events: ['messages.received'] });
    const upstream = await createEndpoint({ events: ['upstream.*'] });
    await createEndpoint({ events: ['accounts.session_expired'] });
    const disabled = await createEndpoint();
    await app.inject({ method: 'PATCH', url: `/v1/webhooks/${disabled.id}`, headers: bearer(writeKey), payload: { enabled: false } });

    expect(await emit(teamId, 'evt_1', 'messages.received', 12, { text: 'hi' })).toBe(2);
    expect(await emit(teamId, 'evt_2', 'upstream.chat_typing', 12, {})).toBe(2);
    const byKey = (a: { event_type: string; endpoint_id: string }, b: { event_type: string; endpoint_id: string }) =>
      `${a.event_type} ${a.endpoint_id}` < `${b.event_type} ${b.endpoint_id}` ? -1 : 1;
    const { rows } = await pool.query('SELECT endpoint_id, event_type, account_id, payload FROM webhook_delivery');
    expect((await pool.query('SELECT DISTINCT event_id FROM webhook_delivery ORDER BY event_id')).rows).toEqual([{ event_id: 'evt_1' }, { event_id: 'evt_2' }]);
    expect(rows.sort(byKey)).toEqual(
      [
        { endpoint_id: all.id, event_type: 'messages.received', account_id: 12, payload: { text: 'hi' } },
        { endpoint_id: messages.id, event_type: 'messages.received', account_id: 12, payload: { text: 'hi' } },
        { endpoint_id: all.id, event_type: 'upstream.chat_typing', account_id: 12, payload: {} },
        { endpoint_id: upstream.id, event_type: 'upstream.chat_typing', account_id: 12, payload: {} },
      ].sort(byKey),
    );

    // A burst queues behind the concurrency cap instead of failing.
    const burst = await Promise.all(Array.from({ length: 30 }, (_, i) => emit(teamId, `evt_b${i}`, 'messages.received', null, {})));
    expect(burst.every((n) => n === 2)).toBe(true);
  });
});

type Stream = { text: string; close: () => void; ended: Promise<void> };

/** An open `GET /api/webhooks/stream`, resolved once its `: ready` comment arrives; `text` grows as frames do. */
function openStream(base: string, cookie: string): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = get(`${base}/api/webhooks/stream`, { headers: { cookie } }, (res) => {
      let ended!: () => void;
      const stream: Stream = { text: '', close: () => req.destroy(), ended: new Promise((r) => (ended = r)) };
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        stream.text += chunk;
        if (stream.text.startsWith(': ready')) resolve(stream);
      });
      res.on('end', () => {
        ended();
        reject(new Error(`stream ended: ${res.statusCode} ${stream.text}`));
      });
    });
    req.on('error', reject);
  });
}

const frames = (text: string, name: 'delivery' | 'event') =>
  text
    .split('\n\n')
    .filter((f) => f.startsWith(`event: ${name}\n`))
    .map((f) => JSON.parse(f.slice(f.indexOf('data: ') + 6)));
const notices = (text: string) => frames(text, 'delivery');

describe('dashboard delivery stream', () => {
  let base: string;
  beforeAll(async () => {
    base = await app.listen({ port: 0, host: '127.0.0.1' });
  });

  it('needs a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/webhooks/stream' });
    expect(res.statusCode).toBe(401);
  });

  it("sends each finished attempt only to its own workspace's streams", async () => {
    const other = await signUp(app, 'webhooks-stream@example.test');
    const otherKey = (await createKey(app, other.cookie, { scope: 'write' })).secret;
    const mine = await createEndpoint({ description: 'mine' });
    const res = await app.inject({ method: 'POST', url: '/v1/webhooks', headers: bearer(otherKey), payload: { url: hookUrl } });
    const theirs = res.json().endpoint as Endpoint;
    const [a, b] = await Promise.all([openStream(base, cookie), openStream(base, other.cookie)]);
    try {
      const myDelivery = await sendTest(mine.id);
      const t = await app.inject({ method: 'POST', url: `/v1/webhooks/${theirs.id}/test`, headers: bearer(otherKey) });
      const theirDelivery = t.json().delivery.id as string;
      expect(await deliverDue()).toBe(2);
      const deadline = Date.now() + 2000;
      while (notices(a.text).length === 0 || notices(b.text).length === 0) {
        if (Date.now() > deadline) throw new Error(`no frame: ${a.text} | ${b.text}`);
        await new Promise((r) => setTimeout(r, 20));
      }
      await new Promise((r) => setTimeout(r, 50)); // a stray cross-workspace frame would have arrived by now
      expect(notices(a.text)).toEqual([
        {
          deliveryId: myDelivery,
          endpointId: mine.id,
          eventType: 'webhook.test',
          url: hookUrl,
          description: 'mine',
          status: 'succeeded',
          statusCode: 200,
          error: null,
        },
      ]);
      expect(notices(b.text)).toMatchObject([{ deliveryId: theirDelivery, endpointId: theirs.id, status: 'succeeded' }]);
    } finally {
      a.close();
      b.close();
    }
  });

  it('reports a failed attempt that will be retried as pending', async () => {
    receiver.status = 500;
    const endpoint = await createEndpoint();
    const stream = await openStream(base, cookie);
    try {
      await sendTest(endpoint.id);
      expect(await deliverDue()).toBe(1);
      const deadline = Date.now() + 2000;
      while (notices(stream.text).length === 0) {
        if (Date.now() > deadline) throw new Error(`no frame: ${stream.text}`);
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(notices(stream.text)).toMatchObject([{ status: 'pending', statusCode: 500, error: 'HTTP 500' }]);
    } finally {
      stream.close();
    }
  });

  it('ends a stream after its lifetime, so the reconnect re-checks the session', async () => {
    const short = await buildApp({ logger: false, stream: { heartbeatMs: 20, maxMs: 100 } });
    try {
      const stream = await openStream(await short.listen({ port: 0, host: '127.0.0.1' }), cookie);
      const ended = await Promise.race([stream.ended.then(() => true), new Promise((r) => setTimeout(() => r(false), 2000))]);
      expect(ended).toBe(true);
      expect(stream.text).toContain(': ping');
    } finally {
      await short.close();
    }
  });

  it("pushes upstream events to the account's linked workspace only, and the test event to the caller only", async () => {
    const unlinked = await signUp(app, 'webhooks-unlinked@example.test');
    const notOwner = await signUp(app, 'webhooks-not-owner@example.test', { linked: true });
    await linkTeam(teamId);
    const [a, b, c] = await Promise.all([openStream(base, cookie), openStream(base, unlinked.cookie), openStream(base, notOwner.cookie)]);
    try {
      const ts = '2026-10-05T12:00:00.000Z';
      await ingestFrame({ id: null, type: 'messages.received', account_id: 7, ts, payload: { text: 'hi' }, amount_cents: null }, app.log);
      await ingestFrame({ id: null, type: 'upstream.chat_typing', account_id: 7, ts, payload: {} }, app.log);
      const noCsrf = await app.inject({ method: 'POST', url: '/api/webhooks/stream/test', headers: { cookie: unlinked.cookie } });
      expect(noCsrf.statusCode).toBe(403);
      const test = await app.inject({ method: 'POST', url: '/api/webhooks/stream/test', headers: dashboard(unlinked.cookie) });
      expect(test.statusCode).toBe(202);
      const deadline = Date.now() + 2000;
      while (frames(a.text, 'event').length < 2 || frames(b.text, 'event').length < 1) {
        if (Date.now() > deadline) throw new Error(`no frame: ${a.text} | ${b.text}`);
        await new Promise((r) => setTimeout(r, 20));
      }
      await new Promise((r) => setTimeout(r, 50)); // a stray cross-workspace frame would have arrived by now
      const evt = expect.stringMatching(/^evt_/);
      expect(frames(a.text, 'event')).toEqual([
        { id: evt, type: 'messages.received', accountId: 7, ts, data: { text: 'hi' } },
        { id: evt, type: 'upstream.chat_typing', accountId: 7, ts, data: {} },
      ]);
      expect(frames(b.text, 'event')).toEqual([
        { id: evt, type: 'webhook.test', accountId: null, ts: expect.any(String), data: { message: 'Test event from the gateway' } },
      ]);
      // Linked, but account 7 is another workspace's.
      expect(frames(c.text, 'event')).toEqual([]);
    } finally {
      a.close();
      b.close();
      c.close();
    }
  });

  it('a stream opened before link-team stays unlinked for its lifetime', async () => {
    const late = await signUp(app, 'webhooks-late-link@example.test');
    await ownAccounts(late.teamId, 9);
    const before = await openStream(base, late.cookie);
    await linkTeam(late.teamId);
    const after = await openStream(base, late.cookie);
    try {
      const ts = '2026-10-05T12:00:00.000Z';
      await ingestFrame({ id: null, type: 'upstream.chat_typing', account_id: 9, ts, payload: {} }, app.log);
      const deadline = Date.now() + 2000;
      while (frames(after.text, 'event').length === 0) {
        if (Date.now() > deadline) throw new Error(`no frame: ${after.text}`);
        await new Promise((r) => setTimeout(r, 20));
      }
      await new Promise((r) => setTimeout(r, 50)); // a stray frame to the unlinked stream would have arrived by now
      expect(frames(after.text, 'event')).toMatchObject([{ type: 'upstream.chat_typing' }]);
      expect(frames(before.text, 'event')).toEqual([]);
    } finally {
      before.close();
      after.close();
    }
  });

  it("returns the newest 50 ledger events of the workspace's accounts without payloads, to linked workspaces only", async () => {
    await pool.query('TRUNCATE event');
    const t0 = Date.parse('2026-10-01T00:00:00.000Z');
    await db.insert(event).values(
      Array.from({ length: 51 }, (_, i) => ({
        id: `evt_recent${String(i).padStart(2, '0')}`,
        accountId: 7,
        type: i % 2 ? 'tips.received' : 'messages.received',
        amountCents: i % 2 ? 100 : null,
        createdAt: new Date(t0 + i * 1000),
      })),
    );
    // Same time: the id breaks the tie.
    await db.insert(event).values({ id: 'evt_recent99', accountId: 8, type: 'messages.sent', createdAt: new Date(t0 + 50_000) });
    // Newer, but another workspace's account (9) and no workspace's (10): never listed.
    await db.insert(event).values([
      { id: 'evt_recentx1', accountId: 9, type: 'messages.sent', createdAt: new Date(t0 + 60_000) },
      { id: 'evt_recentx2', accountId: 10, type: 'messages.sent', createdAt: new Date(t0 + 60_000) },
    ]);

    const noSession = await app.inject({ method: 'GET', url: '/api/webhooks/stream/recent' });
    expect(noSession.statusCode).toBe(401);

    const unlinked = await signUp(app, 'webhooks-recent-unlinked@example.test');
    const none = await app.inject({ method: 'GET', url: '/api/webhooks/stream/recent', headers: { cookie: unlinked.cookie } });
    expect(none.statusCode).toBe(200);
    expect(none.json()).toEqual({ events: [] });

    const linked = await signUp(app, 'webhooks-recent-linked@example.test', { linked: true });
    const notOwner = await app.inject({ method: 'GET', url: '/api/webhooks/stream/recent', headers: { cookie: linked.cookie } });
    expect(notOwner.json()).toEqual({ events: [] });

    await linkTeam(teamId);
    const res = await app.inject({ method: 'GET', url: '/api/webhooks/stream/recent', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const { events } = res.json() as { events: unknown[] };
    expect(events).toHaveLength(50);
    expect(events.slice(0, 3)).toEqual([
      { id: 'evt_recent99', type: 'messages.sent', accountId: 8, ts: '2026-10-01T00:00:50.000Z', data: null },
      { id: 'evt_recent50', type: 'messages.received', accountId: 7, ts: '2026-10-01T00:00:50.000Z', data: null },
      { id: 'evt_recent49', type: 'tips.received', accountId: 7, ts: '2026-10-01T00:00:49.000Z', data: null },
    ]);
    expect(events.at(-1)).toMatchObject({ id: 'evt_recent02' }); // 52 rows: the two oldest are cut
  });
});
