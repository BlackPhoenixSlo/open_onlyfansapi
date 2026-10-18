import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { accountList, type Account } from '../../contracts.js';
import { assertTeamLinked } from '../../lib/team-link.js';
import { connectedAccounts, type UpstreamAccount } from './service.js';

/** Whitelists the upstream row: internal fields (proxy, agency, creator ids) never leave the gateway. */
export function toAccount(a: UpstreamAccount): Account {
  return {
    id: a.id,
    label: a.label ?? null,
    username: a.ofUsername ?? null,
    displayName: a.ofDisplayName ?? null,
    avatarUrl: a.ofAvatarUrl ?? null,
    status: a.status ?? 'unknown',
  };
}

export default async function accountsRoutes(app: FastifyInstance) {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/accounts',
    // Members too: the list is narrowed to their creators.
    { config: { member: 'allow' }, schema: { tags: ['gateway'], response: { 200: accountList } } },
    async (request) => {
      const { actor } = request;
      await assertTeamLinked(actor.teamId);
      return { items: (await connectedAccounts(app.upstream, actor, request.id)).map(toAccount) };
    },
  );
}
