import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { db } from '../../db/index.js';
import { requestLog } from '../../db/schema.js';
import { env } from '../../env.js';
import { parseAccountId } from '../proxy/routes.js';
import { redactBody, redactHeaders, redactQuery } from './redact.js';

const PROXY_ROUTE = '/v1/:account/*';
const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Proxied calls: `GET /users/:id/posts` (`/v1/{account}` stripped, numeric and uuid segments → `:id`). Gateway routes: their pattern. */
export function normaliseEndpoint(method: string, routeUrl: string | undefined, path: string): string {
  if (routeUrl !== PROXY_ROUTE) return `${method} ${routeUrl ?? path}`;
  const rest = path.replace(/^\/v1\/[^/]+/, '') || '/';
  return `${method} ${rest
    .split('/')
    .map((s) => (ID_SEGMENT.test(s) ? ':id' : s))
    .join('/')}`;
}

/** The `code` of a gateway-generated error body (`{ error: { code, requestId } }`); null for upstream bodies. */
function gatewayErrorCode(body: string | Buffer | null, requestId: string): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body.toString()) as { error?: { code?: unknown; requestId?: unknown } } | null;
    return parsed?.error?.requestId === requestId && typeof parsed.error.code === 'string' ? parsed.error.code : null;
  } catch {
    return null;
  }
}

type Captured = { payload: unknown; ip: string; durationMs: number; createdAt: Date };

function toRow(request: FastifyRequest, reply: FastifyReply, { payload, ip, durationMs, createdAt }: Captured): typeof requestLog.$inferInsert {
  const { actor, url } = request;
  const q = url.indexOf('?');
  const path = q === -1 ? url : url.slice(0, q);
  const status = reply.statusCode;
  const respBody = typeof payload === 'string' || Buffer.isBuffer(payload) ? payload : null;
  const reqBody =
    typeof request.body === 'string' ? request.body : request.body == null ? null : JSON.stringify(request.body);
  const keepBodies = env.LOG_BODIES === 'all' || (env.LOG_BODIES === 'errors' && status >= 400);
  const account = (request.params as { account?: string } | undefined)?.account;
  return {
    id: request.id,
    teamId: actor.teamId,
    apiKeyId: actor.keyId,
    userId: actor.userId,
    accountId: account === undefined ? null : parseAccountId(account),
    method: request.method,
    path,
    endpoint: normaliseEndpoint(request.method, request.routeOptions.url, path),
    query: redactQuery(q === -1 ? '' : url.slice(q + 1)),
    ip,
    statusCode: status,
    durationMs,
    reqBytes: reqBody ? Buffer.byteLength(reqBody) : Number(request.headers['content-length']) || 0,
    respBytes: respBody ? Buffer.byteLength(respBody) : Number(reply.getHeader('content-length')) || 0,
    errorCode: status >= 400 ? gatewayErrorCode(respBody, request.id) : null,
    reqHeaders: redactHeaders(request.headers),
    reqBody: keepBodies ? redactBody(reqBody, request.headers['content-type'], env.LOG_BODY_MAX_BYTES) : null,
    respBody: keepBodies ? redactBody(respBody, String(reply.getHeader('content-type') ?? ''), env.LOG_BODY_MAX_BYTES) : null,
    createdAt,
  };
}

/**
 * Adds request-log hooks to the `/v1` scope (after `authenticate`). Requests without an actor (401s) are not logged,
 * nor are the dashboard session's calls to gateway routes (its own polling); its proxied calls (playground) are.
 * Each row is inserted off the response path; a failed insert is logged, never thrown. Pending inserts finish on close.
 */
export function captureRequestLogs(scope: FastifyInstance) {
  // The ip is read in onSend: on a refused WebSocket upgrade, @fastify/websocket destroys the socket before our
  // onResponse runs, and request.ip reads the socket.
  const sent = new WeakMap<FastifyRequest, { payload: unknown; ip: string }>();
  const pending = new Set<Promise<void>>();

  scope.addHook('onSend', async (request, _reply, payload) => {
    sent.set(request, { payload, ip: request.ip });
    return payload;
  });

  scope.addHook('onResponse', async (request, reply) => {
    if (!request.actor) return;
    if (request.actor.keyId === null && request.routeOptions.url !== PROXY_ROUTE) return;
    const durationMs = Math.round(reply.elapsedTime);
    const { payload, ip } = sent.get(request) ?? { payload: undefined, ip: request.ip };
    const captured = { payload, ip, durationMs, createdAt: new Date(Date.now() - durationMs) };
    setImmediate(() => {
      const write: Promise<void> = (async () => {
        await db.insert(requestLog).values(toRow(request, reply, captured));
      })()
        .catch((err) => request.log.error({ err }, 'request log insert failed'))
        .finally(() => pending.delete(write));
      pending.add(write);
    });
  });

  scope.addHook('onClose', async () => {
    await Promise.allSettled(pending);
  });
}
