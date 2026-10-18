// Team wire types (plan-team), re-exported from contracts.ts so apps/web sees them via `@api/contracts`.
import { z } from 'zod';

/** What a team member may use (plan-team §1.4, §2.2); the owner and API keys may use everything. */
export const memberFeature = z.enum(['chats', 'mass_messages', 'vault', 'fans', 'stats', 'promo', 'settings']);
export type MemberFeature = z.infer<typeof memberFeature>;
export const memberRole = z.enum(['owner', 'member']);
export type MemberRole = z.infer<typeof memberRole>;

/** A member's creators (null = every account the workspace owns, [] = none) and features, as answered. */
export const memberPermissions = z.object({
  allowedAccountIds: z.array(z.number().int()).nullable(),
  features: z.array(memberFeature),
});
export type MemberPermissions = z.infer<typeof memberPermissions>;

/** The stored features that are in the enum; anything else grants nothing (fail closed). */
export function knownFeatures(list: string[]): MemberFeature[] {
  return list.filter((f): f is MemberFeature => memberFeature.safeParse(f).success);
}

/**
 * A member row's role and permissions as enforced (plan-team §1.4): the owner may use everything; any other role is a
 * member with only its `knownFeatures`.
 */
export function effectivePermissions(row: {
  role: string;
  allowedAccountIds: number[] | null;
  features: string[];
}): MemberPermissions & { role: MemberRole } {
  if (row.role === 'owner') return { role: 'owner', allowedAccountIds: null, features: [...memberFeature.options] };
  return { role: 'member', allowedAccountIds: row.allowedAccountIds, features: knownFeatures(row.features) };
}

/** The permissions an owner sends: explicit choices, so an omitted field never means "everything". */
const permissionsInput = z.object({
  allowedAccountIds: z.array(z.number().int().positive()).nullable(),
  /** Duplicates dropped, in the enum's order. */
  features: z.array(memberFeature).transform((list) => memberFeature.options.filter((f) => list.includes(f))),
});

export const teamMember = memberPermissions.extend({
  /** The member row's id. */
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  /** The sign-in username as entered (null for an owner who signed up by email). */
  username: z.string().nullable(),
  /** The owner's only; a member's email is a synthetic one and never shown. */
  email: z.string().nullable(),
  role: memberRole,
  createdAt: z.string(),
});
export type TeamMember = z.infer<typeof teamMember>;
export const teamMemberList = z.object({ items: z.array(teamMember) });

/** An omitted field is left unchanged; at least one is needed. */
export const updateMemberBody = permissionsInput
  .partial()
  .refine((b) => b.allowedAccountIds !== undefined || b.features !== undefined, 'Send allowedAccountIds, features or both');
export type UpdateMemberBody = z.input<typeof updateMemberBody>;

export const teamInvite = memberPermissions.extend({ id: z.string(), createdAt: z.string(), expiresAt: z.string() });
export type TeamInvite = z.infer<typeof teamInvite>;
export const teamInviteList = z.object({ items: z.array(teamInvite) });

/** Both fields required: `allowedAccountIds: null` is every creator, `[]` none. */
export const createInviteBody = permissionsInput;
export type CreateInviteBody = z.input<typeof createInviteBody>;
/** `url` (`<APP_URL>/invite/<token>`) is shown once: only the token's hash is stored. */
export const createdInvite = z.object({ invite: teamInvite, url: z.string() });
export type CreatedInvite = z.infer<typeof createdInvite>;

/** What the invite page shows before the invitee signs up. */
export const invitePreview = z.object({ workspace: z.object({ name: z.string() }), expiresAt: z.string() });
export type InvitePreview = z.infer<typeof invitePreview>;

/** `GET /api/me`: the signed-in user's role and permissions (any role), for the dashboard's layout. */
export const me = memberPermissions.extend({ role: memberRole, workspace: z.object({ name: z.string() }) });
export type Me = z.infer<typeof me>;

/** better-auth's username plugin defaults (3 to 30 of `[a-zA-Z0-9_.]`) and password bounds (8 to 128). */
export const acceptInviteBody = z.object({
  username: z
    .string()
    .min(3)
    .max(30)
    .regex(/^[a-zA-Z0-9_.]+$/, 'Use letters, digits, `_` and `.` only'),
  password: z.string().min(8).max(128),
});
export type AcceptInviteBody = z.infer<typeof acceptInviteBody>;
