import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { accountWorkspace, teamBackend } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import { assertTeamLinked } from '../../lib/team-link.js';
import type { Actor } from '../../plugins/actor.js';

// Account ownership (`account_workspace`, one workspace per account): the tenancy boundary between workspaces on one
// upstream. A workspace sees and uses only the accounts it owns.

/**
 * Records that `accountId` belongs to the linked workspace `teamId`: a dashboard connect, and the operator's
 * `analytics:claim` / `analytics:backfill` for an account connected outside the dashboard. Idempotent; 409
 * `team_not_linked` for an unlinked workspace, 409 `account_workspace_conflict` when another workspace owns it.
 */
export async function claimAccount(teamId: string, accountId: number): Promise<void> {
  await assertTeamLinked(teamId);
  await db.insert(accountWorkspace).values({ accountId, teamId }).onConflictDoNothing();
  await assertNotOwnedElsewhere(teamId, accountId);
}

/** 409 `account_workspace_conflict` when a workspace other than `teamId` owns `accountId`. */
export async function assertNotOwnedElsewhere(teamId: string, accountId: number): Promise<void> {
  const owner = await accountOwner(accountId);
  if (owner && owner.teamId !== teamId) {
    throw new AppError(409, 'account_workspace_conflict', `Account ${accountId} belongs to another workspace`);
  }
}

/** The accounts workspace `teamId` owns. */
export async function ownedAccountIds(teamId: string): Promise<number[]> {
  const rows = await db.select({ id: accountWorkspace.accountId }).from(accountWorkspace).where(eq(accountWorkspace.teamId, teamId));
  return rows.map((r) => r.id);
}

/** The workspace that owns `accountId` and whether it is linked, or null when no workspace owns it. */
export async function accountOwner(accountId: number): Promise<{ teamId: string; linked: boolean } | null> {
  const [row] = await db
    .select({ teamId: accountWorkspace.teamId, linked: teamBackend.teamId })
    .from(accountWorkspace)
    .leftJoin(teamBackend, eq(teamBackend.teamId, accountWorkspace.teamId))
    .where(eq(accountWorkspace.accountId, accountId));
  return row ? { teamId: row.teamId, linked: row.linked !== null } : null;
}

const notAllowed = (accountId: number, why: string) => new AppError(403, 'account_not_allowed', `Account ${accountId} ${why}`);

/** 403 `account_not_allowed` unless workspace `teamId` owns `accountId` (unknown and foreign accounts alike). */
export async function assertAccountOwned(teamId: string, accountId: number): Promise<void> {
  if ((await accountOwner(accountId))?.teamId !== teamId) throw notAllowed(accountId, 'is not owned by this workspace');
}

/** The one account check of the `/v1` routes: 403 `account_not_allowed` outside the key's allowlist or the workspace. */
export async function assertAccountAllowed(actor: Actor, accountId: number): Promise<void> {
  if (actor.accountIds && !actor.accountIds.includes(accountId)) throw notAllowed(accountId, 'is not in this API key\'s allowlist');
  await assertAccountOwned(actor.teamId, accountId);
}
