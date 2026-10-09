import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { proxyList, type ProxyInfo } from '../../contracts.js';
import { AppError } from '../../lib/errors.js';
import { assertTeamLinked } from '../../lib/team-link.js';
import type { UpstreamResponse } from '../../lib/upstream.js';

type UpstreamProxy = {
  label: string;
  scheme?: string | null;
  host?: string | null;
  port?: number | null;
  assigned_account_ids?: (string | number)[] | null;
  verified_ip?: string | null;
  verified_at?: string | null;
  verified_geo?: string | null;
  stats?: {
    ok?: number;
    failed?: number;
    blocked?: number;
    last_ok_at?: string | null;
    last_error?: string | null;
    last_error_at?: string | null;
    last_used_at?: string | null;
  };
  since?: string | null;
};

/** Whitelists the upstream entry: its username (and anything else it adds) never leaves the gateway. */
function toProxy(p: UpstreamProxy): ProxyInfo {
  const s = p.stats ?? {};
  return {
    label: p.label,
    scheme: p.scheme ?? 'http',
    host: p.host ?? null,
    port: p.port ?? null,
    assignedAccountIds: (p.assigned_account_ids ?? []).map(Number).filter(Number.isInteger),
    verifiedIp: p.verified_ip ?? null,
    verifiedAt: p.verified_at ?? null,
    verifiedGeo: p.verified_geo ?? null,
    stats: {
      ok: s.ok ?? 0,
      failed: s.failed ?? 0,
      blocked: s.blocked ?? 0,
      lastOkAt: s.last_ok_at ?? null,
      lastError: s.last_error ?? null,
      lastErrorAt: s.last_error_at ?? null,
      lastUsedAt: s.last_used_at ?? null,
    },
    since: p.since ?? '',
  };
}

function parse<T>(res: UpstreamResponse, what: string): T {
  try {
    return JSON.parse(res.body.toString()) as T;
  } catch {
    throw new AppError(502, 'upstream_error', `The upstream answered an unreadable ${what}`);
  }
}

/**
 * Dashboard-only proxy registry (session cookie + CSRF), mounted at /api: the upstream's proxies with their bound
 * accounts and traffic stats, and an egress probe. Upstream errors are passed through with their status.
 */
export default async function proxiesRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook('preHandler', app.requireSession);

  r.get('/proxies', { schema: { tags: ['dashboard'], response: { 200: proxyList } } }, async (request) => {
    await assertTeamLinked(request.session.teamId);
    const res = await app.upstream.listProxies(request.id);
    if (!res.ok) throw new AppError(502, 'upstream_error', `The upstream answered ${res.status} for the proxy list`);
    const rows = parse<unknown>(res, 'proxy list');
    if (!Array.isArray(rows)) throw new AppError(502, 'upstream_error', 'The upstream answered an unreadable proxy list');
    return { items: (rows as UpstreamProxy[]).map(toProxy) };
  });

  r.post(
    '/proxies/:label/probe',
    {
      schema: {
        tags: ['dashboard'],
        // One path segment (encoded by the upstream client): no `/`, and no leading `.`, so never `.` or `..`.
        params: z.object({ label: z.string().min(1).max(200).regex(/^[^/.][^/]*$/) }),
      },
    },
    async (request, reply) => {
      await assertTeamLinked(request.session.teamId);
      const res = await app.upstream.probeProxy(request.params.label, request.id);
      if (!res.ok) {
        return reply
          .status(res.status)
          .header('content-type', res.headers.get('content-type') ?? 'application/json')
          .send(res.body);
      }
      return reply.send({ proxy: toProxy(parse<UpstreamProxy>(res, 'proxy')) });
    },
  );
}
