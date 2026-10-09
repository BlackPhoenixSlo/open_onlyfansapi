import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { statsRevenue, statsRevenueQuery } from '../../contracts.js';
import { assertTeamLinked } from '../../lib/team-link.js';
import { scopedRevenue } from '../analytics/revenue.js';
import { getStatsConfig } from '../analytics/stats-config.js';
import { range, scopedAccounts } from './scope.js';

/**
 * `GET /v1/stats/revenue`: gross and net by kind and day, payers, the golden ratio, PPV unlocks and the top payers from
 * the workspace's stored transactions and messages, scoped like `/v1/stats/fans`. Mounted under /v1.
 */
export default async function statsRevenueRoutes(app: FastifyInstance) {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/stats/revenue',
    { schema: { tags: ['gateway'], querystring: statsRevenueQuery, response: { 200: statsRevenue } } },
    async (request) => {
      const { actor, query } = request;
      await assertTeamLinked(actor.teamId);
      const cfg = await getStatsConfig(actor.teamId);
      const span = range(query, cfg.timezone);
      const asOf = new Date();
      const revenue = await scopedRevenue({ teamId: actor.teamId, accountIds: scopedAccounts(actor, query.accountId), ...span }, cfg.timezone);
      return { timezone: cfg.timezone, configVersion: cfg.version, asOf: asOf.toISOString(), from: span.fromDay, to: span.toDay, ...revenue };
    },
  );
}
