import Fastify from 'fastify';
import { createVerifier } from 'fast-jwt';

export type Recorded = {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string | null;
  jwt: Record<string, unknown>;
};

type FakeAccount = Record<string, unknown> & { id: number };

const ok = { 200: { description: 'Default Response' } };
const of = (operationId: string, extra: Record<string, unknown> = {}) => ({ tags: ['of-api'], operationId, responses: ok, ...extra });
const pathParam = (name: string) => ({ schema: { type: 'integer' }, in: 'path', name, required: true });
const queryParam = (name: string, schema: Record<string, unknown>) => ({ schema, in: 'query', name, required: false });

/** Shaped like `@fastify/swagger` output from the backend: `/of/*` operations plus paths the gateway must not publish. */
export const BACKEND_SPEC = {
  openapi: '3.0.3',
  info: { title: 'Backend API', version: '1.0.0' },
  servers: [{ url: 'http://localhost:3001' }],
  components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } }, schemas: {} },
  paths: {
    '/of/users/me': { get: of('users.me') },
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
    '/of-accounts': { get: { tags: ['of-accounts'], operationId: 'ofAccounts.list', responses: ok } },
  },
};

/**
 * Stand-in for the backend: verifies the minted HS256 JWT like the real one, echoes `/of/*`,
 * serves `/of-accounts` per backend user id (`sub`) and a small OpenAPI spec at `/docs/json` (public, like the real one).
 */
export async function startFakeBackend(jwtSecret: string, accountsByUser: Record<number, FakeAccount[]> = {}) {
  const verify = createVerifier({ key: jwtSecret, algorithms: ['HS256'] });
  const requests: Recorded[] = [];
  const app = Fastify();
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  app.addHook('onRequest', async (request, reply) => {
    let jwt: Record<string, unknown> = {};
    // The backend's spec is public.
    if (request.url !== '/docs/json') {
      try {
        jwt = verify((request.headers.authorization ?? '').replace(/^Bearer /, ''));
      } catch {
        return reply.status(401).send({ error: 'TOKEN_EXPIRED' });
      }
    }
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: null,
      jwt,
    });
  });
  app.addHook('preHandler', async (request) => {
    requests.at(-1)!.body = typeof request.body === 'string' ? request.body : null;
  });

  app.get('/docs/json', async () => BACKEND_SPEC);
  app.get('/of-accounts', async (request) => {
    const sub = requests.at(-1)!.jwt.sub as number;
    return accountsByUser[sub] ?? [];
  });
  app.all('/of/*', async (request, reply) => {
    reply.header('x-of-cache', 'MISS').header('x-ratelimit-limit', '300').header('x-ratelimit-remaining', '299');
    if (request.url.startsWith('/of/rate-limited')) return reply.status(429).header('retry-after', '42').send({ error: 'RATE_LIMITED' });
    return { echo: true, method: request.method, url: request.url };
  });

  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  return { url: address, requests, close: () => app.close() };
}
