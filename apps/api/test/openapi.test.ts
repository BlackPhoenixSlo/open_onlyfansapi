import { createServer } from 'node:net';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/index.js';
import { startFakeUpstream } from './fake-upstream.js';

const upstream = await startFakeUpstream(process.env.UPSTREAM_TOKEN!);
const app = await buildApp({ logger: false, upstreamUrl: upstream.url });

afterAll(async () => {
  await app.close();
  await upstream.close();
  await pool.end();
});

const specHits = () => upstream.requests.filter((r) => r.url === '/docs/json').length;

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

type Param = { name: string; in: string; required?: boolean; schema?: unknown };
const STATS_PATHS = ['/v1/stats', '/v1/stats/config', '/v1/stats/metrics', '/v1/stats/metrics/{id}', '/v1/stats/metrics/{id}/samples'];
const WEBHOOK_PATHS = [
  '/v1/webhooks',
  '/v1/webhooks/events',
  '/v1/webhooks/{id}',
  '/v1/webhooks/{id}/deliveries',
  '/v1/webhooks/{id}/deliveries/{deliveryId}/redeliver',
  '/v1/webhooks/{id}/test',
];

describe('openapi', () => {
  it('merges the upstream /of operations under /v1/{account} with the gateway /v1 routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-upstream-spec']).toBeUndefined();
    const spec = res.json();

    // `/of-accounts` (not under `/of/`), dashboard routes and the proxy wildcard are not published.
    expect(Object.keys(spec.paths).sort()).toEqual([
      '/v1/accounts',
      ...STATS_PATHS,
      ...WEBHOOK_PATHS,
      '/v1/whoami',
      '/v1/{account}/_of/{path}',
      '/v1/{account}/chats/{chatId}/messages',
      '/v1/{account}/me',
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
    expect(JSON.stringify(spec)).not.toMatch(/of-api|bearerAuth|internal/);
  });

  it('publishes named-route 2xx JSON schemas wrapped, the passthrough unwrapped, and only the referenced schemas', async () => {
    const spec = (await app.inject({ method: 'GET', url: '/openapi.json' })).json();
    expect(spec.paths['/v1/{account}/me'].get.responses[200].content['application/json'].schema).toEqual({
      type: 'object',
      required: ['data', '_meta'],
      properties: {
        data: { $ref: '#/components/schemas/User' },
        _meta: { type: 'object' },
        _pagination: {
          type: 'object',
          required: ['next_page'],
          properties: { next_page: { type: 'string', description: 'Absolute URL of the next page' } },
        },
      },
    });
    expect(spec.paths['/v1/{account}/_of/{path}'].get.responses[200].content['application/json'].schema).toEqual({});
    // A response without content stays as it is.
    expect(spec.paths['/v1/{account}/users/{userId}/posts'].get.responses).toEqual({ 200: { description: 'Default Response' } });
    expect(Object.keys(spec.components.schemas).sort()).toEqual(['Media', 'User']);
  });

  it('fetches the spec once for concurrent requests and caches a failure for a minute, keeping the last good spec', async () => {
    const fresh = await buildApp({ logger: false, upstreamUrl: upstream.url });
    try {
      const before = specHits();
      const get = () => fresh.inject({ method: 'GET', url: '/openapi.json' });
      await Promise.all([get(), get(), get()]);
      expect(specHits() - before).toBe(1);

      upstream.state.specFails = true;
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
      const stale = await get();
      expect(specHits() - before).toBe(2);
      expect(stale.headers['x-upstream-spec']).toBeUndefined();
      expect(Object.keys(stale.json().paths)).toContain('/v1/{account}/me');
      await get();
      expect(specHits() - before).toBe(2);

      vi.setSystemTime(Date.now() + 60_000 + 1);
      await get();
      expect(specHits() - before).toBe(3);
    } finally {
      upstream.state.specFails = false;
      vi.useRealTimers();
      await fresh.close();
    }
  });

  it('an upstream that was never reachable is retried after a minute, not on every hit', async () => {
    const fresh = await buildApp({ logger: false, upstreamUrl: upstream.url });
    upstream.state.specFails = true;
    try {
      const before = specHits();
      expect((await fresh.inject({ method: 'GET', url: '/openapi.json' })).headers['x-upstream-spec']).toBe('unavailable');
      expect((await fresh.inject({ method: 'GET', url: '/openapi.json' })).headers['x-upstream-spec']).toBe('unavailable');
      expect(specHits() - before).toBe(1);
    } finally {
      upstream.state.specFails = false;
      await fresh.close();
    }
  });

  it('caches the upstream spec for 10 minutes', async () => {
    const fresh = await buildApp({ logger: false, upstreamUrl: upstream.url });
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

  it('serves the gateway-only spec with x-upstream-spec: unavailable when the upstream is down', async () => {
    const down = await buildApp({ logger: false, upstreamUrl: `http://127.0.0.1:${await freePort()}` });
    try {
      const res = await down.inject({ method: 'GET', url: '/openapi.json' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-upstream-spec']).toBe('unavailable');
      expect(Object.keys(res.json().paths).sort()).toEqual(['/v1/accounts', ...STATS_PATHS, ...WEBHOOK_PATHS, '/v1/whoami']);
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
