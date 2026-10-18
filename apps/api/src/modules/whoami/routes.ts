import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { db } from '../../db/index.js';
import { organization, teamBackend } from '../../db/schema.js';
import { whoami } from '../../contracts.js';
import { AppError } from '../../lib/errors.js';

export default async function whoamiRoutes(app: FastifyInstance) {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/whoami',
    { config: { member: 'allow' }, schema: { tags: ['gateway'], response: { 200: whoami } } },
    async (request) => {
      const { actor } = request;
      const [team] = await db
        .select({
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          linkedAt: teamBackend.linkedAt,
        })
        .from(organization)
        .leftJoin(teamBackend, eq(teamBackend.teamId, organization.id))
        .where(eq(organization.id, actor.teamId))
        .limit(1);
      if (!team) throw new AppError(404, 'not_found', 'Workspace not found');
      return {
        team: { id: team.id, name: team.name, slug: team.slug, linked: team.linkedAt !== null },
        key: actor.keyId
          ? { id: actor.keyId, name: actor.keyName, scope: actor.scope, allowedAccountIds: actor.accountIds }
          : null,
        user: actor.role
          ? { id: actor.userId, role: actor.role, allowedAccountIds: actor.accountIds, features: actor.features }
          : null,
      };
    },
  );
}
