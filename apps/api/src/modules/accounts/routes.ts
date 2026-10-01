import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { accountList, type Account } from '../../contracts.js';
import { requireBackendUserId } from '../../lib/backend.js';
import { AppError } from '../../lib/errors.js';

type BackendAccount = {
  id: number;
  label?: string | null;
  ofUsername?: string | null;
  ofDisplayName?: string | null;
  ofAvatarUrl?: string | null;
  status?: string | null;
};

/** Whitelists the backend row: internal fields (proxy, agency, creator ids) never leave the gateway. */
function toAccount(a: BackendAccount): Account {
  return {
    id: a.id,
    label: a.label ?? null,
    username: a.ofUsername ?? null,
    displayName: a.ofDisplayName ?? null,
    avatarUrl: a.ofAvatarUrl ?? null,
    status: a.status ?? 'unknown',
  };
}

function parseAccounts(body: Buffer): BackendAccount[] | null {
  try {
    const rows: unknown = JSON.parse(body.toString());
    return Array.isArray(rows) ? (rows as BackendAccount[]) : null;
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
      const backendUserId = await requireBackendUserId(actor.teamId);
      const res = await app.backend.request(backendUserId, new URL('/of-accounts', app.backend.origin), {
        headers: { accept: 'application/json', 'x-request-id': request.id },
      });
      const rows = res.ok ? parseAccounts(res.body) : null;
      if (!rows) throw new AppError(502, 'backend_error', `The backend answered ${res.status} for the account list`);
      const allowed = actor.accountIds;
      return { items: rows.filter((a) => !allowed || allowed.includes(a.id)).map(toAccount) };
    },
  );
}
