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

/**
 * Stand-in for the backend: verifies the minted HS256 JWT like the real one, echoes `/of/*`,
 * and serves `/of-accounts` per backend user id (`sub`).
 */
export async function startFakeBackend(jwtSecret: string, accountsByUser: Record<number, FakeAccount[]> = {}) {
  const verify = createVerifier({ key: jwtSecret, algorithms: ['HS256'] });
  const requests: Recorded[] = [];
  const app = Fastify();
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  app.addHook('onRequest', async (request, reply) => {
    let jwt: Record<string, unknown>;
    try {
      jwt = verify((request.headers.authorization ?? '').replace(/^Bearer /, ''));
    } catch {
      return reply.status(401).send({ error: 'TOKEN_EXPIRED' });
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
