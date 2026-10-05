import { and, asc, gte, inArray, lt, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { db } from '../../db/index.js';
import { event } from '../../db/schema.js';
import { stats, statsQuery, type Stats } from '../../contracts.js';
import { AppError } from '../../lib/errors.js';
import { assertTeamLinked } from '../../lib/team-link.js';
import { DAY_MS, DEFAULT_DAYS, MAX_DAYS, parseDay, scopedAccounts } from './scope.js';

const day = sql<string>`to_char(${event.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;

/** `GET /v1/stats`: sparse per (UTC day, account, type) counts and amounts from the event ledger. Mounted under /v1. */
export default async function statsRoutes(app: FastifyInstance) {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/stats',
    { schema: { tags: ['gateway'], querystring: statsQuery, response: { 200: stats } } },
    async (request): Promise<Stats> => {
      const { actor, query } = request;
      await assertTeamLinked(actor.teamId);

      const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
      const to = query.to ? parseDay(query.to, 'to') : today;
      const from = query.from ? parseDay(query.from, 'from') : to - (DEFAULT_DAYS - 1) * DAY_MS;
      if (from > to) throw new AppError(400, 'invalid_range', '`from` must not be after `to`');
      if ((to - from) / DAY_MS + 1 > MAX_DAYS) {
        throw new AppError(400, 'range_too_large', `The range can span at most ${MAX_DAYS} days`);
      }

      const ids = scopedAccounts(actor, query.accountId);
      const types = query.types
        ?.split(',')
        .map((t) => t.trim())
        .filter(Boolean);

      const rows = await db
        .select({
          day,
          accountId: event.accountId,
          type: event.type,
          count: sql<number>`count(*)::int`,
          amountCents: sql<string>`coalesce(sum(${event.amountCents}), 0)::bigint`,
        })
        .from(event)
        .where(
          and(
            gte(event.createdAt, new Date(from)),
            lt(event.createdAt, new Date(to + DAY_MS)),
            ids ? inArray(event.accountId, ids) : undefined,
            types?.length ? inArray(event.type, types) : undefined,
          ),
        )
        .groupBy(day, event.accountId, event.type)
        .orderBy(asc(day), asc(event.accountId), asc(event.type));

      // bigint arrives as a string; sums stay well inside Number.MAX_SAFE_INTEGER.
      return { rows: rows.map((r) => ({ ...r, amountCents: Number(r.amountCents) })) };
    },
  );
}
