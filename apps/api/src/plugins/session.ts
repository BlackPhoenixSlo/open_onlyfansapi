import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { auth, CLIENT_IP_HEADER, sessionMembership } from '../auth.js';
import { effectivePermissions, type MemberFeature, type MemberRole } from '../contracts.js';
import { env } from '../env.js';
import { AppError, ownerOnly } from '../lib/errors.js';
import { assertCsrf } from './csrf.js';

/** The signed-in dashboard user, with their role and features as enforced. */
export type DashboardSession = { userId: string; teamId: string; role: MemberRole; features: MemberFeature[] };

declare module 'fastify' {
  interface FastifyRequest {
    session: DashboardSession;
  }
  interface FastifyInstance {
    requireSignedIn: (request: FastifyRequest) => Promise<void>;
    requireOwner: (request: FastifyRequest) => Promise<void>;
  }
}

/**
 * Resolves the better-auth session cookie to the user and their membership row, or null when signed out (or a team
 * member whose row is gone). Read on every request, so a member's edited permissions apply at once.
 */
export async function loadMembership(request: FastifyRequest) {
  const res = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
  if (!res) return null;
  // The membership (one per user) is the source of truth.
  const membership = await sessionMembership(res.user);
  return membership ? { userId: res.user.id, membership } : null;
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
        // better-auth keys its sign-in rate limit and session IP on CLIENT_IP_HEADER, not on a client-supplied
        // X-Forwarded-For: always overwrite it with Fastify's request.ip (which honours TRUST_PROXY).
        const headers = fromNodeHeaders(request.headers);
        headers.set(CLIENT_IP_HEADER, request.ip);
        const response = await auth.handler(
          new Request(new URL(request.url, env.BETTER_AUTH_URL), { method: request.method, headers, body }),
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
  /** Hook for an `/api` route any signed-in user may use (members too): session cookie required, CSRF checked on writes. */
  async function requireSignedIn(request: FastifyRequest) {
    const s = await loadMembership(request);
    if (!s) throw new AppError(401, 'unauthorized', 'Sign in required');
    assertCsrf(request);
    const { role, features } = effectivePermissions(s.membership);
    request.session = { userId: s.userId, teamId: s.membership.organizationId, role, features };
  }
  app.decorate('requireSignedIn', requireSignedIn);
  /**
   * preHandler for every dashboard-only `/api` route: `requireSignedIn`, and the workspace owner only (plan-team §1.6),
   * so a team member cannot mint keys, connect accounts or read the logs.
   */
  app.decorate('requireOwner', async (request: FastifyRequest) => {
    await requireSignedIn(request);
    if (request.session.role !== 'owner') throw ownerOnly();
  });
});
