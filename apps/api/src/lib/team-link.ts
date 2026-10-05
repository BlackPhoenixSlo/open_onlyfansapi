import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { teamBackend } from '../db/schema.js';
import { AppError } from './errors.js';

/** Whether the operator ran `link-team <slug>` for this workspace. */
export async function isTeamLinked(teamId: string): Promise<boolean> {
  const [row] = await db
    .select({ teamId: teamBackend.teamId })
    .from(teamBackend)
    .where(eq(teamBackend.teamId, teamId))
    .limit(1);
  return row !== undefined;
}

/**
 * The workspace gate: a workspace reaches the upstream only after the operator ran `link-team <slug>`.
 * Sign-up is open, so the link is the approval step. Throws 409 `team_not_linked` when it is missing.
 */
export async function assertTeamLinked(teamId: string): Promise<void> {
  if (!(await isTeamLinked(teamId))) throw new AppError(409, 'team_not_linked', 'This workspace is not linked to the upstream yet');
}
