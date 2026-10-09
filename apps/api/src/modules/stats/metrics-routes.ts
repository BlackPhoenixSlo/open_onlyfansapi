import { Readable } from 'node:stream';
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
import { csvField, toCsv } from '../../cli/analytics-csv.js';
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
  type MetricId,
} from '../analytics/metrics.js';
import { connectedAccounts } from '../accounts/service.js';
import { assertBackfillIdle, backfillRun, startBackfillRun } from '../analytics/backfill-runs.js';
import { NORMALISER_VERSION } from '../analytics/derive.js';
import { freshness } from '../analytics/live.js';
import { MESSAGE_EXPORT_COLUMNS, messageBatches, scopedFans, scopedMessages } from '../analytics/messages.js';
import { scopedScripts } from '../analytics/scripts.js';
import { getStatsConfig, putStatsConfig } from '../analytics/stats-config.js';
import { assignAccount } from '../analytics/workspace.js';
import { assertAccountAllowed, DAY_MS, range, scopedAccounts } from './scope.js';

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
    const fans = await scopedFans({ teamId: actor.teamId, accountIds: scopedAccounts(actor, query.accountId), ...span }, query.limit);
    return { timezone: cfg.timezone, configVersion: cfg.version, asOf: asOf.toISOString(), from: span.fromDay, to: span.toDay, ...fans };
  });

  /** `format=csv` streams every message in the range (no `limit`), queried in keyset batches, as plain UTF-8 with LF. */
  const messagesOrCsv = z.union([statsMessages, z.string()]);
  r.get(
    '/stats/messages',
    { schema: { tags, querystring: statsMessagesQuery, response: { 200: messagesOrCsv } } },
    async (request, reply) => {
      const { actor, query } = request;
      const cfg = await getStatsConfig(actor.teamId);
      const span = range(query, cfg.timezone);
      const asOf = new Date();
      const scope = { teamId: actor.teamId, accountIds: scopedAccounts(actor, query.accountId), ...span, chatId: query.chatId, direction: query.direction };
      if (query.format === 'csv') {
        const name = ['messages', query.chatId, query.direction, span.fromDay, span.toDay].filter((x) => x !== undefined).join('_');
        async function* lines() {
          yield toCsv(MESSAGE_EXPORT_COLUMNS, []);
          for await (const batch of messageBatches(scope)) {
            yield batch.map((m) => snakeCase(m)).map((row) => MESSAGE_EXPORT_COLUMNS.map((c) => csvField(row[c])).join(',') + '\n').join('');
          }
        }
        return reply
          .type('text/csv; charset=utf-8')
          .header('content-disposition', `attachment; filename="${name}.csv"`)
          // A stream skips the serializer; the schema's string stands for the CSV in the OpenAPI document.
          .send(Readable.from(lines()) as unknown as string);
      }
      const page = await scopedMessages(scope, query.limit, query.cursor);
      return { timezone: cfg.timezone, configVersion: cfg.version, asOf: asOf.toISOString(), from: span.fromDay, to: span.toDay, ...page };
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
