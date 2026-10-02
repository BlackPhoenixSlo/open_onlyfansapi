import scalar from '@scalar/fastify-api-reference';
import type { FastifyInstance } from 'fastify';
import { JSON_TYPE } from '../proxy/routes.js';

const CACHE_MS = 10 * 60_000;
const FAILURE_CACHE_MS = 60_000;
const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
/** The proxy wildcard route; the upstream's operations document it path by path. */
const PROXY_PATH = '/v1/{account}/{*}';

type Operation = { parameters?: unknown[]; [key: string]: unknown };
type PathItem = Record<string, Operation>;
type Document = {
  paths?: Record<string, PathItem>;
  components?: { schemas?: Record<string, unknown>; [key: string]: unknown };
  [key: string]: unknown;
};

const accountParam = {
  name: 'account',
  in: 'path',
  required: true,
  description: 'Account id, as listed by `GET /v1/accounts`',
  schema: { type: 'integer' },
};

/** The upstream's public operations: `/of/*` paths, tagged `of-api` by the upstream. */
const UPSTREAM_PUBLIC_TAG = 'of-api';
const SCHEMA_REF = /"#\/components\/schemas\/([^"]+)"/g;

type Platform = { paths: Record<string, PathItem>; schemas: Record<string, unknown> };
type Responses = Record<string, { content?: Record<string, { schema?: unknown; [key: string]: unknown }>; [key: string]: unknown }>;

/** The proxy wraps named-route 2xx JSON bodies (plan-v5 §2.2): each such response schema `S` is published as this. */
function wrapped(schema: unknown) {
  return {
    type: 'object',
    required: ['data', '_meta'],
    properties: {
      data: schema,
      _meta: { type: 'object' },
      _pagination: {
        type: 'object',
        required: ['next_page'],
        properties: { next_page: { type: 'string', description: 'Absolute URL of the next page' } },
      },
    },
  };
}

function wrapResponses(responses: Responses): Responses {
  return Object.fromEntries(
    Object.entries(responses).map(([status, response]) => {
      if (!/^2(\d\d|XX)$/.test(status) || status === '204' || !response.content) return [status, response];
      const content = Object.fromEntries(
        Object.entries(response.content).map(([type, media]) => [
          type,
          JSON_TYPE.test(type) && 'schema' in media ? { ...media, schema: wrapped(media.schema) } : media,
        ]),
      );
      return [status, { ...response, content }];
    }),
  );
}

/** The named schemas `root` references, transitively; nothing else from the upstream's components is published. */
function referencedSchemas(root: unknown, all: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const queue = [root];
  while (queue.length > 0) {
    for (const [, name] of JSON.stringify(queue.pop()).matchAll(SCHEMA_REF)) {
      if (name === undefined || name in out || !Object.hasOwn(all, name)) continue;
      out[name] = all[name];
      queue.push(all[name]);
    }
  }
  return out;
}

/**
 * The upstream's public `/of/<rest>` operations as `/v1/{account}/<rest>`: an `account` path parameter, tag `platform`
 * and API key security, plus the component schemas they reference. Other upstream paths, servers and security are dropped.
 * 2xx JSON responses are published wrapped, as the proxy sends them, except for the raw passthrough `/_of/…`.
 */
export function platformSpec(upstream: Document): Platform {
  const paths: Record<string, PathItem> = {};
  for (const [path, item] of Object.entries(upstream.paths ?? {})) {
    if (!path.startsWith('/of/')) continue;
    const passthrough = path.split('/')[2] === '_of';
    const ops: PathItem = {};
    for (const [method, op] of Object.entries(item)) {
      if (!HTTP_METHODS.has(method) || !(op.tags as unknown[] | undefined)?.includes(UPSTREAM_PUBLIC_TAG)) continue;
      const { servers: _servers, ...rest } = op;
      ops[method] = { ...rest, tags: ['platform'], parameters: [accountParam, ...(op.parameters ?? [])], security: [{ ApiKey: [] }] };
      if (!passthrough && op.responses) ops[method].responses = wrapResponses(op.responses as Responses);
    }
    if (Object.keys(ops).length > 0) paths[`/v1/{account}${path.slice('/of'.length)}`] = ops;
  }
  return { paths, schemas: referencedSchemas(paths, upstream.components?.schemas ?? {}) };
}

/** `GET /openapi.json`: the public `/v1` surface (gateway routes + upstream operations) and `GET /docs` (API reference). */
export default async function openapiRoutes(app: FastifyInstance) {
  let cached: { platform: Platform | null; until: number } | null = null;
  let inflight: Promise<Platform | null> | null = null;

  async function fetchPlatform(): Promise<Platform | null> {
    try {
      const res = await app.upstream.openapi();
      if (!res.ok) throw new Error(`upstream answered ${res.status}`);
      cached = { platform: platformSpec(JSON.parse(res.body.toString()) as Document), until: Date.now() + CACHE_MS };
    } catch (err) {
      app.log.warn({ err }, 'upstream OpenAPI spec unavailable');
      // Keep serving the last good spec, and don't refetch on every (unauthenticated) hit while the upstream is down.
      cached = { platform: cached?.platform ?? null, until: Date.now() + FAILURE_CACHE_MS };
    }
    return cached.platform;
  }

  /** The upstream's operations: cached 10 min (1 min after a failure), one fetch at a time; null when never fetched. */
  function upstreamPlatform(): Promise<Platform | null> {
    if (cached && cached.until > Date.now()) return Promise.resolve(cached.platform);
    inflight ??= fetchPlatform().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  app.get('/openapi.json', { schema: { hide: true } }, async (_request, reply) => {
    const own = app.swagger() as Document;
    // Only the public /v1 surface: dashboard (/api) routes take a session, not an API key.
    const gateway = Object.fromEntries(Object.entries(own.paths ?? {}).filter(([p]) => p.startsWith('/v1/') && p !== PROXY_PATH));
    const platform = await upstreamPlatform();
    if (!platform) reply.header('x-upstream-spec', 'unavailable');
    const schemas = { ...platform?.schemas, ...own.components?.schemas };
    return {
      ...own,
      paths: { ...gateway, ...platform?.paths },
      ...(Object.keys(schemas).length > 0 && { components: { ...own.components, schemas } }),
    };
  });

  await app.register(scalar, { routePrefix: '/docs', configuration: { url: '/openapi.json' }, logLevel: 'warn' });
}
