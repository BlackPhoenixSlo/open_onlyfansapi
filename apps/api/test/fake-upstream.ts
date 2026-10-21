import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import websocket, { type WebSocket } from '@fastify/websocket';
import Fastify from 'fastify';

export type Recorded = {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string | null;
};

type FakeAccount = Record<string, unknown> & { id: number };

const ok = { 200: { description: 'Default Response' } };
const of = (operationId: string, extra: Record<string, unknown> = {}) => ({ tags: ['of-api'], operationId, responses: ok, ...extra });
const pathParam = (name: string) => ({ schema: { type: 'integer' }, in: 'path', name, required: true });
const queryParam = (name: string, schema: Record<string, unknown>) => ({ schema, in: 'query', name, required: false });

/** Shaped like `@fastify/swagger` output from the upstream: `/of/*` operations plus paths the gateway must not publish. */
export const UPSTREAM_SPEC = {
  openapi: '3.0.3',
  info: { title: 'Upstream API', version: '1.0.0' },
  servers: [{ url: 'http://localhost:3001' }],
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    schemas: {
      User: { type: 'object', properties: { avatar: { $ref: '#/components/schemas/Media' } } },
      Media: { type: 'object', properties: { url: { type: 'string' } } },
      OfAccountRow: { type: 'object', properties: { egressPort: { type: 'integer' } } },
    },
  },
  paths: {
    '/of/me': {
      get: of('me', {
        responses: { 200: { description: 'Me', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } } },
      }),
    },
    // The raw passthrough: published, never wrapped.
    '/of/_of/{path}': {
      get: of('of.passthrough.get', {
        parameters: [{ schema: { type: 'string' }, in: 'path', name: 'path', required: true }],
        responses: { 200: { description: 'OF body', content: { 'application/json': { schema: {} } } } },
      }),
    },
    // An internal operation under /of/ that the upstream does not tag as public.
    '/of/internal/egress': { get: { tags: ['internal'], operationId: 'internal.egress', responses: ok } },
    '/of/users/{userId}/posts': {
      get: of('users.posts.list', {
        parameters: [pathParam('userId'), queryParam('limit', { type: 'integer', default: 10 }), queryParam('order', { type: 'string', enum: ['asc', 'desc'] })],
      }),
    },
    '/of/chats/{chatId}/messages': {
      get: of('chats.messages.list', { parameters: [pathParam('chatId'), queryParam('limit', { type: 'integer' })] }),
      post: of('chats.messages.send', {
        parameters: [pathParam('chatId')],
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['text'],
                properties: { text: { type: 'string' }, price: { type: 'number' } },
                example: { text: 'Hello there', price: 0 },
              },
            },
          },
        },
      }),
    },
    '/of-accounts': {
      get: {
        tags: ['of-accounts'],
        operationId: 'ofAccounts.list',
        responses: { 200: { description: 'Rows', content: { 'application/json': { schema: { $ref: '#/components/schemas/OfAccountRow' } } } } },
      },
    },
  },
};

/**
 * One upstream `/ws` event frame (plan-v5 §2.4): `type` is the v5 name, `id` keeps the v4 form
 * (`message.received:<account>:<message>`), and `amount_cents` sits at the top level, beside the payload.
 */
export const eventFrame = (over: Record<string, unknown> = {}) => ({
  id: 'message.received:1001:1002',
  type: 'messages.received',
  account_id: 1001,
  ts: '2026-10-02T12:00:00.000Z',
  amount_cents: null,
  payload: { id: 1002, text: 'hi', price: 0, mediaCount: 0, fromUser: { id: 1003 } },
  ...over,
});

type Raw = Record<string, unknown>;

/**
 * OF data for the analytics backfill, served on the upstream's named routes when `state.of` is set (else those
 * paths echo like any `/of/*`). Lists are newest first. Like OF: chat-list pages hold at most `chatPageCap` (10)
 * chats however large `limit` is and carry `nextOffset` (unless `noNextOffset`), `withUser` is only `{ _view, id }`
 * without `skip_users=none`, message pages hold at most `pageCap` messages however large `limit` is (with `endPage`, every
 * page of messages says `hasMore` and the page after a chat's last is `{ list: [], hasMore: endPage.hasMore }`, as OF's
 * are with `false`), mass history ignores `offset` and always reports `hasMore`, a chat in `stuckChats` ignores the
 * `first_id` cursor, and one in `chatErrors` answers its messages pages (only those after the first with `afterFirst`)
 * `status` with OF's error body (`{ error: { code: 'of_error', status } }`, as the upstream passes OF's errors on), or
 * the upstream's own `{ detail }` with `notOf`. `rateLimit` answers that many requests
 * 429 (with `retryAfter` when set), then `badGateway` that many 502; `unauthorized` answers every request 401, as
 * the upstream does once OF refuses the session; `deadSession` answers every messages page 400 "Wrong user", as OF
 * answers a dead session's chat reads.
 */
export type FakeOf = {
  chats: { withUser: { id: number; username?: string; name?: string; displayName?: string }; lastMessage: { id: number; createdAt: string } | null }[];
  messages: Record<number, Raw[]>;
  mass: (Raw & { id: number; date: string })[];
  transactions: (Raw & { createdAt: string })[];
  welcome: Raw | null;
  pageCap?: number;
  endPage?: { hasMore: boolean };
  chatPageCap?: number;
  noNextOffset?: boolean;
  stuckChats?: number[];
  chatErrors?: Record<number, { status: number; afterFirst?: boolean; notOf?: boolean }>;
  rateLimit?: number;
  retryAfter?: string;
  badGateway?: number;
  unauthorized?: boolean;
  deadSession?: boolean;
};

/** `YYYY-MM-DD HH:MM:SS` (UTC) → epoch ms. */
const ofTime = (v: string | undefined) => Date.parse(`${String(v).replace(' ', 'T')}Z`);

function serveOf(of: FakeOf, path: string, q: Record<string, string | undefined>): unknown {
  const limit = Number(q.limit ?? 10);
  const offset = Number(q.offset ?? 0);
  const page = (list: unknown[], start: number, size: number) => ({ list: list.slice(start, start + size), hasMore: start + size < list.length });
  if (path === '/of/chats') {
    const chats = q.skip_users === 'none' ? of.chats : of.chats.map((c) => ({ ...c, withUser: { _view: 's', id: c.withUser.id } }));
    const p = page(chats, offset, Math.min(limit, of.chatPageCap ?? 10));
    return of.noNextOffset ? p : { ...p, nextOffset: offset + p.list.length };
  }
  const chat = /^\/of\/chats\/(\d+)\/messages$/.exec(path);
  if (chat) {
    const id = Number(chat[1]);
    const all = of.messages[id] ?? [];
    const older = q.first_id && !of.stuckChats?.includes(id) ? all.filter((m) => Number(m.id) < Number(q.first_id)) : all;
    const p = page(older, 0, Math.min(limit, of.pageCap ?? limit));
    return of.endPage ? { ...p, hasMore: p.list.length > 0 || of.endPage.hasMore } : p;
  }
  if (path === '/of/mass-messaging/overview') {
    const [start, end] = [ofTime(q.startDate), ofTime(q.endDate)];
    const items = of.mass.filter((m) => Date.parse(m.date) >= start && Date.parse(m.date) <= end).slice(0, limit);
    return { hasMore: true, items };
  }
  if (path === '/of/payouts/transactions') {
    const start = q.startDate ? ofTime(q.startDate) : -Infinity;
    return page(of.transactions.filter((t) => Date.parse(t.createdAt) >= start), offset, limit);
  }
  if (path === '/of/settings/welcome-message') return of.welcome;
  return undefined;
}

/** The subprotocols a `/ws` client offered (`Sec-WebSocket-Protocol`). */
const offered = (header: string | string[] | undefined) => String(header ?? '').split(',').map((p) => p.trim());

/**
 * Stand-in for the upstream: every route needs `authorization: Bearer <token>`, `/of/*` is echoed (JSON),
 * `/of/shaped?status&type&body&next&gzip` answers as told (`next` becomes `x-next-page`),
 * `/of-accounts` serves one account list, `/docs/json` a small OpenAPI spec and `/session/bootstrap` answers 200 for a
 * curl with a numeric `user-id` header, else 400 `invalid_curl` (shaped like the upstream). `PATCH /of-accounts/:id` edits a
 * listed account, `DELETE /of-accounts/:id` removes it (204, else 404), and `/proxies` (GET, POST) and `/proxies/:label/probe` serve `proxies` (probing `dead` answers 502 `proxy_error`). `/ws` (plan-v4 §2.2) instead needs
 * the subprotocols `bearer` and `bearer.<token>`, selects `bearer`, sends a heartbeat every 30 s and whatever
 * `pushFrame()` is given.
 */
export async function startFakeUpstream(token: string, accounts: FakeAccount[] = [], opts: { port?: number; host?: string } = {}) {
  const requests: Recorded[] = [];
  /** Test switches: make `/docs/json` answer 500; make `/ws` sockets accepted from now on never answer a close; serve OF data. */
  const state: { specFails: boolean; ignoreClose: boolean; of: FakeOf | null } = { specFails: false, ignoreClose: false, of: null };
  /** Open `/ws` sockets, and how many were ever accepted. */
  const sockets = new Set<WebSocket>();
  const ws = { connections: 0, maxOpen: 0 };
  /** `/proxies` entries, shaped like the upstream's (`username` and `password` here prove the gateway whitelists). */
  const proxies: (Record<string, unknown> & { label: string })[] = [
    {
      label: 'acct-1001',
      scheme: 'http',
      host: '203.0.113.10',
      port: 8080,
      username: 'proxy-user',
      password: 'proxy-secret',
      assigned_account_ids: ['1001'],
      verified_ip: null,
      verified_at: null,
      verified_geo: null,
      stats: {
        ok: 3,
        failed: 1,
        blocked: 1,
        last_status: 429,
        last_ok_at: '2026-10-09T11:30:00Z',
        last_error: 'timeout: slow',
        last_error_at: '2026-10-09T11:00:00Z',
        last_used_at: '2026-10-09T11:30:00Z',
      },
      since: '2026-10-09T10:00:00Z',
    },
    { label: 'proxy two', scheme: 'http', host: '203.0.113.20', port: 3128, assigned_account_ids: [], stats: {}, since: '2026-10-09T10:00:00Z' },
    { label: 'dead', scheme: 'socks5', host: '203.0.113.99', port: 1080, assigned_account_ids: [], stats: {}, since: '2026-10-09T10:00:00Z' },
  ];
  const app = Fastify({ forceCloseConnections: true });
  await app.register(websocket, { options: { handleProtocols: (p) => (p.has('bearer') ? 'bearer' : false) } });
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  app.addHook('onRequest', async (request, reply) => {
    requests.push({ method: request.method, url: request.url, headers: request.headers, body: null });
    if (request.url === '/ws') {
      const protocols = offered(request.headers['sec-websocket-protocol']);
      if (!protocols.includes('bearer') || !protocols.includes(`bearer.${token}`)) {
        return reply.status(401).send({ error: 'UNAUTHORIZED' });
      }
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) return reply.status(401).send({ error: 'UNAUTHORIZED' });
  });
  app.addHook('preHandler', async (request) => {
    requests.at(-1)!.body = typeof request.body === 'string' ? request.body : null;
  });

  app.get('/docs/json', async (_request, reply) => (state.specFails ? reply.status(500).send({ error: 'boom' }) : UPSTREAM_SPEC));
  app.get('/of-accounts', async () => accounts);
  app.post('/session/bootstrap', async (request, reply) => {
    const { curl } = JSON.parse(String(request.body)) as { curl: string };
    const uid = /user-id: (\d+)/.exec(curl)?.[1];
    if (!uid) return reply.status(400).send({ error: { code: 'invalid_curl', message: 'the curl has no numeric user-id header' } });
    return { accountId: Number(uid), username: 'fresh', status: 'connecting' };
  });
  app.patch('/of-accounts/:id', async (request, reply) => {
    const row = accounts.find((a) => a.id === Number((request.params as { id: string }).id));
    if (!row) return reply.status(404).send({ error: { code: 'account_not_found' } });
    const body = JSON.parse(String(request.body)) as { nickname?: string; proxy?: { label?: string; url?: string } | null };
    if (body.proxy?.label && !proxies.some((p) => p.label === body.proxy!.label)) {
      return reply.status(404).send({ error: { code: 'proxy_not_found' } });
    }
    if (body.proxy?.url && !/^(https?|socks5h?):\/\//.test(body.proxy.url)) {
      return reply.status(400).send({ error: { code: 'invalid_proxy_url', message: 'expected scheme://[user:pass@]host:port' } });
    }
    if (body.nickname) row.label = body.nickname;
    if (body.proxy !== undefined) row.proxyLabel = body.proxy ? (body.proxy.label ?? `acct-${row.id}`) : null;
    return row;
  });
  app.delete('/of-accounts/:id', async (request, reply) => {
    const i = accounts.findIndex((a) => a.id === Number((request.params as { id: string }).id));
    if (i < 0) return reply.status(404).send({ error: { code: 'account_not_found' } });
    accounts.splice(i, 1);
    return reply.status(204).send();
  });
  app.get('/proxies', async () => proxies);
  app.post('/proxies', async (request, reply) => {
    const { label, url } = JSON.parse(String(request.body)) as { label: string; url: string };
    if (proxies.some((p) => p.label === label)) return reply.status(409).send({ error: { code: 'proxy_exists' } });
    const u = new URL(url);
    const entry = {
      label,
      scheme: u.protocol.slice(0, -1),
      host: u.hostname,
      port: Number(u.port),
      assigned_account_ids: [],
      stats: {},
      since: '2026-10-09T10:00:00Z',
    };
    proxies.push(entry);
    return entry;
  });
  app.post('/proxies/bulk', async (request, reply) => {
    const { text } = JSON.parse(String(request.body)) as { text: string; scheme?: string };
    const added: unknown[] = [];
    const errors: unknown[] = [];
    text.split('\n').forEach((raw, i) => {
      const line = raw.trim();
      if (!line || line.startsWith('#')) return;
      const m = /^(\d+\.\d+\.\d+\.\d+):(\d+)(?::([^:]+):(\S+))?(?:\s+(\S+))?$/.exec(line);
      if (!m) {
        errors.push({ line: i + 1, text_redacted: line.replace(/(:[^:@\s]+){1,2}$/, (s) => s.replace(/[^:]+/g, '***')), reason: 'could not parse' });
        return;
      }
      const [, host, port, user, , label] = m;
      added.push({ label: label ?? `${host}:${port}`, host, port: Number(port), scheme: 'http', username: user ?? null });
    });
    return reply.send({ added, errors });
  });
  // Remote-browser login: a scripted job keyed by id; the principal and stream token gate access.
  // A `backend: 'browserbase'` job also reports a live view and, for proxy `proxy two`, a 402 proxy fallback.
  type Job = { id: string; principal: string; streamToken: string; polls: number; extra: Record<string, unknown> };
  const browserJobs = new Map<string, Job>();
  app.post('/login/browser/start', async (request, reply) => {
    const principal = String(request.headers['x-login-principal'] ?? '');
    if (!principal) return reply.status(400).send({ error: { code: 'missing_principal' } });
    const { proxy, proxy_label, backend } = JSON.parse(String(request.body)) as {
      email: string;
      password: string;
      proxy?: string;
      proxy_label?: string;
      backend?: string;
    };
    if (!proxy && !proxy_label) return reply.status(409).send({ error: { code: 'proxy_required' } });
    const extra =
      backend === 'browserbase'
        ? {
            liveViewUrl: 'https://live.example.invalid/sess-1',
            proxyFallback: proxy_label === 'proxy two',
            proxyFallbackStatus: proxy_label === 'proxy two' ? 402 : null,
          }
        : {};
    const job: Job = { id: `job-${browserJobs.size + 1}`, principal, streamToken: `tok-${browserJobs.size + 1}`, polls: 0, extra };
    browserJobs.set(job.id, job);
    return reply.send({ jobId: job.id, streamToken: job.streamToken, state: 'starting', message: null, challenge: null, needsOtp: false, accountId: null, username: null, error: null });
  });
  const jobFor = (request: { params: unknown; headers: Record<string, unknown> }, reply: { status: (n: number) => { send: (b: unknown) => unknown } }) => {
    const job = browserJobs.get((request.params as { jobId: string }).jobId);
    if (!job || job.principal !== String(request.headers['x-login-principal'] ?? '')) {
      reply.status(404).send({ error: { code: 'job_not_found' } });
      return null;
    }
    return job;
  };
  const snapshot = (job: Job, over: Record<string, unknown> = {}) => ({
    jobId: job.id, state: 'typing', message: null, challenge: null, needsOtp: false, accountId: null, username: null, error: null, ...job.extra, ...over,
  });
  app.get('/login/browser/:id', async (request, reply) => {
    const job = jobFor({ params: { jobId: (request.params as { id: string }).id }, headers: request.headers }, reply);
    if (!job) return reply;
    job.polls++;
    // Second poll reports success, so a test can see the account get claimed.
    return reply.send(job.polls >= 2 ? snapshot(job, { state: 'done', accountId: 2002, username: 'browser_acct' }) : snapshot(job));
  });
  app.post('/login/browser/:id/input', async (request, reply) => {
    const job = jobFor({ params: { jobId: (request.params as { id: string }).id }, headers: request.headers }, reply);
    return job ? reply.send(snapshot(job, { state: 'challenge', challenge: { kind: 'turnstile', w: 320, h: 240 } })) : reply;
  });
  app.post('/login/browser/:id/cancel', async (request, reply) => {
    const job = jobFor({ params: { jobId: (request.params as { id: string }).id }, headers: request.headers }, reply);
    return job ? reply.send(snapshot(job, { state: 'cancelled' })) : reply;
  });
  app.get('/login/browser/:id/stream', async (request, reply) => {
    const job = browserJobs.get((request.params as { id: string }).id);
    const token = (request.query as { token?: string }).token;
    if (!job || job.streamToken !== token) return reply.status(404).send({ error: { code: 'job_not_found' } });
    return reply.header('content-type', 'text/event-stream').send('data: {"state":"done","frame":{"w":320,"h":240,"png":"UE5H"}}\n\n');
  });
  app.post('/proxies/:label/probe', async (request, reply) => {
    const entry = proxies.find((p) => p.label === (request.params as { label: string }).label);
    if (!entry) return reply.status(404).send({ error: { code: 'proxy_not_found' } });
    if (entry.label === 'dead') return reply.status(502).send({ error: { code: 'proxy_error', message: 'proxy_probe_failed: refused' } });
    // `proxy two` tunnels to ipify but not to onlyfans.com.
    const ofBlocked = entry.label === 'proxy two';
    Object.assign(entry, {
      verified_ip: '198.51.100.7',
      verified_geo: 'Ljubljana, SI',
      verified_at: '2026-10-09T12:00:00Z',
      verified_of_reachable: !ofBlocked,
      verified_of_error: ofBlocked ? 'curl: (56) CONNECT tunnel failed, response 403' : null,
    });
    return entry;
  });
  app.get('/ws', { websocket: true }, (socket) => {
    sockets.add(socket);
    if (state.ignoreClose) socket.close = () => {}; // an unresponsive peer: the client's close frame gets no reply
    ws.connections++;
    ws.maxOpen = Math.max(ws.maxOpen, sockets.size);
    const heartbeat = setInterval(() => socket.send(JSON.stringify({ type: 'heartbeat', ts: new Date().toISOString() })), 30_000);
    socket.on('close', () => {
      clearInterval(heartbeat);
      sockets.delete(socket);
    });
  });
  app.all('/of/*', async (request, reply) => {
    reply.header('x-of-cache', 'MISS').header('x-ratelimit-limit', '300').header('x-ratelimit-remaining', '299');
    if (request.url.startsWith('/of/rate-limited')) return reply.status(429).header('retry-after', '42').send({ error: 'RATE_LIMITED' });
    if (state.of && request.method === 'GET') {
      if (state.of.rateLimit) {
        state.of.rateLimit--;
        if (state.of.retryAfter !== undefined) reply.header('retry-after', state.of.retryAfter);
        return reply.status(429).send({ error: 'RATE_LIMITED' });
      }
      if (state.of.unauthorized) return reply.status(401).send({ error: { code: 'of_error', status: 401 } });
      const chat = /^\/of\/chats\/(\d+)\/messages/.exec(request.url);
      if (chat && state.of.deadSession) return reply.status(400).send({ error: { code: 'of_error', status: 400, message: 'Wrong user' } });
      const fail = chat ? state.of.chatErrors?.[Number(chat[1])] : undefined;
      if (fail && (!fail.afterFirst || (request.query as Record<string, string | undefined>).first_id)) {
        return reply.status(fail.status).send(fail.notOf ? { detail: 'Not Found' } : { error: { code: 'of_error', status: fail.status } });
      }
      if (state.of.badGateway) {
        state.of.badGateway--;
        return reply.status(502).send({ error: 'PROXY_ERROR' });
      }
      const data = serveOf(state.of, request.url.split('?')[0]!, request.query as Record<string, string | undefined>);
      if (data !== undefined) return reply.type('application/json').send(JSON.stringify(data));
    }
    // Headers, then a body that stalls past the gateway's timeout (UPSTREAM_TIMEOUT_MS=2000 in tests).
    if (request.url.startsWith('/of/slow-body')) {
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'application/json' });
      reply.raw.write('{"partial":');
      setTimeout(() => reply.raw.end('true}'), 2500).unref();
      return reply;
    }
    if (request.url.startsWith('/of/shaped')) {
      const q = request.query as Record<string, string | undefined>;
      if (q.next !== undefined) reply.header('x-next-page', q.next);
      if (q.type) reply.header('content-type', q.type);
      reply.status(Number(q.status ?? 200));
      const body = Buffer.from(q.body ?? '');
      return q.gzip ? reply.header('content-encoding', 'gzip').send(gzipSync(body)) : reply.send(body);
    }
    return { echo: true, method: request.method, url: request.url };
  });

  const address = await app.listen({ port: opts.port ?? 0, host: opts.host ?? '127.0.0.1' });
  return {
    url: address,
    requests,
    state,
    proxies,
    sockets,
    ws,
    /** Sends one text frame (an object is JSON-encoded) to every open `/ws` socket. */
    pushFrame: (frame: unknown) => {
      for (const socket of sockets) socket.send(typeof frame === 'string' ? frame : JSON.stringify(frame));
    },
    /** Kills every open `/ws` socket without a close handshake, as a network drop would. */
    dropSockets: () => {
      for (const socket of sockets) socket.terminate();
    },
    close: () => app.close(),
  };
}

// `tsx test/fake-upstream.ts`: a dev upstream on FAKE_UPSTREAM_PORT (3001) with one seeded account.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await startFakeUpstream(
    process.env.UPSTREAM_TOKEN ?? 'dev-upstream-token',
    [{ id: 1, label: 'Demo', ofUsername: 'demo', ofDisplayName: 'Demo', ofAvatarUrl: null, status: 'active' }],
    { port: Number(process.env.FAKE_UPSTREAM_PORT ?? 3001), host: '0.0.0.0' },
  );
  console.log(`fake upstream listening on ${url}`);
}
