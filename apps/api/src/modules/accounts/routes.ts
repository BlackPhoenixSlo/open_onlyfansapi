import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { accountList, type Account } from '../../contracts.js';
import { AppError } from '../../lib/errors.js';
import { assertTeamLinked } from '../../lib/team-link.js';

type UpstreamAccount = {
  id: number;
  label?: string | null;
  ofUsername?: string | null;
  ofDisplayName?: string | null;
  ofAvatarUrl?: string | null;
  status?: string | null;
};

/** Whitelists the upstream row: internal fields (proxy, agency, creator ids) never leave the gateway. */
function toAccount(a: UpstreamAccount): Account {
  return {
    id: a.id,
    label: a.label ?? null,
    username: a.ofUsername ?? null,
    displayName: a.ofDisplayName ?? null,
    avatarUrl: a.ofAvatarUrl ?? null,
    status: a.status ?? 'unknown',
  };
}

function parseAccounts(body: Buffer): UpstreamAccount[] | null {
  try {
    const rows: unknown = JSON.parse(body.toString());
    return Array.isArray(rows) ? (rows as UpstreamAccount[]) : null;
  } catch {
    return null;
  }
}

export default async function accountsRoutes(app: FastifyInstance) {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/accounts',
    { schema: { tags: ['gateway'], response: { 200: accountList } } },
    async (request) => {
      const { actor } = request;
      await assertTeamLinked(actor.teamId);
      const res = await app.upstream.listAccounts(request.id);
      const rows = res.ok ? parseAccounts(res.body) : null;
      if (!rows) throw new AppError(502, 'upstream_error', `The upstream answered ${res.status} for the account list`);
      const allowed = actor.accountIds;
      return { items: rows.filter((a) => !allowed || allowed.includes(a.id)).map(toAccount) };
    },
  );
}
