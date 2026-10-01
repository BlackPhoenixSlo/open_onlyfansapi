import { fromNodeHeaders } from 'better-auth/node';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { auth } from '../auth.js';
import { db } from '../db/index.js';
import { member } from '../db/schema.js';
import { env } from '../env.js';
import { AppError } from '../lib/errors.js';
import { assertCsrf } from './csrf.js';

export type DashboardSession = { userId: string; teamId: string; role: string };

declare module 'fastify' {
  interface FastifyRequest {
    session: DashboardSession;
  }
  interface FastifyInstance {
    requireSession: (request: FastifyRequest) => Promise<void>;
  }
}

/** Resolves the better-auth session cookie to `{ userId, teamId, role }`, or null when signed out. */
export async function loadSession(request: FastifyRequest): Promise<DashboardSession | null> {
  const res = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
  if (!res) return null;
  const teamId = res.session.activeOrganizationId;
  const [m] = teamId
    ? await db
        .select({ role: member.role })
        .from(member)
        .where(and(eq(member.organizationId, teamId), eq(member.userId, res.user.id)))
        .limit(1)
    : [];
  if (!teamId || !m) throw new AppError(403, 'no_workspace', 'No active workspace for this session');
  return { userId: res.user.id, teamId, role: m.role };
}

export default fp(async (app: FastifyInstance) => {
  // better-auth: sign-up, sign-in, session, organization. Bodies are forwarded verbatim.
  await app.register(async (authScope) => {
    authScope.removeAllContentTypeParsers();
    authScope.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body));
    authScope.route({
      method: ['GET', 'POST'],
      url: '/api/auth/*',
      async handler(request, reply) {
        const body = typeof request.body === 'string' && request.body.length > 0 ? request.body : undefined;
        const response = await auth.handler(
          new Request(new URL(request.url, env.BETTER_AUTH_URL), {
            method: request.method,
            headers: fromNodeHeaders(request.headers),
            body,
          }),
        );
        reply.status(response.status);
        response.headers.forEach((value, key) => {
          if (key !== 'set-cookie') reply.header(key, value);
        });
        const cookies = response.headers.getSetCookie();
        if (cookies.length) reply.header('set-cookie', cookies);
        return reply.send(response.body ? await response.text() : null);
      },
    });
  });

  app.decorateRequest('session', null as unknown as DashboardSession);
  /** preHandler for dashboard-only routes: session cookie required, CSRF checked on writes. */
  app.decorate('requireSession', async (request: FastifyRequest) => {
    const session = await loadSession(request);
    if (!session) throw new AppError(401, 'unauthorized', 'Sign in required');
    assertCsrf(request);
    request.session = session;
  });
});
