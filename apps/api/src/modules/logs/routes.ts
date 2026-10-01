import { and, desc, eq, gte, ilike, lt, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { apiKey, requestLog } from '../../db/schema.js';
import { logDetail, logList, logStatus, type LogDetail, type LogSummary } from '../../contracts.js';
import { AppError } from '../../lib/errors.js';

const listQuery = z.object({
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  status: logStatus.optional(),
  keyId: z.string().optional(),
  accountId: z.coerce.number().int().optional(),
  method: z.string().toUpperCase().optional(),
  /** case-insensitive substring of the normalised endpoint */
  endpoint: z.string().optional(),
  /** request id */
  q: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const STATUS_RANGE = { '2xx': [200, 300], '4xx': [400, 500], '5xx': [500, 600], error: [400, 1000] } as const;

const summaryColumns = {
  id: requestLog.id,
  createdAt: requestLog.createdAt,
  method: requestLog.method,
  path: requestLog.path,
  endpoint: requestLog.endpoint,
  statusCode: requestLog.statusCode,
  durationMs: requestLog.durationMs,
  reqBytes: requestLog.reqBytes,
  respBytes: requestLog.respBytes,
  errorCode: requestLog.errorCode,
  keyId: requestLog.apiKeyId,
  keyName: apiKey.name,
  userId: requestLog.userId,
  accountId: requestLog.accountId,
};

/** Keyset cursor over (created_at desc, id desc). */
const encodeCursor = (createdAt: Date, id: string) =>
  Buffer.from(JSON.stringify([createdAt.toISOString(), id])).toString('base64url');

function decodeCursor(cursor: string): [string, string] {
  try {
    const [ts, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as unknown[];
    if (typeof ts === 'string' && typeof id === 'string' && !Number.isNaN(Date.parse(ts))) return [ts, id];
  } catch {
    // fall through
  }
  throw new AppError(400, 'invalid_cursor', 'The cursor is invalid');
}

const withIso = <T extends { createdAt: Date }>(row: T) => ({ ...row, createdAt: row.createdAt.toISOString() });

/** Dashboard request logs (session cookie). Mounted at /api/logs. */
export default async function logsRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook('preHandler', app.requireSession);
  const tags = ['dashboard'];

  r.get('/', { schema: { tags, querystring: listQuery, response: { 200: logList } } }, async (request) => {
    const f = request.query;
    const where: (SQL | undefined)[] = [eq(requestLog.teamId, request.session.teamId)];
    if (f.from) where.push(gte(requestLog.createdAt, new Date(f.from)));
    if (f.to) where.push(lt(requestLog.createdAt, new Date(f.to)));
    if (f.status) {
      const [min, max] = STATUS_RANGE[f.status];
      where.push(gte(requestLog.statusCode, min), lt(requestLog.statusCode, max));
    }
    if (f.keyId) where.push(eq(requestLog.apiKeyId, f.keyId));
    if (f.accountId !== undefined) where.push(eq(requestLog.accountId, f.accountId));
    if (f.method) where.push(eq(requestLog.method, f.method));
    if (f.endpoint) where.push(ilike(requestLog.endpoint, `%${f.endpoint.replace(/[\\%_]/g, '\\$&')}%`));
    if (f.q) where.push(eq(requestLog.id, f.q.trim()));
    if (f.cursor) {
      const [ts, id] = decodeCursor(f.cursor);
      where.push(sql`(${requestLog.createdAt}, ${requestLog.id}) < (${ts}::timestamptz, ${id})`);
    }

    const rows = await db
      .select(summaryColumns)
      .from(requestLog)
      .leftJoin(apiKey, eq(apiKey.id, requestLog.apiKeyId))
      .where(and(...where))
      .orderBy(desc(requestLog.createdAt), desc(requestLog.id))
      .limit(f.limit + 1);
    const page = rows.slice(0, f.limit);
    const last = page.at(-1);
    return {
      items: page.map((row): LogSummary => withIso(row)),
      nextCursor: rows.length > f.limit && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  });

  r.get(
    '/:id',
    { schema: { tags, params: z.object({ id: z.string() }), response: { 200: logDetail } } },
    async (request) => {
      const [row] = await db
        .select({
          ...summaryColumns,
          query: requestLog.query,
          ip: requestLog.ip,
          reqHeaders: requestLog.reqHeaders,
          reqBody: requestLog.reqBody,
          respBody: requestLog.respBody,
        })
        .from(requestLog)
        .leftJoin(apiKey, eq(apiKey.id, requestLog.apiKeyId))
        .where(and(eq(requestLog.id, request.params.id), eq(requestLog.teamId, request.session.teamId)))
        .limit(1);
      if (!row) throw new AppError(404, 'not_found', 'Log entry not found');
      return withIso(row) satisfies LogDetail;
    },
  );
}
