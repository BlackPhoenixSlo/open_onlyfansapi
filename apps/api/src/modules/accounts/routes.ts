import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { accountList, type Account } from '../../contracts.js';
import { AppError } from '../../lib/errors.js';
import { assertTeamLinked } from '../../lib/team-link.js';
import type { Upstream } from '../../lib/upstream.js';
import type { Actor } from '../../plugins/actor.js';

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

/** The accounts the actor sees in `GET /v1/accounts`: the upstream's list, narrowed to a key's allowlist. 502 when it fails. */
export async function connectedAccounts(upstream: Upstream, actor: Actor, requestId: string): Promise<UpstreamAccount[]> {
  const res = await upstream.listAccounts(requestId);
  const rows = res.ok ? parseAccounts(res.body) : null;
  if (!rows) throw new AppError(502, 'upstream_error', `The upstream answered ${res.status} for the account list`);
  const allowed = actor.accountIds;
  return rows.filter((a) => !allowed || allowed.includes(a.id));
}

export default async function accountsRoutes(app: FastifyInstance) {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/accounts',
    { schema: { tags: ['gateway'], response: { 200: accountList } } },
    async (request) => {
      const { actor } = request;
      await assertTeamLinked(actor.teamId);
      return { items: (await connectedAccounts(app.upstream, actor, request.id)).map(toAccount) };
    },
  );
}
