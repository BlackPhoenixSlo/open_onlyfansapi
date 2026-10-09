import { eq, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { statsConfig as statsConfigTable } from '../../db/schema.js';
import type { PutStatsConfigBody, StatsConfig } from '../../contracts.js';
import { AppError } from '../../lib/errors.js';

type Row = typeof statsConfigTable.$inferSelect;

const toWire = ({ teamId: _teamId, updatedAt, ...rest }: Row): StatsConfig => ({ ...rest, updatedAt: updatedAt.toISOString() });

/**
 * The IANA name Intl resolves `tz` to; 400 when it knows no such zone or `tz` is an offset like `+02:00`, which Node
 * and Postgres read with opposite signs (Postgres takes `+02:00` as POSIX, two hours west of UTC).
 */
export function resolveTimezone(tz: string): string {
  if (/^[+-]/.test(tz)) {
    throw new AppError(400, 'validation_error', `\`timezone\` ${JSON.stringify(tz)} is an offset; use an IANA name like Europe/Ljubljana`);
  }
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    throw new AppError(400, 'validation_error', `\`timezone\` ${JSON.stringify(tz)} is not a known time zone`);
  }
}

/** Workspace `teamId`'s stats config; the default row (§4.5) is made on first read. */
export async function getStatsConfig(teamId: string): Promise<StatsConfig> {
  await db.insert(statsConfigTable).values({ teamId }).onConflictDoNothing();
  const [row] = await db.select().from(statsConfigTable).where(eq(statsConfigTable.teamId, teamId));
  return toWire(row!);
}

/** Changes the given fields only and bumps the version. `sla` may not exceed `reply_cap`. */
export async function putStatsConfig(teamId: string, body: PutStatsConfigBody): Promise<StatsConfig> {
  const current = await getStatsConfig(teamId);
  const next = { ...body, ...(body.timezone !== undefined && { timezone: resolveTimezone(body.timezone) }) };
  if ((next.slaSeconds ?? current.slaSeconds) > (next.replyCapSeconds ?? current.replyCapSeconds)) {
    throw new AppError(400, 'invalid_config', '`slaSeconds` must not exceed `replyCapSeconds`');
  }
  const [row] = await db
    .update(statsConfigTable)
    .set({ ...next, version: sql`${statsConfigTable.version} + 1`, updatedAt: new Date() })
    .where(eq(statsConfigTable.teamId, teamId))
    .returning();
  return toWire(row!);
}
