import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { env } from '../../env.js';
import { AppError } from '../../lib/errors.js';
import { assertTeamLinked } from '../../lib/team-link.js';
import { BEARER_PROTOCOL_PREFIX, offeredProtocols } from '../../plugins/actor.js';
import { assertAccountAllowed } from '../accounts/ownership.js';
import { toRow } from '../logs/capture.js';
import { MAX_SOCKETS_PER_KEY, startHub } from './hub.js';

const querystring = z.object({ accountId: z.coerce.number().int().positive().max(2_147_483_647).optional() });
type Query = z.infer<typeof querystring>;

/**
 * `GET /v1/ws[?accountId=<id>]`, the client event socket (plan-v4 §2.5). Mounted under /v1, so `authenticate`, the
 * request log (for refusals) and the per-key rate limit run first; every refusal is a normal HTTP error before upgrade.
 */
export default async function realtimeRoutes(app: FastifyInstance) {
  const hub = startHub(app.log);
  app.addHook('preClose', hub.stop);
  /** The handshake's reply (for its elapsed time once the socket is open) and its key, checked by `refuse`. */
  const handshakes = new WeakMap<FastifyRequest, { reply: FastifyReply; keyId: string }>();

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
    await assertTeamLinked(actor.teamId);
    if (accountId !== undefined) await assertAccountAllowed(actor, accountId);
    if (hub.count(actor.keyId) >= MAX_SOCKETS_PER_KEY) {
      throw new AppError(429, 'too_many_sockets', `An API key can hold at most ${MAX_SOCKETS_PER_KEY} open sockets`);
    }
    if (!(env.RUN_JOBS && env.UPSTREAM_WS_URL)) {
      throw new AppError(503, 'realtime_unavailable', 'Realtime events are not enabled on this gateway');
    }
    handshakes.set(request, { reply, keyId: actor.keyId });
  }

  app.withTypeProvider<ZodTypeProvider>().get(
    '/ws',
    { websocket: true, schema: { querystring }, preHandler: refuse },
    (socket, request) => {
      const { actor } = request;
      const accountId = request.query.accountId ?? null;
      const { reply, keyId } = handshakes.get(request)!;
      const durationMs = Math.round(reply.elapsedTime);
      const row = toRow(request, reply, {
        payload: undefined,
        ip: request.ip,
        durationMs,
        createdAt: new Date(Date.now() - durationMs),
      });
      hub.add(socket, { keyId, teamId: actor.teamId, allowed: actor.accountIds, accountId }, { ...row, statusCode: 101, accountId });
    },
  );
}
