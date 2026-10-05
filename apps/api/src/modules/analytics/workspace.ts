import { and, arrayContains, eq, isNull } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { accountWorkspace, apiKey } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import { assertTeamLinked } from '../../lib/team-link.js';

/**
 * Records that `accountId` belongs to workspace `teamId` (spec §4.1). The workspace must be linked and name the
 * account in a live key's allowlist; an account named by another workspace's keys, or already owned by another
 * workspace, is a config error (409 `account_workspace_conflict`).
 */
export async function claimAccount(teamId: string, accountId: number): Promise<void> {
  await assertTeamLinked(teamId);
  const keys = await db
    .selectDistinct({ teamId: apiKey.teamId })
    .from(apiKey)
    .where(and(isNull(apiKey.revokedAt), arrayContains(apiKey.allowedAccountIds, [accountId])));
  const teams = keys.map((k) => k.teamId);
  if (!teams.includes(teamId)) {
    throw new AppError(403, 'account_not_allowed', `No key of this workspace lists account ${accountId}`);
  }
  if (teams.length > 1) {
    throw new AppError(409, 'account_workspace_conflict', `Account ${accountId} is named by more than one workspace's keys`);
  }
  await db.insert(accountWorkspace).values({ accountId, teamId }).onConflictDoNothing();
  const [row] = await db.select().from(accountWorkspace).where(eq(accountWorkspace.accountId, accountId));
  if (row?.teamId !== teamId) {
    throw new AppError(409, 'account_workspace_conflict', `Account ${accountId} belongs to another workspace`);
  }
}
