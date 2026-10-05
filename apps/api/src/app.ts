import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { env } from './env.js';
import { registerJobs } from './jobs/index.js';
import { createUpstream, type Upstream } from './lib/upstream.js';
import { AppError, errorHandler, notFoundHandler } from './lib/errors.js';
import { newId } from './lib/ids.js';
import accountsConnectRoutes from './modules/accounts/connect.js';
import accountsRoutes from './modules/accounts/routes.js';
import keysRoutes from './modules/keys/routes.js';
import { captureRequestLogs } from './modules/logs/capture.js';
import logsRoutes from './modules/logs/routes.js';
import openapiRoutes from './modules/openapi/routes.js';
import proxyRoutes from './modules/proxy/routes.js';
import realtimeRoutes from './modules/realtime/routes.js';
import statsRoutes from './modules/stats/routes.js';
import usageRoutes from './modules/usage/routes.js';
import webhooksRoutes from './modules/webhooks/routes.js';
import webhookStreamRoutes, { type StreamOptions } from './modules/webhooks/stream.js';
import whoamiRoutes from './modules/whoami/routes.js';
import { authenticate } from './plugins/actor.js';
import sessionPlugin from './plugins/session.js';
import webStatic from './plugins/web-static.js';

declare module 'fastify' {
  interface FastifyInstance {
    upstream: Upstream;
  }
}

export type AppOptions = { upstreamUrl?: string; logger?: boolean; stream?: StreamOptions };

export async function buildApp(opts: AppOptions = {}) {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: env.LOG_LEVEL },
    genReqId: () => newId('req'),
    requestIdHeader: false,
    trustProxy: env.TRUST_PROXY,
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  if (env.NODE_ENV === 'production') await app.register(webStatic);
  else app.setNotFoundHandler(notFoundHandler);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });
  app.decorate(
    'upstream',
    createUpstream({ url: opts.upstreamUrl ?? env.UPSTREAM_URL, token: env.UPSTREAM_TOKEN, timeoutMs: env.UPSTREAM_TIMEOUT_MS }),
  );

  await app.register(swagger, {
    openapi: {
      info: { title: 'Gateway API', version: '2.1.0' },
      components: { securitySchemes: { ApiKey: { type: 'http', scheme: 'bearer', description: 'An API key (`gk_…`)' } } },
      security: [{ ApiKey: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(sessionPlugin);
  // Client messages are ignored, so a small cap. Select `bearer` only when offered: the key travels as `bearer.<key>`.
  await app.register(websocket, {
    options: { maxPayload: 4096, clientTracking: false, handleProtocols: (p) => (p.has('bearer') ? 'bearer' : false) },
  });

  app.get('/healthz', async () => ({ ok: true }));
  await app.register(openapiRoutes);

  await app.register(keysRoutes, { prefix: '/api/keys' });
  await app.register(logsRoutes, { prefix: '/api/logs' });
  await app.register(accountsConnectRoutes, { prefix: '/api/accounts' });
  await app.register(usageRoutes, { prefix: '/api' });
  await app.register(webhookStreamRoutes, { ...opts.stream, prefix: '/api' });

  await app.register(
    async (v1) => {
      v1.addHook('onRequest', authenticate);
      captureRequestLogs(v1);
      await v1.register(rateLimit, {
        hook: 'preHandler',
        max: env.KEY_RATE_LIMIT_PER_MIN,
        timeWindow: 60_000,
        keyGenerator: (req) => req.actor.keyId ?? `user:${req.actor.userId}`,
        // Only on 429s, so the upstream's x-ratelimit-* headers on proxied responses stay unambiguous.
        addHeadersOnExceeding: { 'x-ratelimit-limit': false, 'x-ratelimit-remaining': false, 'x-ratelimit-reset': false },
        errorResponseBuilder: (_req, ctx) =>
          new AppError(429, 'rate_limited', `Rate limit of ${ctx.max} requests per minute exceeded; retry in ${ctx.after}`),
      });
      await v1.register(whoamiRoutes);
      await v1.register(accountsRoutes);
      await v1.register(webhooksRoutes);
      await v1.register(realtimeRoutes);
      await v1.register(statsRoutes);
      await v1.register(proxyRoutes);
    },
    { prefix: '/v1' },
  );

  if (env.RUN_JOBS) registerJobs(app);
  return app;
}
