import { and, asc, desc, eq, gt, gte, isNull, lt, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { apiKey, requestLog, webhookEndpoint } from '../../db/schema.js';
import { overview, usage, usageGroupBy, type Usage } from '../../contracts.js';
import { AppError } from '../../lib/errors.js';

const DAY_MS = 86_400_000;
const MAX_RANGE_DAYS = 31;

const usageQuery = z.object({
  /** default: `to` minus 7 days */
  from: z.iso.datetime({ offset: true }).optional(),
  /** default: now */
  to: z.iso.datetime({ offset: true }).optional(),
  groupBy: usageGroupBy.default('day'),
});

const requests = sql<number>`count(*)::int`;
const errors = sql<number>`(count(*) filter (where ${requestLog.statusCode} >= 400))::int`;
const day = sql<string>`to_char(${requestLog.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;

/** Group key and display label per `groupBy` ('' = dashboard / no account). */
const GROUPS = {
  day: { key: day, label: day },
  key: { key: sql<string>`coalesce(${requestLog.apiKeyId}, '')`, label: sql<string>`coalesce(${apiKey.name}, 'Dashboard')` },
  account: {
    key: sql<string>`coalesce(${requestLog.accountId}::text, '')`,
    label: sql<string>`coalesce('#' || ${requestLog.accountId}, 'No account')`,
  },
  endpoint: { key: requestLog.endpoint, label: requestLog.endpoint },
};

/** Dashboard usage and Home KPIs, aggregated straight from `request_log` (session cookie). Mounted at /api. */
export default async function usageRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook('preHandler', app.requireSession);
  const tags = ['dashboard'];

  r.get('/usage', { schema: { tags, querystring: usageQuery, response: { 200: usage } } }, async (request): Promise<Usage> => {
    const to = request.query.to ? new Date(request.query.to) : new Date();
    const from = request.query.from ? new Date(request.query.from) : new Date(to.getTime() - 7 * DAY_MS);
    if (from >= to) throw new AppError(400, 'invalid_range', '`from` must be before `to`');
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
      throw new AppError(400, 'range_too_large', `The range can span at most ${MAX_RANGE_DAYS} days`);
    }
    const inRange = and(
      eq(requestLog.teamId, request.session.teamId),
      gte(requestLog.createdAt, from),
      lt(requestLog.createdAt, to),
    );
    const group = GROUPS[request.query.groupBy];

    const [byDay, grouped] = await Promise.all([
      db.select({ day, requests, errors }).from(requestLog).where(inRange).groupBy(day),
      db
        .select({
          key: group.key,
          label: group.label,
          requests,
          errors,
          avgMs: sql<number>`coalesce(round(avg(${requestLog.durationMs})), 0)::int`,
          bytes: sql<number>`coalesce(sum(${requestLog.respBytes}), 0)::float8`,
        })
        .from(requestLog)
        .leftJoin(apiKey, eq(apiKey.id, requestLog.apiKeyId))
        .where(inRange)
        .groupBy(group.key, group.label)
        .orderBy(request.query.groupBy === 'day' ? asc(group.key) : desc(requests)),
    ]);

    const counts = new Map(byDay.map((d) => [d.day, d]));
    const series: Usage['series'] = [];
    const firstDay = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
    for (let t = firstDay; t < to.getTime(); t += DAY_MS) {
      const d = new Date(t).toISOString().slice(0, 10);
      series.push({ day: d, requests: counts.get(d)?.requests ?? 0, errors: counts.get(d)?.errors ?? 0 });
    }
    const total = grouped.reduce((sum, row) => sum + row.requests, 0);
    return { series, rows: grouped.map((row) => ({ ...row, share: total ? row.requests / total : 0 })) };
  });

  r.get('/overview', { schema: { tags, response: { 200: overview } } }, async (request) => {
    const { teamId } = request.session;
    const last24h = sql`${requestLog.createdAt} >= now() - interval '24 hours'`;
    const [[stats], [keys], webhooks] = await Promise.all([
      db
        .select({
          requests24h: sql<number>`(count(*) filter (where ${last24h}))::int`,
          errors24h: sql<number>`(count(*) filter (where ${last24h} and ${requestLog.statusCode} >= 400))::int`,
          requests7d: requests,
        })
        .from(requestLog)
        .where(and(eq(requestLog.teamId, teamId), sql`${requestLog.createdAt} >= now() - interval '7 days'`)),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(apiKey)
        .where(and(eq(apiKey.teamId, teamId), isNull(apiKey.revokedAt))),
      db
        .select({ id: webhookEndpoint.id, url: webhookEndpoint.url, enabled: webhookEndpoint.enabled })
        .from(webhookEndpoint)
        .where(
          and(
            eq(webhookEndpoint.teamId, teamId),
            or(eq(webhookEndpoint.enabled, false), gt(webhookEndpoint.consecutiveFailures, 0)),
          ),
        )
        .orderBy(desc(webhookEndpoint.createdAt)),
    ]);
    return {
      requests24h: stats!.requests24h,
      requests7d: stats!.requests7d,
      errorRate24h: stats!.requests24h ? stats!.errors24h / stats!.requests24h : 0,
      activeKeys: keys!.count,
      pausedWebhooks: webhooks.filter((w) => !w.enabled).length,
      needsAttention: webhooks.map((w) => ({
        kind: 'webhook' as const,
        id: w.id,
        url: w.url,
        reason: w.enabled ? ('failing' as const) : ('paused' as const),
      })),
    };
  });
}
