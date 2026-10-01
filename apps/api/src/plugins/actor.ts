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

/**
 * `/v1` onRequest hook. A bearer key wins; an invalid bearer is a 401 even if a valid cookie is present.
 * Without a bearer, the dashboard session cookie is accepted together with `x-dashboard: 1`.
 */
export async function authenticate(request: FastifyRequest): Promise<void> {
  const header = request.headers.authorization;
  if (header !== undefined) {
    const secret = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
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
