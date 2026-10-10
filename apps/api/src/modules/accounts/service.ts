import { AppError } from '../../lib/errors.js';
import type { Upstream } from '../../lib/upstream.js';
import type { Actor } from '../../plugins/actor.js';
import { ownedAccountIds } from './ownership.js';

export type UpstreamAccount = {
  id: number;
  label?: string | null;
  ofUsername?: string | null;
  ofDisplayName?: string | null;
  ofAvatarUrl?: string | null;
  status?: string | null;
};

function parseAccounts(body: Buffer): UpstreamAccount[] | null {
  try {
    const rows: unknown = JSON.parse(body.toString());
    return Array.isArray(rows) ? (rows as UpstreamAccount[]) : null;
  } catch {
    return null;
  }
}

/** Every account the upstream lists, across all workspaces. 502 when the list cannot be read. */
export async function listUpstreamAccounts(upstream: Upstream, requestId: string): Promise<UpstreamAccount[]> {
  const res = await upstream.listAccounts(requestId);
  const rows = res.ok ? parseAccounts(res.body) : null;
  if (!rows) throw new AppError(502, 'upstream_error', `The upstream answered ${res.status} for the account list`);
  return rows;
}

/**
 * The accounts the actor sees in `GET /v1/accounts`: the upstream's list, narrowed to the accounts its workspace owns,
 * then to a key's allowlist. 502 when it fails.
 */
export async function connectedAccounts(upstream: Upstream, actor: Actor, requestId: string): Promise<UpstreamAccount[]> {
  const rows = await listUpstreamAccounts(upstream, requestId);
  const owned = new Set(await ownedAccountIds(actor.teamId));
  const allowed = actor.accountIds;
  return rows.filter((a) => owned.has(a.id) && (!allowed || allowed.includes(a.id)));
}
