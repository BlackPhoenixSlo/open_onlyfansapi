import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  putStatsConfigBody,
  statsBackfillBody,
  statsBackfillQuery,
  statsBackfillRun,
  statsBackfillStarted,
  statsConfigGetResponse,
  statsConfigResponse,
  statsFans,
  statsFansQuery,
  statsMessages,
  statsMessagesQuery,
  statsMetricList,
  statsMetricQuery,
  statsMetricSeries,
  statsSamples,
  statsSamplesQuery,
  statsScripts,
  statsScriptsQuery,
  type StatsConfig,
} from '../../contracts.js';
import { toCsv } from '../../cli/analytics-csv.js';
import { AppError } from '../../lib/errors.js';
import { assertTeamLinked } from '../../lib/team-link.js';
import { assertWriteScope } from '../../plugins/actor.js';
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
import { connectedAccounts } from '../accounts/service.js';
import { assertBackfillIdle, backfillRun, startBackfillRun } from '../analytics/backfill-runs.js';
import { NORMALISER_VERSION } from '../analytics/derive.js';
import { freshness } from '../analytics/live.js';
import { csvSafeText, MESSAGE_EXPORT_COLUMNS, scopedFans, scopedMessages } from '../analytics/messages.js';
import { scopedScripts } from '../analytics/scripts.js';
import { getStatsConfig, putStatsConfig } from '../analytics/stats-config.js';
import { assignAccount } from '../analytics/workspace.js';
import { assertAccountAllowed, DAY_MS, DEFAULT_DAYS, MAX_DAYS, parseDay, scopedAccounts } from './scope.js';

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00.000Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** `value`; 400 for a day that does not exist (e.g. 2026-02-30, 2026-13-01). */
function checkDay(value: string, name: string): string {
  parseDay(value, name);
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

function metricId(id: string): MetricId {
  if (!isMetricId(id)) throw new AppError(404, 'metric_not_found', `No metric ${JSON.stringify(id)}`);
  return id;
}

const snakeCase = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), v]));

const meta = (metric: string, cfg: StatsConfig, asOf: Date) => ({ metric, timezone: cfg.timezone, configVersion: cfg.version, asOf: asOf.toISOString() });

/**
 * `/v1/stats/metrics`, `/v1/stats/scripts`, `/v1/stats/config` (spec §4.6), `/v1/stats/fans`, `/v1/stats/messages` and
 * `/v1/stats/backfill`: reply time, reply SLA, openers, script candidates and the stored messages per fan over the
 * workspace's analytics store, scoped like `GET /v1/stats` and further to the workspace's own rows. Mounted under /v1.
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
        ? openerRows(id, await scopedOpeners(actor.teamId, accounts, id, cfg, { ...span, asOf }), query.groupBy, cfg)
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
        ? openerSamples(id, (await scopedOpeners(actor.teamId, accounts, id, cfg, { ...span, asOf })).filter(inGroup), query.limit)
        : metricSamples(id, (await scopedTurns(actor.teamId, accounts, id, cfg, { ...span, asOf })).filter(inGroup), cfg, query.limit);
      return { ...meta(id, cfg, asOf), items };
    },
  );

  r.get('/stats/scripts', { schema: { tags, querystring: statsScriptsQuery, response: { 200: statsScripts } } }, async (request) => {
    const { actor, query } = request;
    const cfg = await getStatsConfig(actor.teamId);
    const span = range(query, cfg.timezone);
    const asOf = new Date();
    const items = await scopedScripts(actor.teamId, scopedAccounts(actor, query.accountId), cfg, { ...span, asOf });
    return {
      timezone: cfg.timezone,
      configVersion: cfg.version,
      normaliserVersion: NORMALISER_VERSION,
      asOf: asOf.toISOString(),
      from: span.fromDay,
      to: span.toDay,
      items: items.slice(0, query.limit),
    };
  });

  r.get('/stats/fans', { schema: { tags, querystring: statsFansQuery, response: { 200: statsFans } } }, async (request) => {
    const { actor, query } = request;
    const cfg = await getStatsConfig(actor.teamId);
    const span = range(query, cfg.timezone);
    const asOf = new Date();
    const items = await scopedFans({ teamId: actor.teamId, accountIds: scopedAccounts(actor, query.accountId), ...span }, query.limit);
    return { timezone: cfg.timezone, configVersion: cfg.version, asOf: asOf.toISOString(), from: span.fromDay, to: span.toDay, items };
  });

  /** `format=csv` sends every message in the range (no `limit`), UTF-8 with a BOM so Excel reads emoji and accents. */
  const messagesOrCsv = z.union([statsMessages, z.string()]);
  r.get(
    '/stats/messages',
    { schema: { tags, querystring: statsMessagesQuery, response: { 200: messagesOrCsv } } },
    async (request, reply) => {
      const { actor, query } = request;
      const cfg = await getStatsConfig(actor.teamId);
      const span = range(query, cfg.timezone);
      const asOf = new Date();
      const csv = query.format === 'csv';
      const scope = { teamId: actor.teamId, accountIds: scopedAccounts(actor, query.accountId), ...span, chatId: query.chatId, direction: query.direction };
      const items = await scopedMessages(scope, csv ? undefined : query.limit);
      if (csv) {
        const name = ['messages', query.chatId, query.direction, span.fromDay, span.toDay].filter((x) => x !== undefined).join('_');
        return reply
          .type('text/csv; charset=utf-8')
          .header('content-disposition', `attachment; filename="${name}.csv"`)
          .send(`\uFEFF${toCsv(MESSAGE_EXPORT_COLUMNS, items.map((m) => snakeCase({ ...m, text: csvSafeText(m.text) })))}`);
      }
      return { timezone: cfg.timezone, configVersion: cfg.version, asOf: asOf.toISOString(), from: span.fromDay, to: span.toDay, items };
    },
  );

  r.get('/stats/config', { schema: { tags, response: { 200: statsConfigGetResponse } } }, async (request) => {
    const { teamId } = request.actor;
    const [config, fresh] = await Promise.all([getStatsConfig(teamId), freshness(teamId, request.actor.accountIds)]);
    return { config, freshness: fresh };
  });

  r.post(
    '/stats/backfill',
    { schema: { tags, body: statsBackfillBody, response: { 202: statsBackfillStarted } } },
    async (request, reply) => {
      const { actor, body } = request;
      assertAccountAllowed(actor, body.accountId);
      assertBackfillIdle(body.accountId);
      const connected = await connectedAccounts(app.upstream, actor, request.id);
      if (!connected.some((a) => a.id === body.accountId)) throw new AppError(404, 'not_found', `Unknown account ${body.accountId}`);
      await assignAccount(actor.teamId, body.accountId);
      const to = new Date();
      const runId = startBackfillRun({
        upstream: app.upstream,
        teamId: actor.teamId,
        accountId: body.accountId,
        from: new Date(to.getTime() - body.days * DAY_MS),
        to,
      });
      return reply.status(202).send({ runId });
    },
  );

  r.get('/stats/backfill', { schema: { tags, querystring: statsBackfillQuery, response: { 200: statsBackfillRun } } }, async (request) => {
    const { actor, query } = request;
    assertAccountAllowed(actor, query.accountId);
    return backfillRun(actor.teamId, query.accountId);
  });

  r.put('/stats/config', { schema: { tags, body: putStatsConfigBody, response: { 200: statsConfigResponse } } }, async (request) => ({
    config: await putStatsConfig(request.actor.teamId, request.body),
  }));
}
