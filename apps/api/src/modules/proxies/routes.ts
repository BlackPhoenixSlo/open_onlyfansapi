import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { createProxyBody, proxyLabel, proxyList } from '../../contracts.js';
import { assertTeamLinked } from '../../lib/team-link.js';
import { passThrough } from '../../lib/upstream.js';
import { assertProxyUsable, listUsableProxies, parse, toProxy, type UpstreamProxy } from './service.js';

/**
 * Dashboard-only proxy registry (session cookie + CSRF), mounted at /api: the upstream's proxies with their bound
 * accounts and traffic stats, adding an unbound proxy, and an egress probe. Upstream errors are passed through with their status.
 * A proxy bound to another workspace's account is hidden and cannot be probed; unbound proxies are shared.
 */
export default async function proxiesRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook('preHandler', app.requireSession);

  r.get('/proxies', { schema: { tags: ['dashboard'], response: { 200: proxyList } } }, async (request) => {
    await assertTeamLinked(request.session.teamId);
    return { items: await listUsableProxies(app.upstream, request.session.teamId, request.id) };
  });

  // The URL carries the proxy's password: `/api` is outside the request log, and it is only forwarded.
  r.post('/proxies', { schema: { tags: ['dashboard'], body: createProxyBody } }, async (request, reply) => {
    await assertTeamLinked(request.session.teamId);
    const res = await app.upstream.createProxy(JSON.stringify(request.body), request.id);
    if (!res.ok) return passThrough(reply, res);
    return reply.send({ proxy: toProxy(parse<UpstreamProxy>(res, 'proxy')) });
  });

  r.post(
    '/proxies/:label/probe',
    {
      schema: {
        tags: ['dashboard'],
        // Encoded by the upstream client.
        params: z.object({ label: proxyLabel }),
      },
    },
    async (request, reply) => {
      await assertTeamLinked(request.session.teamId);
      await assertProxyUsable(app.upstream, request.session.teamId, request.params.label, request.id);
      const res = await app.upstream.probeProxy(request.params.label, request.id);
      if (!res.ok) return passThrough(reply, res);
      return reply.send({ proxy: toProxy(parse<UpstreamProxy>(res, 'proxy')) });
    },
  );
}
