import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { browserLoginInputBody, browserLoginStartBody } from '../../contracts.js';
import { AppError } from '../../lib/errors.js';
import { assertTeamLinked } from '../../lib/team-link.js';
import { passThrough } from '../../lib/upstream.js';
import { assertProxyUsable } from '../proxies/service.js';
import { claimAccount } from './ownership.js';

/** A started remote-browser login the dashboard may poll, feed input to and stream. */
type JobRecord = { teamId: string; streamToken: string; at: number };

const JOB_TTL_MS = 11 * 60_000; // a little past the upstream's ~10-minute expiry

/**
 * Remote-browser login (dashboard only, plan direct-login §C), mounted at /api/accounts/login. A real
 * browser logs the account in through its proxy; a human solves any challenge / enters 2FA in a popup.
 * `backend: 'browserbase'` runs that browser on Browserbase's managed proxies and the status carries its live view
 * URL. The proxy is optional and bound after the login the way a pasted cURL binds it (none: the account keeps its
 * proxy); a `proxyLabel` must be a proxy this workspace may use.
 *
 * `/api` is outside the `/v1` request-log scope, so the password and the live cookies the upstream
 * captures are never stored; they are forwarded, and the upstream's statuses and bodies are returned
 * unchanged. Writes need the dashboard session + CSRF. The SSE stream is instead gated by the per-job
 * stream token in the query string (EventSource cannot set headers). The gateway holds a jobId → team
 * map so only the workspace that started a job can poll, feed, cancel or stream it; once the login
 * succeeds the resulting OF account is claimed for that workspace. A claim the workspace may not make (another
 * workspace owns the account) turns the poll into an `error` state, so the login never reports success for an
 * account the workspace cannot see.
 */
export default async function accountsLoginRoutes(app: FastifyInstance) {
  const jobs = new Map<string, JobRecord>();
  const prune = () => {
    const cutoff = Date.now() - JOB_TTL_MS;
    for (const [id, rec] of jobs) if (rec.at < cutoff) jobs.delete(id);
  };
  /** The job record if workspace `teamId` started it, else a 404 (the started-principal check). */
  const owned = (jobId: string, teamId: string): JobRecord => {
    const rec = jobs.get(jobId);
    if (!rec || rec.teamId !== teamId) throw new AppError(404, 'job_not_found', 'No such login job');
    return rec;
  };

  const r = app.withTypeProvider<ZodTypeProvider>();

  // SSE screencast + state. No session: authenticated by the per-job stream token in the query.
  r.get(
    '/browser/:jobId/stream',
    { schema: { tags: ['dashboard'], params: z.object({ jobId: z.string() }), querystring: z.object({ token: z.string().min(1) }) } },
    async (request, reply) => {
      prune();
      const rec = jobs.get(request.params.jobId);
      if (!rec || rec.streamToken !== request.query.token) throw new AppError(404, 'job_not_found', 'No such login job');
      const res = await app.upstream.browserLoginStream(request.params.jobId, request.query.token);
      if (!res.ok || !res.body) throw new AppError(502, 'upstream_error', 'The upstream would not stream the login');
      reply.raw.setHeader('content-type', 'text/event-stream');
      reply.raw.setHeader('cache-control', 'no-cache');
      reply.raw.setHeader('x-accel-buffering', 'no');
      return reply.send(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]));
    },
  );

  // Session-gated routes (session cookie + CSRF on writes).
  await app.register(async (scope) => {
    const s = scope.withTypeProvider<ZodTypeProvider>();
    s.addHook('preHandler', app.requireOwner);

    s.post('/browser/start', { schema: { tags: ['dashboard'], body: browserLoginStartBody } }, async (request, reply) => {
      await assertTeamLinked(request.session.teamId);
      const { email, password, proxy, proxyLabel, backend } = request.body;
      if (proxyLabel) await assertProxyUsable(app.upstream, request.session.teamId, proxyLabel, request.id);
      const res = await app.upstream.startBrowserLogin(
        JSON.stringify({ email, password, proxy, proxy_label: proxyLabel, backend }),
        request.session.teamId,
        request.id,
      );
      if (!res.ok) return passThrough(reply, res);
      let body: { jobId?: unknown; streamToken?: unknown };
      try {
        body = JSON.parse(res.body.toString());
      } catch {
        throw new AppError(502, 'upstream_error', 'The upstream started a login but answered an unreadable job');
      }
      if (typeof body.jobId !== 'string' || typeof body.streamToken !== 'string') {
        throw new AppError(502, 'upstream_error', 'The upstream started a login but answered no job id');
      }
      prune();
      jobs.set(body.jobId, { teamId: request.session.teamId, streamToken: body.streamToken, at: Date.now() });
      return reply.send(body);
    });

    s.get(
      '/browser/:jobId',
      { schema: { tags: ['dashboard'], params: z.object({ jobId: z.string() }) } },
      async (request, reply) => {
        owned(request.params.jobId, request.session.teamId);
        const res = await app.upstream.browserLoginStatus(request.params.jobId, request.session.teamId, request.id);
        if (!res.ok) return passThrough(reply, res);
        const snap = JSON.parse(res.body.toString()) as { accountId?: number | null };
        // On success the OF account id is known: record it for this workspace, like a dashboard connect. Any other
        // failure (e.g. the database) throws, and the dashboard's next poll claims again.
        if (typeof snap.accountId === 'number') {
          try {
            await claimAccount(request.session.teamId, snap.accountId);
          } catch (e) {
            if (!(e instanceof AppError) || e.statusCode !== 409) throw e;
            request.log.warn({ jobId: request.params.jobId, code: e.code }, 'browser login account not claimed');
            return reply.send({ ...snap, state: 'error', error: `Signed in, but the account was not added: ${e.message}` });
          }
        }
        return reply.send(snap);
      },
    );

    s.post(
      '/browser/:jobId/input',
      { schema: { tags: ['dashboard'], params: z.object({ jobId: z.string() }), body: browserLoginInputBody } },
      async (request, reply) => {
        owned(request.params.jobId, request.session.teamId);
        return passThrough(
          reply,
          await app.upstream.browserLoginInput(request.params.jobId, JSON.stringify(request.body), request.session.teamId, request.id),
        );
      },
    );

    s.post(
      '/browser/:jobId/cancel',
      { schema: { tags: ['dashboard'], params: z.object({ jobId: z.string() }) } },
      async (request, reply) => {
        owned(request.params.jobId, request.session.teamId);
        return passThrough(reply, await app.upstream.cancelBrowserLogin(request.params.jobId, request.session.teamId, request.id));
      },
    );
  });
}
