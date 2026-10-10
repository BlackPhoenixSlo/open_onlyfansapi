import type { ProxyInfo } from '../../contracts.js';
import { AppError } from '../../lib/errors.js';
import type { Upstream, UpstreamResponse } from '../../lib/upstream.js';
import { ownedAccountIds } from '../accounts/ownership.js';

export type UpstreamProxy = {
  label: string;
  scheme?: string | null;
  host?: string | null;
  port?: number | null;
  assigned_account_ids?: (string | number)[] | null;
  verified_ip?: string | null;
  verified_at?: string | null;
  verified_geo?: string | null;
  verified_of_reachable?: boolean | null;
  verified_of_error?: string | null;
  stats?: {
    ok?: number;
    failed?: number;
    blocked?: number;
    last_ok_at?: string | null;
    last_error?: string | null;
    last_error_at?: string | null;
    last_used_at?: string | null;
  };
  since?: string | null;
};

/** Whitelists the upstream entry: its username (and anything else it adds) never leaves the gateway. */
export function toProxy(p: UpstreamProxy): ProxyInfo {
  const s = p.stats ?? {};
  return {
    label: p.label,
    scheme: p.scheme ?? 'http',
    host: p.host ?? null,
    port: p.port ?? null,
    assignedAccountIds: (p.assigned_account_ids ?? []).map(Number).filter(Number.isInteger),
    verifiedIp: p.verified_ip ?? null,
    verifiedAt: p.verified_at ?? null,
    verifiedGeo: p.verified_geo ?? null,
    ofReachable: p.verified_of_reachable ?? null,
    ofError: p.verified_of_error ?? null,
    stats: {
      ok: s.ok ?? 0,
      failed: s.failed ?? 0,
      blocked: s.blocked ?? 0,
      lastOkAt: s.last_ok_at ?? null,
      lastError: s.last_error ?? null,
      lastErrorAt: s.last_error_at ?? null,
      lastUsedAt: s.last_used_at ?? null,
    },
    since: p.since ?? '',
  };
}

export function parse<T>(res: UpstreamResponse, what: string): T {
  try {
    return JSON.parse(res.body.toString()) as T;
  } catch {
    throw new AppError(502, 'upstream_error', `The upstream answered an unreadable ${what}`);
  }
}

/** The upstream's proxy list, whitelisted. 502 when it fails. */
async function listProxies(upstream: Upstream, requestId: string): Promise<ProxyInfo[]> {
  const res = await upstream.listProxies(requestId);
  if (!res.ok) throw new AppError(502, 'upstream_error', `The upstream answered ${res.status} for the proxy list`);
  const rows = parse<unknown>(res, 'proxy list');
  if (!Array.isArray(rows)) throw new AppError(502, 'upstream_error', 'The upstream answered an unreadable proxy list');
  return (rows as UpstreamProxy[]).map(toProxy);
}

/** Whether a workspace owning `owned` may see and use the proxy: unbound, or bound only to its accounts. */
const usable = (p: ProxyInfo, owned: Set<number>) => p.assignedAccountIds.every((id) => owned.has(id));

/** The proxies workspace `teamId` may see: unbound ones and ones bound only to its accounts. */
export async function listUsableProxies(upstream: Upstream, teamId: string, requestId: string): Promise<ProxyInfo[]> {
  const proxies = await listProxies(upstream, requestId);
  const owned = new Set(await ownedAccountIds(teamId));
  return proxies.filter((p) => usable(p, owned));
}

/**
 * 403 `account_not_allowed` when proxy `label` is bound to an account workspace `teamId` does not own. An unknown label
 * passes: the upstream answers it.
 */
export async function assertProxyUsable(upstream: Upstream, teamId: string, label: string, requestId: string): Promise<void> {
  const proxy = (await listProxies(upstream, requestId)).find((p) => p.label === label);
  if (proxy && !usable(proxy, new Set(await ownedAccountIds(teamId)))) {
    throw new AppError(403, 'account_not_allowed', `Proxy ${label} is bound to an account not owned by this workspace`);
  }
}
