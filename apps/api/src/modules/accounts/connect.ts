import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { connectAccountBody } from '../../contracts.js';
import { assertTeamLinked } from '../../lib/team-link.js';

/**
 * Dashboard-only account connect (session cookie + CSRF). Mounted at /api/accounts.
 * `/api` is outside the `/v1` request-log scope, so the cURL (live OF cookies) is never stored; it is forwarded to the
 * upstream's `/session/bootstrap` and the upstream's status and body are returned unchanged.
 */
export default async function accountsConnectRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook('preHandler', app.requireSession);

  r.post('/connect', { schema: { tags: ['dashboard'], body: connectAccountBody } }, async (request, reply) => {
    await assertTeamLinked(request.session.teamId);
    const { curl, nickname, proxyUrl } = request.body;
    const res = await app.upstream.bootstrapSession(JSON.stringify({ curl, nickname, proxy_url: proxyUrl }), request.id);
    return reply
      .status(res.status)
      .header('content-type', res.headers.get('content-type') ?? 'application/json')
      .send(res.body);
  });
}
