import { createServer } from 'node:net';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/index.js';
import { startFakeBackend } from './fake-backend.js';

const backend = await startFakeBackend(process.env.BACKEND_JWT_SECRET!);
const app = await buildApp({ logger: false, backendUrl: backend.url });

afterAll(async () => {
  await app.close();
  await backend.close();
  await pool.end();
});

const specHits = () => backend.requests.filter((r) => r.url === '/docs/json').length;

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

type Param = { name: string; in: string; required?: boolean; schema?: unknown };

describe('openapi', () => {
  it('merges the backend /of operations under /v1/{account} with the gateway /v1 routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-backend-spec']).toBeUndefined();
    const spec = res.json();

    // `/of-accounts` (not under `/of/`), dashboard routes and the proxy wildcard are not published.
    expect(Object.keys(spec.paths).sort()).toEqual([
      '/v1/accounts',
      '/v1/whoami',
      '/v1/{account}/chats/{chatId}/messages',
      '/v1/{account}/users/me',
      '/v1/{account}/users/{userId}/posts',
    ]);

    const posts = spec.paths['/v1/{account}/users/{userId}/posts'].get;
    expect(posts.tags).toEqual(['platform']);
    expect(posts.operationId).toBe('users.posts.list');
    expect(posts.security).toEqual([{ ApiKey: [] }]);
    expect(posts.parameters[0]).toMatchObject({ name: 'account', in: 'path', required: true, schema: { type: 'integer' } });
    expect(posts.parameters.map((p: Param) => `${p.in}:${p.name}`)).toEqual(['path:account', 'path:userId', 'query:limit', 'query:order']);

    const send = spec.paths['/v1/{account}/chats/{chatId}/messages'].post;
    expect(send.security).toEqual([{ ApiKey: [] }]);
    expect(send.requestBody.content['application/json'].schema).toMatchObject({ required: ['text'], example: { text: 'Hello there', price: 0 } });

    expect(spec.servers).toBeUndefined();
    expect(Object.keys(spec.components.securitySchemes)).toEqual(['ApiKey']);
    expect(spec.components.securitySchemes.ApiKey).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(JSON.stringify(spec)).not.toMatch(/of-api|bearerAuth/);
  });

  it('caches the backend spec for 10 minutes', async () => {
    const fresh = await buildApp({ logger: false, backendUrl: backend.url });
    try {
      const before = specHits();
      await fresh.inject({ method: 'GET', url: '/openapi.json' });
      await fresh.inject({ method: 'GET', url: '/openapi.json' });
      expect(specHits() - before).toBe(1);

      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
      await fresh.inject({ method: 'GET', url: '/openapi.json' });
      expect(specHits() - before).toBe(2);
    } finally {
      vi.useRealTimers();
      await fresh.close();
    }
  });

  it('serves the gateway-only spec with x-backend-spec: unavailable when the backend is down', async () => {
    const down = await buildApp({ logger: false, backendUrl: `http://127.0.0.1:${await freePort()}` });
    try {
      const res = await down.inject({ method: 'GET', url: '/openapi.json' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-backend-spec']).toBe('unavailable');
      expect(Object.keys(res.json().paths).sort()).toEqual(['/v1/accounts', '/v1/whoami']);
    } finally {
      await down.close();
    }
  });

  it('serves the API reference at /docs/', async () => {
    // The reference loads its script relatively, so /docs redirects to /docs/.
    const bare = await app.inject({ method: 'GET', url: '/docs' });
    expect(bare.statusCode).toBe(301);
    expect(bare.headers.location).toBe('/docs/');
    const res = await app.inject({ method: 'GET', url: '/docs/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('/openapi.json');
  });
});
