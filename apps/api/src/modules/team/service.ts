import { and, asc, desc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { auth, memberEmail, type Membership } from '../../auth.js';
import { db } from '../../db/index.js';
import { account, member, organization, teamInvite, user } from '../../db/schema.js';
import {
  effectivePermissions,
  knownFeatures,
  type AcceptInviteBody,
  type Me,
  type MemberPermissions,
  type TeamInvite,
  type TeamMember,
} from '../../contracts.js';
import { env } from '../../env.js';
import { AppError, cause } from '../../lib/errors.js';
import { newId, randomBase62 } from '../../lib/ids.js';
import { hashKey } from '../../plugins/actor.js';
import { assertAllowlistOwned } from '../accounts/ownership.js';

// Team members and invite links (plan-team). A member is a user whose one membership is in the owner's workspace,
// with role `member` and the permissions copied from the invite they accepted.

/** How long an invite link stays usable. */
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

const memberColumns = {
  id: member.id,
  userId: member.userId,
  role: member.role,
  allowedAccountIds: member.allowedAccountIds,
  features: member.features,
  createdAt: member.createdAt,
  name: user.name,
  username: user.displayUsername,
  email: user.email,
};

const selectMembers = (where: SQL | undefined) =>
  db.select(memberColumns).from(member).innerJoin(user, eq(user.id, member.userId)).where(where);
type MemberRow = Awaited<ReturnType<typeof selectMembers>>[number];

/** The row's permissions as the session enforces them (`effectivePermissions`). */
function toMember(row: MemberRow): TeamMember {
  const permissions = effectivePermissions(row);
  return {
    ...permissions,
    id: row.id,
    userId: row.userId,
    name: row.name,
    username: row.username ?? null,
    email: permissions.role === 'owner' ? row.email : null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toInvite(row: typeof teamInvite.$inferSelect): TeamInvite {
  return {
    id: row.id,
    allowedAccountIds: row.allowedAccountIds,
    features: knownFeatures(row.features),
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

const memberNotFound = () => new AppError(404, 'not_found', 'Team member not found');

/** `GET /api/me`: a signed-in user's role and permissions as enforced, and their workspace's name. */
export async function describeMembership(membership: Membership): Promise<Me> {
  const [workspace] = await db
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, membership.organizationId));
  if (!workspace) throw new AppError(404, 'not_found', 'Workspace not found');
  return { ...effectivePermissions(membership), workspace };
}

/** The workspace's members, the owner first. */
export async function listMembers(teamId: string): Promise<TeamMember[]> {
  const rows = await selectMembers(eq(member.organizationId, teamId)).orderBy(
    sql`${member.role} = 'owner' desc`,
    asc(member.createdAt),
  );
  return rows.map(toMember);
}

/** Edits a member's permissions; effective on their next request (the session reads the row each time). */
export async function updateMember(teamId: string, id: string, patch: Partial<MemberPermissions>): Promise<TeamMember> {
  if (patch.allowedAccountIds) await assertAllowlistOwned(teamId, patch.allowedAccountIds);
  const editable = and(eq(member.id, id), eq(member.organizationId, teamId), ne(member.role, 'owner'));
  await db.update(member).set(patch).where(editable);
  const [row] = await selectMembers(editable);
  if (!row) throw memberNotFound();
  return toMember(row);
}

/** Removes a member: deleting the user cascades its membership, sessions and credential. Never the owner. */
export async function removeMember(teamId: string, id: string): Promise<void> {
  const target = db
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.id, id), eq(member.organizationId, teamId), ne(member.role, 'owner')));
  const deleted = await db.delete(user).where(inArray(user.id, target)).returning({ id: user.id });
  if (deleted.length === 0) throw memberNotFound();
}

/** The one definition of a usable invite: not used, not revoked, not expired by the database's clock. */
const isPending = sql`(${teamInvite.usedAt} is null and ${teamInvite.revokedAt} is null and ${teamInvite.expiresAt} > now())`;
const pending = (teamId: string) => and(eq(teamInvite.teamId, teamId), isPending);

/** The workspace's pending invites (not used, revoked or expired), newest first. */
export async function listInvites(teamId: string): Promise<TeamInvite[]> {
  const rows = await db.select().from(teamInvite).where(pending(teamId)).orderBy(desc(teamInvite.createdAt));
  return rows.map(toInvite);
}

/** Creates an invite; the link (with the only copy of the token) is returned once. */
export async function createInvite(
  teamId: string,
  createdBy: string,
  input: MemberPermissions,
): Promise<{ invite: TeamInvite; url: string }> {
  await assertAllowlistOwned(teamId, input.allowedAccountIds ?? []);
  const token = randomBase62(32);
  const [row] = await db
    .insert(teamInvite)
    .values({
      id: newId('inv'),
      teamId,
      tokenHash: hashKey(token),
      allowedAccountIds: input.allowedAccountIds,
      features: input.features,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      createdBy,
    })
    .returning();
  return { invite: toInvite(row!), url: new URL(`/invite/${token}`, env.APP_URL).toString() };
}

export async function revokeInvite(teamId: string, id: string): Promise<void> {
  const rows = await db
    .update(teamInvite)
    .set({ revokedAt: new Date() })
    .where(and(eq(teamInvite.id, id), pending(teamId)))
    .returning({ id: teamInvite.id });
  if (rows.length === 0) throw new AppError(404, 'not_found', 'Pending invite not found');
}

/** Why an invite is not pending: 404 unknown; 410 used, revoked or else expired. */
function refusalOf(invite: { usedAt: Date | null; revokedAt: Date | null } | undefined): AppError {
  if (!invite) return new AppError(404, 'invite_not_found', 'This invite link is not valid');
  if (invite.usedAt) return new AppError(410, 'invite_used', 'This invite link has already been used');
  if (invite.revokedAt) return new AppError(410, 'invite_revoked', 'This invite link was revoked');
  return new AppError(410, 'invite_expired', 'This invite link has expired');
}

/** What the invite page shows before sign-up; the errors of `refusalOf`. */
export async function previewInvite(token: string): Promise<{ workspace: { name: string }; expiresAt: string }> {
  const [row] = await db
    .select({
      workspace: organization.name,
      expiresAt: teamInvite.expiresAt,
      usedAt: teamInvite.usedAt,
      revokedAt: teamInvite.revokedAt,
      pending: sql<boolean>`${isPending}`,
    })
    .from(teamInvite)
    .innerJoin(organization, eq(organization.id, teamInvite.teamId))
    .where(eq(teamInvite.tokenHash, hashKey(token)))
    .limit(1);
  if (!row?.pending) throw refusalOf(row);
  return { workspace: { name: row.workspace }, expiresAt: row.expiresAt.toISOString() };
}

/**
 * Signs up a member through an invite (plan-team §1.3), outside better-auth's sign-up, so `REGISTRATION_OPEN` does not
 * apply and its user hook (`ensureWorkspace`) does not create a workspace. The claim is one conditional UPDATE, so
 * concurrent accepts of one token give one member; the user, credential and member rows are inserted in the same
 * transaction, and a taken username rolls everything back, leaving the invite usable.
 */
export async function acceptInvite(token: string, body: AcceptInviteBody): Promise<{ username: string }> {
  const username = body.username.toLowerCase();
  const tokenHash = hashKey(token);
  // Refuse a link that is not pending before the password hash: scrypt runs on the libuv pool the upstream's DNS
  // lookups share, and this route takes no session. The conditional UPDATE below stays the real guard.
  await previewInvite(token);
  const passwordHash = await (await auth.$context).password.hash(body.password);
  try {
    await db.transaction(async (tx) => {
      const [invite] = await tx
        .update(teamInvite)
        .set({ usedAt: sql`now()` })
        .where(and(eq(teamInvite.tokenHash, tokenHash), isPending))
        .returning();
      if (!invite) {
        const [row] = await tx.select().from(teamInvite).where(eq(teamInvite.tokenHash, tokenHash));
        throw refusalOf(row);
      }
      const now = new Date();
      const userId = crypto.randomUUID();
      await tx.insert(user).values({
        id: userId,
        name: body.username,
        email: memberEmail(userId),
        username,
        displayUsername: body.username,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(account).values({
        id: crypto.randomUUID(),
        accountId: userId,
        providerId: 'credential',
        userId,
        password: passwordHash,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(member).values({
        id: crypto.randomUUID(),
        organizationId: invite.teamId,
        userId,
        role: 'member',
        allowedAccountIds: invite.allowedAccountIds,
        features: invite.features,
        createdAt: now,
      });
    });
  } catch (err) {
    // The username is taken (`user.username` is unique); the claim rolls back with it.
    if ((cause(err) as { code?: string }).code === '23505') throw usernameTaken();
    throw err;
  }
  return { username: body.username };
}

const usernameTaken = () => new AppError(409, 'username_taken', 'That username is taken');
