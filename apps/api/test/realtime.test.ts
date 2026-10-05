import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/index.js';
import { env } from '../src/env.js';
import { publish } from '../src/lib/event-bus.js';
import { envelope } from '../src/lib/signature.js';
import { sweep } from '../src/modules/realtime/hub.js';
import { bearer, createKey, dashboard, linkTeam, resetDb, signUp, waitForLogs } from './helpers.js';

const app = await buildApp({ logger: false });
const saved = { RUN_JOBS: env.RUN_JOBS, UPSTREAM_WS_URL: env.UPSTREAM_WS_URL };
let u: Awaited<ReturnType<typeof signUp>>;
let port: number;
let keyA: Awaited<ReturnType<typeof createKey>>; // allowlist [1]
let keyB: Awaited<ReturnType<typeof createKey>>; // every account

beforeAll(async () => {
  await resetDb();
  u = await signUp(app, 'realtime@example.test');
  await linkTeam(u.teamId);
  keyA = await createKey(app, u.cookie, { name: 'A', allowedAccountIds: [1] });
  keyB = await createKey(app, u.cookie, { name: 'B' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
  // The socket needs the event source configured; jobs stay off (they were not registered at build time).
  env.RUN_JOBS = true;
  env.UPSTREAM_WS_URL = 'ws://127.0.0.1:9/ws';
});
afterAll(async () => {
  Object.assign(env, saved);
  await app.close();
  await pool.end();
});

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** `ready`, or an event envelope (whose payload carries the test event's id as `ref`). */
type Frame = { type?: string; accountIds?: number[] | null; event?: string; account_id?: string; payload?: { ref?: string } };

/** A browser-style client: the key as the `bearer.<key>` subprotocol. Resolves after the `ready` frame. */
async function connect(secret: string, query = '') {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws${query}`, ['bearer', `bearer.${secret}`]);
  const frames: Frame[] = [];
  const raw: string[] = [];
  ws.addEventListener('message', (m) => {
    raw.push(String(m.data));
    frames.push(JSON.parse(String(m.data)) as Frame);
  });
  const closed = new Promise<CloseEvent>((resolve) => ws.addEventListener('close', resolve));
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('socket refused')));
  });
  await until(() => frames.length > 0);
  return { ws, frames, raw, closed, ids: () => frames.filter((f) => f.event).map((f) => f.payload?.ref) };
}

/** A raw handshake: the HTTP status, headers and body of a refusal, or the 101's headers (socket then dropped). */
function handshake(headers: Record<string, string>, query = '') {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: { error?: { code: string } } | null }>(
    (resolve, reject) => {
      const req = http.request({
        agent: false,
        port,
        host: '127.0.0.1',
        path: `/v1/ws${query}`,
        headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers },
      });
      req.on('upgrade', (res, socket) => {
        socket.destroy();
        resolve({ status: res.statusCode!, headers: res.headers, body: null });
      });
      req.on('response', (res) => {
        let text = '';
        res.on('data', (c: Buffer) => (text += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: text ? JSON.parse(text) : null }));
      });
      req.on('error', reject);
      req.end();
    },
  );
}

const protocols = (secret: string) => ({ 'sec-websocket-protocol': `bearer, bearer.${secret}` });
let seq = 0;
const event = (accountId: number | null) => {
  const id = `evt_test${++seq}`;
  return { id, type: 'messages.received', accountId, ts: new Date().toISOString(), data: { text: 'hi', ref: id } };
};
const wsLogs = (keyId: string) =>
  pool.query('SELECT * FROM request_log WHERE api_key_id = $1 AND endpoint = $2', [keyId, 'GET /v1/ws']);

describe('GET /v1/ws', () => {
  it('selects the `bearer` subprotocol and never echoes the key', async () => {
    const c = await connect(keyB.secret);
    expect(c.ws.protocol).toBe('bearer');
    expect(c.frames[0]).toEqual({ type: 'ready', accountIds: null });
    c.ws.close();

    const res = await handshake(protocols(keyB.secret));
    expect(res.status).toBe(101);
    expect(res.headers['sec-websocket-protocol']).toBe('bearer');
    expect(JSON.stringify(res.headers)).not.toContain(keyB.secret);
  });

  it('accepts the key as an Authorization header without a subprotocol', async () => {
    const res = await handshake(bearer(keyB.secret));
    expect(res.status).toBe(101);
  });

  it("delivers an event only to sockets whose key allows its account", async () => {
    const a = await connect(keyA.secret);
    const b = await connect(keyB.secret);
    expect(a.frames[0]).toEqual({ type: 'ready', accountIds: [1] });
    const two = event(2);
    const one = event(1);
    publish(two);
    publish(one);
    await until(() => a.ids().includes(one.id) && b.ids().includes(one.id));
    expect(b.ids()).toEqual([two.id, one.id]);
    expect(a.ids()).toEqual([one.id]);
    // A WS frame is the webhook body: the same envelope() bytes.
    expect(b.raw[1]).toBe(`{"event":"messages.received","account_id":"2","payload":{"text":"hi","ref":"${two.id}"}}`);
    expect(b.raw[1]).toBe(envelope(two));

    const none = event(null);
    const again = event(1);
    publish(none);
    publish(again);
    await until(() => a.ids().includes(again.id) && b.ids().includes(again.id));
    expect(b.ids().slice(2)).toEqual([none.id, again.id]);
    expect(b.raw[3]).toBe(`{"event":"messages.received","payload":{"text":"hi","ref":"${none.id}"}}`);
    expect(a.ids()).toEqual([one.id, again.id]);
    a.ws.close();
    b.ws.close();
  });

  it('refuses an account outside the allowlist before upgrade, and logs the refusal', async () => {
    const res = await handshake(protocols(keyA.secret), '?accountId=2');
    expect(res.status).toBe(403);
    expect(res.body?.error?.code).toBe('account_not_allowed');
    const id = res.headers['x-request-id'] as string;
    await waitForLogs([id]);
    const { rows } = await pool.query('SELECT status_code, error_code FROM request_log WHERE id = $1', [id]);
    expect(rows[0]).toEqual({ status_code: 403, error_code: 'account_not_allowed' });
  });

  it('closes 4403 or narrows delivery when the allowlist is edited', async () => {
    const d = await createKey(app, u.cookie, { name: 'D', allowedAccountIds: [1, 2] });
    const filtered = await connect(d.secret, '?accountId=2');
    const all = await connect(d.secret);
    expect(filtered.frames[0]).toEqual({ type: 'ready', accountIds: [2] });
    const patch = await app.inject({ method: 'PATCH', url: `/api/keys/${d.key.id}`, headers: dashboard(u.cookie), payload: { allowedAccountIds: [1] } });
    expect(patch.statusCode).toBe(200);
    await sweep();
    expect((await filtered.closed).code).toBe(4403);
    const two = event(2);
    const one = event(1);
    publish(two);
    publish(one);
    await until(() => all.ids().includes(one.id));
    expect(all.ids()).toEqual([one.id]);
    all.ws.close();
  });

  it('closes an idle socket with 4401 on the sweep after its key is revoked', async () => {
    const a = await connect(keyA.secret);
    const res = await app.inject({ method: 'DELETE', url: `/api/keys/${keyA.key.id}`, headers: dashboard(u.cookie) });
    expect(res.statusCode).toBe(204);
    await sweep();
    const closed = await a.closed;
    expect(closed.code).toBe(4401);
    expect(closed.reason).toBe('invalid_api_key');
  });

  it('writes exactly one request_log row per session, without key material', async () => {
    const c = await createKey(app, u.cookie, { name: 'C' });
    env.LOG_BODIES = 'all';
    const s = await connect(c.secret, '?accountId=7').finally(() => (env.LOG_BODIES = 'errors'));
    const seven = event(7);
    publish(seven);
    await until(() => s.ids().includes(seven.id));
    s.ws.close(1000);
    await s.closed;
    await until(async () => (await wsLogs(c.key.id)).rows[0]?.resp_bytes > 0);
    const { rows } = await wsLogs(c.key.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ method: 'GET', path: '/v1/ws', status_code: 101, account_id: 7, query: 'accountId=7', error_code: null, req_body: null, resp_body: null });
    expect(rows[0].resp_bytes).toBeGreaterThan(0);
    const text = JSON.stringify(rows[0]);
    expect(text).not.toContain(c.secret);
    expect(text).not.toContain('bearer');
  });

  it('refuses a sixth socket for one key with 429', async () => {
    const e = await createKey(app, u.cookie, { name: 'E' });
    const open = [];
    for (let i = 0; i < 5; i++) open.push(await connect(e.secret));
    const res = await handshake(protocols(e.secret));
    expect(res.status).toBe(429);
    expect(res.body?.error?.code).toBe('too_many_sockets');
    for (const s of open) s.ws.close();
  });

  it('refuses `bearer.<key>` offered without `bearer` with 400, and logs no key material', async () => {
    const res = await handshake({ 'sec-websocket-protocol': `bearer.${keyB.secret}` });
    expect(res.status).toBe(400);
    expect(res.body?.error?.code).toBe('invalid_subprotocol');
    expect(JSON.stringify(res.headers)).not.toContain(keyB.secret);
    expect(JSON.stringify(res.body)).not.toContain(keyB.secret);
    const id = res.headers['x-request-id'] as string;
    await waitForLogs([id]);
    const { rows } = await pool.query('SELECT * FROM request_log WHERE id = $1', [id]);
    expect(rows[0]).toMatchObject({ status_code: 400, error_code: 'invalid_subprotocol' });
    expect(JSON.stringify(rows[0])).not.toContain(keyB.secret);
  });

  it('refuses an unknown key and the dashboard session with 401', async () => {
    const bad = await handshake(protocols('gk_nope'));
    expect(bad.status).toBe(401);
    expect(bad.body?.error?.code).toBe('invalid_api_key');
    for (const headers of [dashboard(u.cookie), { cookie: u.cookie }]) {
      const res = await handshake(headers);
      expect(res.status).toBe(401);
      expect(res.body?.error?.code).toBe('unauthorized');
    }
  });

  it('reads a subprotocol key only on a WebSocket upgrade', async () => {
    for (const headers of [protocols(keyB.secret), { ...protocols(keyB.secret), upgrade: 'websocket' }]) {
      const res = await app.inject({ method: 'GET', url: '/v1/whoami', headers });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('unauthorized');
    }
  });

  it('closes with 4401 on the sweep after the workspace is unlinked', async () => {
    const s = await connect(keyB.secret);
    await pool.query('DELETE FROM team_backend WHERE team_id = $1', [u.teamId]);
    try {
      await sweep();
      const closed = await s.closed;
      expect(closed.code).toBe(4401);
      expect(closed.reason).toBe('team_not_linked');
    } finally {
      await linkTeam(u.teamId);
    }
  });

  it('closes a slow consumer with 1013', async () => {
    const opened = new Promise<{ bufferedAmount: number }>((resolve) => app.websocketServer.once('connection', resolve));
    const s = await connect(keyB.secret);
    Object.defineProperty(await opened, 'bufferedAmount', { get: () => 2 * 1024 * 1024 });
    publish(event(1));
    const closed = await s.closed;
    expect(closed.code).toBe(1013);
    expect(closed.reason).toBe('slow_consumer');
  });

  it('answers 503 without an event source', async () => {
    env.UPSTREAM_WS_URL = undefined;
    try {
      const res = await handshake(protocols(keyB.secret));
      expect(res.status).toBe(503);
      expect(res.body?.error?.code).toBe('realtime_unavailable');
    } finally {
      env.UPSTREAM_WS_URL = saved.UPSTREAM_WS_URL ?? 'ws://127.0.0.1:9/ws';
    }
  });

  it('closes open sockets with 1001 when the app closes, terminating a peer that never answers a close', async () => {
    const s = await connect(keyB.secret);
    // A raw upgrade that reads but never answers the close frame (ws would wait 30 s for it).
    const opened = new Promise<{ bufferedAmount: number }>((resolve) => app.websocketServer.once('connection', resolve));
    const raw = await new Promise<Socket>((resolve, reject) => {
      const req = http.request({
        agent: false,
        port,
        host: '127.0.0.1',
        path: '/v1/ws',
        headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...protocols(keyB.secret) },
      });
      req.on('upgrade', (_res, socket: Socket, head: Buffer) => {
        if (head.length > 0) resolve(socket);
        else socket.once('data', () => resolve(socket));
      });
      req.on('error', reject);
      req.end();
    });
    let received = '';
    raw.on('data', (chunk: Buffer) => (received += chunk.toString('latin1')));
    const rawClosed = new Promise((resolve) => raw.on('close', resolve));
    Object.defineProperty(await opened, 'bufferedAmount', { get: () => 2 * 1024 * 1024 });
    publish(event(1));
    await until(() => received.includes('slow_consumer'));

    const started = Date.now();
    await app.close();
    expect(Date.now() - started).toBeLessThan(2000);
    expect((await s.closed).code).toBe(1001);
    await rawClosed;
  });
});
