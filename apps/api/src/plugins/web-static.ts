import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { notFoundHandler } from '../lib/errors.js';

const API_PREFIXES = ['/api/', '/v1/', '/openapi.json', '/docs', '/healthz'];

/**
 * Production only: serve the dashboard build from the same origin, with an index.html fallback for SPA routes.
 * Owns the root not-found handler, so register it before any routes.
 */
export default fp(async (app: FastifyInstance) => {
  const root = fileURLToPath(new URL('../../../web/dist', import.meta.url));
  if (!existsSync(root)) {
    app.log.warn({ root }, 'dashboard build not found; serving the API only');
    app.setNotFoundHandler(notFoundHandler);
    return;
  }
  await app.register(fastifyStatic, { root, wildcard: false });
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    const wantsPage =
      request.method === 'GET' &&
      (request.headers.accept ?? '').includes('text/html') &&
      !API_PREFIXES.some((p) => path.startsWith(p));
    if (wantsPage) return reply.sendFile('index.html');
    return notFoundHandler(request, reply);
  });
});
