import scalar from '@scalar/fastify-api-reference';
import type { FastifyInstance } from 'fastify';

const CACHE_MS = 10 * 60_000;
const SPEC_TIMEOUT_MS = 5_000;
const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
/** The proxy wildcard route; the backend's operations document it path by path. */
const PROXY_PATH = '/v1/{account}/{*}';

type Operation = { parameters?: unknown[]; [key: string]: unknown };
type PathItem = Record<string, Operation>;
type Document = { paths?: Record<string, PathItem>; [key: string]: unknown };

const accountParam = {
  name: 'account',
  in: 'path',
  required: true,
  description: 'Account id, as listed by `GET /v1/accounts`',
  schema: { type: 'integer' },
};

/**
 * The backend's `/of/<rest>` operations as `/v1/{account}/<rest>`: an `account` path parameter, tag `platform`
 * and API key security. Parameter and body schemas are kept; other backend paths, servers and security are dropped.
 */
export function platformPaths(backend: Document): Record<string, PathItem> {
  const out: Record<string, PathItem> = {};
  for (const [path, item] of Object.entries(backend.paths ?? {})) {
    if (!path.startsWith('/of/')) continue;
    const ops: PathItem = {};
    for (const [method, op] of Object.entries(item)) {
      if (!HTTP_METHODS.has(method)) continue;
      const { servers: _servers, ...rest } = op;
      ops[method] = { ...rest, tags: ['platform'], parameters: [accountParam, ...(op.parameters ?? [])], security: [{ ApiKey: [] }] };
    }
    out[`/v1/{account}${path.slice('/of'.length)}`] = ops;
  }
  return out;
}

/** `GET /openapi.json`: the public `/v1` surface (gateway routes + backend operations) and `GET /docs` (API reference). */
export default async function openapiRoutes(app: FastifyInstance) {
  let cached: { paths: Record<string, PathItem>; until: number } | null = null;

  /** The backend's operations, cached for 10 min; null (not cached) when the backend's spec can't be fetched. */
  async function backendPaths(): Promise<Record<string, PathItem> | null> {
    if (cached && cached.until > Date.now()) return cached.paths;
    try {
      const res = await fetch(new URL('/docs/json', app.backend.origin), {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(SPEC_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`backend answered ${res.status}`);
      const paths = platformPaths((await res.json()) as Document);
      cached = { paths, until: Date.now() + CACHE_MS };
      return paths;
    } catch (err) {
      app.log.warn({ err }, 'backend OpenAPI spec unavailable');
      return null;
    }
  }

  app.get('/openapi.json', { schema: { hide: true } }, async (_request, reply) => {
    const own = app.swagger() as Document;
    // Only the public /v1 surface: dashboard (/api) routes take a session, not an API key.
    const gateway = Object.fromEntries(Object.entries(own.paths ?? {}).filter(([p]) => p.startsWith('/v1/') && p !== PROXY_PATH));
    const platform = await backendPaths();
    if (!platform) reply.header('x-backend-spec', 'unavailable');
    return { ...own, paths: { ...gateway, ...platform } };
  });

  await app.register(scalar, { routePrefix: '/docs', configuration: { url: '/openapi.json' }, logLevel: 'warn' });
}
