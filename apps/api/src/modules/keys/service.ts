import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { apiKey } from '../../db/schema.js';
import type { ApiKey, KeyScope } from '../../contracts.js';
import { AppError } from '../../lib/errors.js';
import { newId, newKeySecret } from '../../lib/ids.js';
import { hashKey } from '../../plugins/actor.js';

type Row = typeof apiKey.$inferSelect;

function toApiKey(row: Row): ApiKey {
  return {
    id: row.id,
    name: row.name,
    start: row.start,
    scope: row.scope,
    allowedAccountIds: row.allowedAccountIds,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

const notFound = () => new AppError(404, 'not_found', 'API key not found');

export async function listKeys(teamId: string): Promise<ApiKey[]> {
  const rows = await db.select().from(apiKey).where(eq(apiKey.teamId, teamId)).orderBy(desc(apiKey.createdAt));
  return rows.map(toApiKey);
}

export async function createKey(
  teamId: string,
  userId: string,
  input: { name: string; scope: KeyScope; allowedAccountIds: number[] | null },
): Promise<{ key: ApiKey; secret: string }> {
  const secret = newKeySecret();
  const [row] = await db
    .insert(apiKey)
    .values({
      id: newId('key'),
      teamId,
      name: input.name,
      start: secret.slice(0, 12),
      keyHash: hashKey(secret),
      scope: input.scope,
      allowedAccountIds: input.allowedAccountIds,
      createdBy: userId,
    })
    .returning();
  return { key: toApiKey(row!), secret };
}

export async function updateKey(
  teamId: string,
  id: string,
  patch: { name?: string; scope?: KeyScope; allowedAccountIds?: number[] | null },
): Promise<ApiKey> {
  const active = and(eq(apiKey.id, id), eq(apiKey.teamId, teamId), isNull(apiKey.revokedAt));
  if (Object.keys(patch).length === 0) {
    const [row] = await db.select().from(apiKey).where(active).limit(1);
    if (!row) throw notFound();
    return toApiKey(row);
  }
  const [row] = await db.update(apiKey).set(patch).where(active).returning();
  if (!row) throw notFound();
  return toApiKey(row);
}

export async function revokeKey(teamId: string, id: string): Promise<void> {
  const rows = await db
    .update(apiKey)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKey.id, id), eq(apiKey.teamId, teamId), isNull(apiKey.revokedAt)))
    .returning({ id: apiKey.id });
  if (rows.length === 0) throw notFound();
}
