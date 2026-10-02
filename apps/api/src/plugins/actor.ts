import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { db } from '../db/index.js';
import { apiKey } from '../db/schema.js';
import { AppError } from '../lib/errors.js';
import type { KeyScope } from '../contracts.js';
import { assertCsrf } from './csrf.js';
import { loadSession } from './session.js';

export type Actor = {
  teamId: string;
  keyId: string | null;
  keyName: string | null;
  userId: string | null;
  scope: KeyScope;
  /** null = every account the workspace can reach */
  accountIds: number[] | null;
};

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor;
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
  if (request.headers.upgrade?.toLowerCase() !== 'websocket') return undefined;
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
      accountIds: key.allowedAccountIds,
    };
    return;
  }

  const session = request.headers['x-dashboard'] === '1' ? await loadSession(request) : null;
  if (!session) throw new AppError(401, 'unauthorized', 'Send an API key as `Authorization: Bearer <key>`');
  assertCsrf(request);
  request.actor = {
    teamId: session.teamId,
    keyId: null,
    keyName: null,
    userId: session.userId,
    scope: 'write',
    accountIds: null,
  };
}

/** 403 unless the actor may write. */
export function assertWriteScope(actor: Actor, method: string): void {
  if (method !== 'GET' && method !== 'HEAD' && actor.scope !== 'write') {
    throw new AppError(403, 'insufficient_scope', 'This API key is read-only');
  }
}
