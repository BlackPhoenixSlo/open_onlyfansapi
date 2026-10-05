import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  putStatsConfigBody,
  statsConfigResponse,
  statsMetricList,
  statsMetricQuery,
  statsMetricSeries,
  statsSamples,
  statsSamplesQuery,
  type StatsConfig,
} from '../../contracts.js';
import { toCsv } from '../../cli/analytics-csv.js';
import { AppError } from '../../lib/errors.js';
import { assertTeamLinked } from '../../lib/team-link.js';
import { assertWriteScope, type Actor } from '../../plugins/actor.js';
import {
  groupKey,
  isMetricId,
  isOpenerMetric,
  METRIC_CSV_COLUMNS,
  METRICS,
  metricRows,
  metricSamples,
  OPENER_CSV_COLUMNS,
  openerRows,
  openerSamples,
  scopedOpeners,
  scopedTurns,
  zonedMidnight,
  zonedToday,
  type MetricId,
} from '../analytics/metrics.js';
import { getStatsConfig, putStatsConfig } from '../analytics/stats-config.js';

const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 30;
const MAX_DAYS = 366;

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00.000Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** 400 for a day that does not exist (e.g. 2026-02-30). */
function checkDay(value: string, name: string): string {
  if (addDays(value, 0) !== value) throw new AppError(400, 'validation_error', `\`${name}\` is not a valid YYYY-MM-DD day`);
  return value;
}

/** `from`/`to` days in the config timezone (`to` inclusive), as the instants `[from, to)`. */
function range(query: { from?: string; to?: string }, tz: string) {
  const to = query.to ? checkDay(query.to, 'to') : zonedToday(tz);
  const from = query.from ? checkDay(query.from, 'from') : addDays(to, -(DEFAULT_DAYS - 1));
  if (from > to) throw new AppError(400, 'invalid_range', '`from` must not be after `to`');
  if (addDays(from, MAX_DAYS - 1) < to) throw new AppError(400, 'range_too_large', `The range can span at most ${MAX_DAYS} days`);
  return { fromDay: from, toDay: to, from: zonedMidnight(from, tz), to: zonedMidnight(addDays(to, 1), tz) };
}

/** As `GET /v1/stats`: the key's allowlist, narrowed by `accountId`; null = every account of the workspace. */
function scopedAccounts(actor: Actor, accountId: number | undefined): number[] | null {
  const allowed = actor.accountIds;
  if (accountId !== undefined && allowed && !allowed.includes(accountId)) {
    throw new AppError(403, 'account_not_allowed', `This API key cannot use account ${accountId}`);
  }
  return accountId !== undefined ? [accountId] : allowed;
}

function metricId(id: string): MetricId {
  if (!isMetricId(id)) throw new AppError(404, 'metric_not_found', `No metric ${JSON.stringify(id)}`);
  return id;
}

const snakeCase = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), v]));

const meta = (metric: string, cfg: StatsConfig, asOf: Date) => ({ metric, timezone: cfg.timezone, configVersion: cfg.version, asOf: asOf.toISOString() });

/**
 * `/v1/stats/metrics` and `/v1/stats/config` (spec §4.6): reply time, reply SLA and openers over the workspace's analytics
 * store, scoped like `GET /v1/stats` and further to the workspace's own rows. Mounted under /v1.
 */
export default async function statsMetricsRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook('preHandler', async (request) => {
    await assertTeamLinked(request.actor.teamId);
    assertWriteScope(request.actor, request.method);
  });
  const tags = ['gateway'];
  const params = z.object({ id: z.string() });
  /** `format=csv` sends the rows as `text/csv` (snake_case columns); the serializer never sees that string. */
  const seriesOrCsv = z.union([statsMetricSeries, z.string()]);

  r.get('/stats/metrics', { schema: { tags, response: { 200: statsMetricList } } }, async () => ({ items: METRICS }));

  r.get(
    '/stats/metrics/:id',
    { schema: { tags, params, querystring: statsMetricQuery, response: { 200: seriesOrCsv } } },
    async (request, reply) => {
      const { actor, query } = request;
      const id = metricId(request.params.id);
      const cfg = await getStatsConfig(actor.teamId);
      const span = range(query, cfg.timezone);
      const accounts = scopedAccounts(actor, query.accountId);
      const asOf = new Date();
      const rows = isOpenerMetric(id)
        ? openerRows(id, await scopedOpeners(actor.teamId, accounts, cfg, { ...span, asOf }), query.groupBy, cfg)
        : metricRows(id, await scopedTurns(actor.teamId, accounts, id, cfg, { ...span, asOf }), query.groupBy, cfg);
      if (query.format === 'csv') {
        const csv = toCsv(isOpenerMetric(id) ? OPENER_CSV_COLUMNS : METRIC_CSV_COLUMNS, rows.map(snakeCase));
        return reply
          .type('text/csv; charset=utf-8')
          .header('content-disposition', `attachment; filename="${id}_${span.fromDay}_${span.toDay}.csv"`)
          .send(csv);
      }
      return { ...meta(id, cfg, asOf), groupBy: query.groupBy, from: span.fromDay, to: span.toDay, rows };
    },
  );

  r.get(
    '/stats/metrics/:id/samples',
    { schema: { tags, params, querystring: statsSamplesQuery, response: { 200: statsSamples } } },
    async (request) => {
      const { actor, query } = request;
      const id = metricId(request.params.id);
      const cfg = await getStatsConfig(actor.teamId);
      const span = range(query, cfg.timezone);
      const accounts = scopedAccounts(actor, query.accountId);
      const asOf = new Date();
      const inGroup = (x: Parameters<typeof groupKey>[0]) => query.group === undefined || groupKey(x, query.groupBy, cfg.timezone) === query.group;
      const items = isOpenerMetric(id)
        ? openerSamples(id, (await scopedOpeners(actor.teamId, accounts, cfg, { ...span, asOf })).filter(inGroup), query.limit)
        : metricSamples(id, (await scopedTurns(actor.teamId, accounts, id, cfg, { ...span, asOf })).filter(inGroup), cfg, query.limit);
      return { ...meta(id, cfg, asOf), items };
    },
  );

  r.get('/stats/config', { schema: { tags, response: { 200: statsConfigResponse } } }, async (request) => ({
    config: await getStatsConfig(request.actor.teamId),
  }));

  r.put('/stats/config', { schema: { tags, body: putStatsConfigBody, response: { 200: statsConfigResponse } } }, async (request) => ({
    config: await putStatsConfig(request.actor.teamId, request.body),
  }));
}
