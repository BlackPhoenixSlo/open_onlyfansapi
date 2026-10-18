import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  acceptInviteBody,
  createdInvite,
  createInviteBody,
  invitePreview,
  me,
  teamInviteList,
  teamMember,
  teamMemberList,
  updateMemberBody,
} from '../../contracts.js';
import { AppError } from '../../lib/errors.js';
import { assertCsrf } from '../../plugins/csrf.js';
import { loadMembership } from '../../plugins/session.js';
import {
  acceptInvite,
  createInvite,
  describeMembership,
  listInvites,
  listMembers,
  previewInvite,
  removeMember,
  revokeInvite,
  updateMember,
} from './service.js';

/**
 * Team members and invite links (plan-team §2.3), mounted at /api. Managing them is owner-only (session cookie + CSRF);
 * opening and accepting an invite needs no session, only the token in the path. `GET /api/me` takes any signed-in user.
 */
export default async function teamRoutes(app: FastifyInstance) {
  const tags = ['dashboard'];
  const params = z.object({ id: z.string() });
  const tokenParams = z.object({ token: z.string().min(1).max(100) });

  await app.register(async (scope) => {
    const r = scope.withTypeProvider<ZodTypeProvider>();
    r.addHook('preHandler', app.requireOwner);

    r.get('/team/members', { schema: { tags, response: { 200: teamMemberList } } }, async (request) => ({
      items: await listMembers(request.session.teamId),
    }));

    r.patch(
      '/team/members/:id',
      { schema: { tags, params, body: updateMemberBody, response: { 200: z.object({ member: teamMember }) } } },
      async (request) => ({ member: await updateMember(request.session.teamId, request.params.id, request.body) }),
    );

    r.delete('/team/members/:id', { schema: { tags, params } }, async (request, reply) => {
      await removeMember(request.session.teamId, request.params.id);
      return reply.status(204).send();
    });

    r.get('/invites', { schema: { tags, response: { 200: teamInviteList } } }, async (request) => ({
      items: await listInvites(request.session.teamId),
    }));

    r.post('/invites', { schema: { tags, body: createInviteBody, response: { 201: createdInvite } } }, async (request, reply) => {
      const created = await createInvite(request.session.teamId, request.session.userId, request.body);
      return reply.status(201).send(created);
    });

    r.delete('/invites/:id', { schema: { tags, params } }, async (request, reply) => {
      await revokeInvite(request.session.teamId, request.params.id);
      return reply.status(204).send();
    });
  });

  const r = app.withTypeProvider<ZodTypeProvider>();

  // The dashboard's layout reads the role here, not from /v1/whoami: no API rate limit, and it answers members too.
  r.get('/me', { schema: { tags, response: { 200: me } } }, async (request) => {
    const session = await loadMembership(request);
    if (!session) throw new AppError(401, 'unauthorized', 'Sign in required');
    return describeMembership(session.membership);
  });

  r.get('/invites/:token', { schema: { tags, params: tokenParams, response: { 200: invitePreview } } }, async (request) =>
    previewInvite(request.params.token),
  );

  // No session, but the dashboard's CSRF headers all the same, so a cross-site form cannot sign anyone up.
  r.post(
    '/invites/:token/accept',
    {
      schema: { tags, params: tokenParams, body: acceptInviteBody, response: { 201: z.object({ username: z.string() }) } },
      preHandler: async (request) => assertCsrf(request),
    },
    async (request, reply) => reply.status(201).send(await acceptInvite(request.params.token, request.body)),
  );
}
