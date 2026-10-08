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
 * without `skip_users=none`, message pages hold at most `pageCap` messages however large `limit` is, mass history ignores `offset` and always reports `hasMore`, and a chat in `stuckChats`
 * ignores the `first_id` cursor. `rateLimit` answers that many requests 429 (with `retryAfter` when set), then
 * `badGateway` that many 502; `unauthorized` answers every request 401, as the upstream does once OF refuses the session.
 */
export type FakeOf = {
  chats: { withUser: { id: number; username?: string; name?: string; displayName?: string }; lastMessage: { id: number; createdAt: string } | null }[];
  messages: Record<number, Raw[]>;
  mass: (Raw & { id: number; date: string })[];
  transactions: (Raw & { createdAt: string })[];
  welcome: Raw | null;
  pageCap?: number;
  chatPageCap?: number;
  noNextOffset?: boolean;
  stuckChats?: number[];
  rateLimit?: number;
  retryAfter?: string;
  badGateway?: number;
  unauthorized?: boolean;
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
    return page(older, 0, Math.min(limit, of.pageCap ?? limit));
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
 * curl with a numeric `user-id` header, else 400 `invalid_curl` (shaped like the upstream). `/ws` (plan-v4 §2.2) instead needs
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
