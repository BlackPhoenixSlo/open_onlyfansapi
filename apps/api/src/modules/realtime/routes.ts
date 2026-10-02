import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { env } from '../../env.js';
import { AppError } from '../../lib/errors.js';
import { assertTeamLinked } from '../../lib/team-link.js';
import { BEARER_PROTOCOL_PREFIX, offeredProtocols } from '../../plugins/actor.js';
import { normaliseEndpoint } from '../logs/capture.js';
import { redactHeaders, redactQuery } from '../logs/redact.js';
import { addClient, MAX_SOCKETS_PER_KEY, socketCount, startHub } from './hub.js';

const querystring = z.object({ accountId: z.coerce.number().int().positive().max(2_147_483_647).optional() });
type Query = z.infer<typeof querystring>;

/**
 * `GET /v1/ws[?accountId=<id>]`, the client event socket (plan-v4 §2.5). Mounted under /v1, so `authenticate`, the
 * request log (for refusals) and the per-key rate limit run first; every refusal is a normal HTTP error before upgrade.
 */
export default async function realtimeRoutes(app: FastifyInstance) {
  const stop = startHub(app.log);
  app.addHook('preClose', stop);
  /** The handshake's reply, for its elapsed time once the socket is open. */
  const replies = new WeakMap<FastifyRequest, FastifyReply>();

  async function refuse(request: FastifyRequest<{ Querystring: Query }>, reply: FastifyReply) {
    const { actor } = request;
    if (actor.keyId === null) {
      throw new AppError(401, 'unauthorized', 'The event socket takes an API key, not the dashboard session');
    }
    const offered = offeredProtocols(request);
    if (offered.some((p) => p.startsWith(BEARER_PROTOCOL_PREFIX)) && !offered.includes('bearer')) {
      throw new AppError(400, 'invalid_subprotocol', "Offer 'bearer' together with 'bearer.<key>', so the response never echoes the key");
    }
    const { accountId } = request.query;
    if (accountId !== undefined && actor.accountIds && !actor.accountIds.includes(accountId)) {
      throw new AppError(403, 'account_not_allowed', `This API key cannot use account ${accountId}`);
    }
    await assertTeamLinked(actor.teamId);
    if (socketCount(actor.keyId) >= MAX_SOCKETS_PER_KEY) {
      throw new AppError(429, 'too_many_sockets', `An API key can hold at most ${MAX_SOCKETS_PER_KEY} open sockets`);
    }
    if (!(env.RUN_JOBS && env.UPSTREAM_WS_URL)) {
      throw new AppError(503, 'realtime_unavailable', 'Realtime events are not enabled on this gateway');
    }
    replies.set(request, reply);
  }

  app.withTypeProvider<ZodTypeProvider>().get(
    '/ws',
    { websocket: true, schema: { querystring }, preHandler: refuse },
    (socket, request) => {
      // The hub closes its sockets with 1001 in its own preClose; @fastify/websocket's default preClose runs first and
      // would close every tracked client without a code.
      app.websocketServer.clients.delete(socket);
      const { actor, url } = request;
      const accountId = request.query.accountId ?? null;
      const q = url.indexOf('?');
      const path = q === -1 ? url : url.slice(0, q);
      const durationMs = Math.round(replies.get(request)?.elapsedTime ?? 0);
      addClient(
        socket,
        { keyId: actor.keyId!, allowed: actor.accountIds, accountId },
        {
          id: request.id,
          teamId: actor.teamId,
          apiKeyId: actor.keyId,
          userId: null,
          accountId,
          method: request.method,
          path,
          endpoint: normaliseEndpoint(request.method, request.routeOptions.url, path),
          query: redactQuery(q === -1 ? '' : url.slice(q + 1)),
          ip: request.ip,
          statusCode: 101,
          durationMs,
          reqBytes: 0,
          respBytes: 0,
          errorCode: null,
          reqHeaders: redactHeaders(request.headers),
          reqBody: null,
          respBody: null,
          createdAt: new Date(Date.now() - durationMs),
        },
      );
    },
  );
}
