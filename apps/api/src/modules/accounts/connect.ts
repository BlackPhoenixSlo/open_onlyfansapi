import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { connectAccountBody, updateAccountBody } from '../../contracts.js';
import { AppError } from '../../lib/errors.js';
import { assertTeamLinked } from '../../lib/team-link.js';
import { toAccount } from './routes.js';
import type { UpstreamAccount } from './service.js';

/**
 * Dashboard-only account connect and edit (session cookie + CSRF). Mounted at /api/accounts.
 * `/api` is outside the `/v1` request-log scope, so the cURL (live OF cookies) and proxy URLs are never stored; they are
 * forwarded to the upstream, and its error statuses and bodies are returned unchanged.
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

  // The answer is whitelisted like `GET /v1/accounts`: the upstream row's proxy label stays here.
  r.patch(
    '/:id',
    {
      schema: {
        tags: ['dashboard'],
        params: z.object({ id: z.coerce.number().int().positive() }),
        body: updateAccountBody,
      },
    },
    async (request, reply) => {
      await assertTeamLinked(request.session.teamId);
      const { label, proxy } = request.body;
      const res = await app.upstream.updateAccount(request.params.id, JSON.stringify({ nickname: label, proxy }), request.id);
      if (!res.ok) {
        return reply
          .status(res.status)
          .header('content-type', res.headers.get('content-type') ?? 'application/json')
          .send(res.body);
      }
      let row: UpstreamAccount;
      try {
        row = JSON.parse(res.body.toString()) as UpstreamAccount;
      } catch {
        throw new AppError(502, 'upstream_error', 'The upstream answered an unreadable account');
      }
      return { account: toAccount(row) };
    },
  );
}
