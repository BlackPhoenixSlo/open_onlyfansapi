import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { connectAccountBody, updateAccountBody } from '../../contracts.js';
import { AppError } from '../../lib/errors.js';
import { passThrough } from '../../lib/upstream.js';
import { assertTeamLinked } from '../../lib/team-link.js';
import { assertProxyUsable } from '../proxies/service.js';
import { assertAccountOwned, assertNotOwnedElsewhere, claimAccount } from './ownership.js';
import { toAccount } from './routes.js';
import type { UpstreamAccount } from './service.js';

/** The `accountId` of the upstream's `/session/bootstrap` answer (`ConnectedAccount`); 502 when it has none. */
function connectedAccountId(body: Buffer): number {
  let id: unknown;
  try {
    id = (JSON.parse(body.toString()) as { accountId?: unknown }).accountId;
  } catch {
    id = undefined;
  }
  if (typeof id === 'number' && Number.isInteger(id) && id > 0) return id;
  throw new AppError(502, 'upstream_error', 'The upstream connected an account but answered no accountId');
}

/** The OF user id in the cURL's `user-id` header (the account the upstream connects); 400 `invalid_curl` without one. */
function curlAccountId(curl: string): number {
  const id = Number(/\buser-id:\s*(\d{1,10})\b/i.exec(curl)?.[1] ?? NaN);
  if (id > 0) return id;
  throw new AppError(400, 'invalid_curl', 'the curl has no numeric user-id header');
}

/**
 * Dashboard-only account connect, edit and disconnect (session cookie + CSRF). Mounted at /api/accounts.
 * `/api` is outside the `/v1` request-log scope, so the cURL (live OF cookies) and proxy URLs are never stored; they are
 * forwarded to the upstream, and its error statuses and bodies are returned unchanged. Connect records the account as
 * the session workspace's (`account_workspace`); edit and disconnect need the workspace to own it (403 otherwise).
 */
export default async function accountsConnectRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.addHook('preHandler', app.requireOwner);

  r.post('/connect', { schema: { tags: ['dashboard'], body: connectAccountBody } }, async (request, reply) => {
    await assertTeamLinked(request.session.teamId);
    const { curl, nickname, proxyUrl } = request.body;
    // Refused before the upstream replaces another workspace's session; claimAccount below is the authoritative check.
    const expected = curlAccountId(curl);
    await assertNotOwnedElsewhere(request.session.teamId, expected);
    const res = await app.upstream.bootstrapSession(JSON.stringify({ curl, nickname, proxy_url: proxyUrl }), request.id);
    if (res.ok) {
      const connected = connectedAccountId(res.body);
      if (connected !== expected) {
        throw new AppError(502, 'upstream_error', `The upstream connected account ${connected}, not the cURL's ${expected}`);
      }
      await claimAccount(request.session.teamId, connected);
    }
    return passThrough(reply, res);
  });

  // The answer is whitelisted like `GET /v1/accounts`: the upstream row's proxy label stays here.
  r.patch(
    '/:id',
    {
      schema: {
        tags: ['dashboard'],
        params: z.object({ id: z.coerce.number().int().positive() }),
        body: updateAccountBody,
      },
    },
    async (request, reply) => {
      await assertTeamLinked(request.session.teamId);
      await assertAccountOwned(request.session.teamId, request.params.id);
      const { label, proxy } = request.body;
      if (proxy && 'label' in proxy) await assertProxyUsable(app.upstream, request.session.teamId, proxy.label, request.id);
      const res = await app.upstream.updateAccount(request.params.id, JSON.stringify({ nickname: label, proxy }), request.id);
      if (!res.ok) return passThrough(reply, res);
      let row: UpstreamAccount;
      try {
        row = JSON.parse(res.body.toString()) as UpstreamAccount;
      } catch {
        throw new AppError(502, 'upstream_error', 'The upstream answered an unreadable account');
      }
      return { account: toAccount(row) };
    },
  );

  // Disconnects upstream only: analytics rows and keys' `allowedAccountIds` that name the account are kept.
  r.delete(
    '/:id',
    { schema: { tags: ['dashboard'], params: z.object({ id: z.coerce.number().int().positive() }) } },
    async (request, reply) => {
      await assertTeamLinked(request.session.teamId);
      await assertAccountOwned(request.session.teamId, request.params.id);
      return passThrough(reply, await app.upstream.deleteAccount(request.params.id, request.id));
    },
  );
}
