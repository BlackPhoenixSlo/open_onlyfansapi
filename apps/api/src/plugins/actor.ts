import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { db } from '../db/index.js';
import { apiKey } from '../db/schema.js';
import { AppError, ownerOnly } from '../lib/errors.js';
import { effectivePermissions, memberFeature, type KeyScope, type MemberFeature, type MemberRole } from '../contracts.js';
import { assertCsrf } from './csrf.js';
import { loadMembership } from './session.js';

export type Actor = {
  teamId: string;
  scope: KeyScope;
  /** null = every account the workspace can reach */
  accountIds: number[] | null;
  /**
   * What the actor may use: every feature for API keys and the owner, a team member's own otherwise (plan-team §1.5),
   * so a member is a person-bound key: `accountIds` and this list bound everything it reaches.
   */
  features: MemberFeature[];
} & (
  | { /** An API key. */ keyId: string; keyName: string; userId: null; role: null }
  | {
      /** A dashboard session: its user and their role in the workspace. */
      keyId: null;
      keyName: null;
      userId: string;
      role: MemberRole;
    }
);

/**
 * What a team member needs on a `/v1` route (plan-team §1.5), as the route's `config.member`: a feature, `'allow'`
 * (every member; the route is still bounded by their creators), or a function of the request (the proxy, which
 * reads its path) giving a feature, `'owner'` (owner only) or null (no feature names it). A route that declares nothing
 * is refused to members: new routes are owner-and-key-only by default.
 */
type MemberAccess = MemberFeature | 'allow' | ((request: FastifyRequest) => MemberFeature | 'owner' | null);

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor;
  }
  interface FastifyContextConfig {
    member?: MemberAccess;
  }
}

const LAST_USED_RESOLUTION_MS = 60_000;

export function hashKey(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Subprotocol entry that carries the key on a WebSocket upgrade: `bearer.<key>` (plan-v4 §1.7). */
export const BEARER_PROTOCOL_PREFIX = 'bearer.';

/** The `Sec-WebSocket-Protocol` entries a client offered, in order. */
export function offeredProtocols(request: FastifyRequest): string[] {
  const header = request.headers['sec-websocket-protocol'];
  return (header ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * The key a request presents: the `Authorization` header's or, only on a WebSocket upgrade, the `bearer.<key>`
 * subprotocol entry. undefined = no key presented; '' = presented but malformed.
 */
function presentedSecret(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (header !== undefined) return /^Bearer\s+(\S+)$/i.exec(header)?.[1] ?? '';
  // Set by @fastify/websocket for a real upgrade, not from a client-sent `Upgrade` header on a plain request.
  if (!request.ws) return undefined;
  return offeredProtocols(request)
    .find((p) => p.startsWith(BEARER_PROTOCOL_PREFIX))
    ?.slice(BEARER_PROTOCOL_PREFIX.length);
}

/**
 * `/v1` onRequest hook. A key wins; an invalid key is a 401 even if a valid cookie is present.
 * Without a key, the dashboard session cookie is accepted together with `x-dashboard: 1`.
 */
export async function authenticate(request: FastifyRequest): Promise<void> {
  const secret = presentedSecret(request);
  if (secret !== undefined) {
    const [key] = secret
      ? await db
          .select()
          .from(apiKey)
          .where(and(eq(apiKey.keyHash, hashKey(secret)), isNull(apiKey.revokedAt)))
          .limit(1)
      : [];
    if (!key) throw new AppError(401, 'invalid_api_key', 'The API key is invalid or revoked');
    if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS) {
      db.update(apiKey)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiKey.id, key.id))
        .catch((err) => request.log.warn({ err }, 'last_used_at update failed'));
    }
    request.actor = {
      teamId: key.teamId,
      keyId: key.id,
      keyName: key.name,
      userId: null,
      scope: key.scope,
      role: null,
      accountIds: key.allowedAccountIds,
      features: [...memberFeature.options],
    };
    return;
  }

  const session = request.headers['x-dashboard'] === '1' ? await loadMembership(request) : null;
  if (!session) throw new AppError(401, 'unauthorized', 'Send an API key as `Authorization: Bearer <key>`');
  assertCsrf(request);
  const { role, allowedAccountIds, features } = effectivePermissions(session.membership);
  request.actor = {
    teamId: session.membership.organizationId,
    keyId: null,
    keyName: null,
    userId: session.userId,
    scope: 'write',
    role,
    accountIds: allowedAccountIds,
    features,
  };
}

/**
 * `/v1` onRequest hook after `authenticate`: the one member check (plan-team §1.5). API keys and the owner pass; a
 * team member passes only what the route's `config.member` grants (403 `owner_only` when it grants nothing, 403
 * `feature_not_allowed` outside their features).
 */
export async function gateMember(request: FastifyRequest): Promise<void> {
  if (request.actor.role !== 'member') return;
  const access = request.routeOptions.config.member;
  if (access === 'allow') return;
  const feature = typeof access === 'function' ? access(request) : (access ?? 'owner');
  if (feature === 'owner') throw ownerOnly();
  if (feature === null) throw new AppError(403, 'feature_not_allowed', 'This route is not available to team members');
  if (!request.actor.features.includes(feature)) {
    throw new AppError(403, 'feature_not_allowed', `Your team permissions do not include ${feature}`);
  }
}

/** 403 unless the actor may write. */
export function assertWriteScope(actor: Actor, method: string): void {
  if (method !== 'GET' && method !== 'HEAD' && actor.scope !== 'write') {
    throw new AppError(403, 'insufficient_scope', 'This API key is read-only');
  }
}
