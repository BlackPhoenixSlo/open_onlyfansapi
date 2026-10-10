import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { teamBackend } from '../db/schema.js';
import { AppError } from './errors.js';

/**
 * Marks the workspace as allowed to reach the upstream. Sign-up calls it for every new workspace (`ensureWorkspace`);
 * `link-team <slug>` calls it to repair one that was left unlinked. Idempotent: a repeat refreshes `linked_at`.
 */
export async function linkTeam(teamId: string): Promise<void> {
  await db
    .insert(teamBackend)
    .values({ teamId })
    .onConflictDoUpdate({ target: teamBackend.teamId, set: { linkedAt: new Date() } });
}

/** Whether the workspace is linked to the upstream (on creation, or later by `link-team <slug>`). */
export async function isTeamLinked(teamId: string): Promise<boolean> {
  const [row] = await db
    .select({ teamId: teamBackend.teamId })
    .from(teamBackend)
    .where(eq(teamBackend.teamId, teamId))
    .limit(1);
  return row !== undefined;
}

/**
 * The workspace gate: a workspace reaches the upstream only once linked. New workspaces are linked on creation; one
 * whose link failed or was removed stays out until the operator runs `link-team <slug>`.
 * Throws 409 `team_not_linked` when the link is missing.
 */
export async function assertTeamLinked(teamId: string): Promise<void> {
  if (!(await isTeamLinked(teamId))) throw new AppError(409, 'team_not_linked', 'This workspace is not linked to the upstream yet');
}
