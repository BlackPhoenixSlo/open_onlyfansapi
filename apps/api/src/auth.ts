import { betterAuth, type BetterAuthPlugin } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { organization } from 'better-auth/plugins/organization';
import { username } from 'better-auth/plugins/username';
import { eq, TransactionRollbackError } from 'drizzle-orm';
import { z } from 'zod';
import { effectivePermissions } from './contracts.js';
import { db } from './db/index.js';
import * as schema from './db/schema.js';
import { appOrigin, env } from './env.js';
import { randomBase62 } from './lib/ids.js';
import { sendMail, type Mail } from './lib/mailer.js';
import { linkTeam } from './lib/team-link.js';

/** Header the Fastify bridge sets to the resolved client IP; client-sent values are dropped. */
export const CLIENT_IP_HEADER = 'x-gateway-client-ip';

/**
 * A team member's `user.email`: better-auth needs a unique one, members have none (RFC 2606 reserves `.invalid`). It is
 * derived from the user id, so a username never goes stale in it; public sign-up refuses the domain (below).
 */
const MEMBER_EMAIL_DOMAIN = 'members.invalid';
export const memberEmail = (userId: string) => `${userId}@${MEMBER_EMAIL_DOMAIN}`;
const isMemberEmail = (email: string) => email.toLowerCase().endsWith(`@${MEMBER_EMAIL_DOMAIN}`);

/** The user's one workspace membership (unique on `member.user_id`) with its permissions, or undefined. */
async function findMembership(userId: string) {
  const [m] = await db
    .select({
      organizationId: schema.member.organizationId,
      role: schema.member.role,
      allowedAccountIds: schema.member.allowedAccountIds,
      features: schema.member.features,
    })
    .from(schema.member)
    .where(eq(schema.member.userId, userId))
    .limit(1);
  return m;
}

/** A user's membership row, as `findMembership`, `ensureWorkspace` and `sessionMembership` return it. */
export type Membership = NonNullable<Awaited<ReturnType<typeof findMembership>>>;

/**
 * One workspace (better-auth "organization") per user. Runs right after sign-up and again on each dashboard session
 * load, so a failed sign-up insert cannot leave the user without one. Never for a team member (see
 * `sessionMembership`). Idempotent and race-safe: the unique index on `member.user_id` lets exactly one concurrent
 * caller insert; the others roll back their organization row.
 * The caller that created the workspace then links it to the upstream. A failed link is logged, not thrown, so sign-up
 * still succeeds; the workspace stays unlinked until the operator runs `link-team <slug>`.
 */
export async function ensureWorkspace(user: { id: string; name: string; email: string }) {
  const existing = await findMembership(user.id);
  if (existing) return existing;
  const base = (user.name || user.email.split('@')[0] || 'workspace').trim();
  const slug = `${base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'ws'}-${randomBase62(6).toLowerCase()}`;
  const orgId = crypto.randomUUID();
  let created = false;
  try {
    await db.transaction(async (tx) => {
      await tx.insert(schema.organization).values({ id: orgId, name: `${base}'s workspace`, slug, createdAt: new Date() });
      const inserted = await tx
        .insert(schema.member)
        .values({ id: crypto.randomUUID(), organizationId: orgId, userId: user.id, role: 'owner', createdAt: new Date() })
        .onConflictDoNothing({ target: schema.member.userId })
        .returning({ id: schema.member.id });
      // Another request created the membership first: drop this organization row.
      if (inserted.length === 0) tx.rollback();
      // Sign-up creates its session after this runs (session.create.before below sets its active workspace). With one
      // membership per user any other active id is stale (it has no FK, so it survives an org delete): point every
      // existing session of the user at this workspace.
      await tx.update(schema.session).set({ activeOrganizationId: orgId }).where(eq(schema.session.userId, user.id));
    });
    created = true;
  } catch (err) {
    if (!(err instanceof TransactionRollbackError)) throw err;
  }
  if (created) {
    try {
      await linkTeam(orgId);
    } catch (err) {
      console.error(`workspace ${slug} (${orgId}) was not linked to the upstream; run link-team ${slug}:`, err);
    }
  }
  const membership = await findMembership(user.id);
  if (!membership) throw new Error(`workspace for user ${user.id} was not created`);
  return membership;
}

/**
 * A signed-in user's membership. A team member whose row is gone gets none (the caller answers 401: fail closed)
 * instead of a workspace of their own; anyone else's missing workspace is created.
 */
export async function sessionMembership(user: { id: string; name: string; email: string }) {
  return isMemberEmail(user.email) ? findMembership(user.id) : ensureWorkspace(user);
}

/**
 * Refuses organization writes through the auth API (create, delete, invite, accept, members, roles, teams,
 * set-active, leave), so a user can never gain a second membership. Renaming the workspace (Settings) is the one
 * allowed write; the slug stays fixed because `link-team` matches on it. Organization reads and the rename are the
 * owner's: a member's read would list every member's permissions and the owner's email (plan-team §1.6).
 */
export const ORG_API_REFUSED = 'Only the workspace owner may read or rename the workspace through the auth API';
const renameOnly = z.object({ data: z.object({ name: z.string() }).strict() });

const blockOrganizationWrites = createAuthMiddleware(async (ctx) => {
  if (!ctx.path.startsWith('/organization/')) return;
  const read = ctx.request?.method === 'GET';
  if (!read && !(ctx.path === '/organization/update' && renameOnly.safeParse(ctx.body).success)) {
    throw new APIError('FORBIDDEN', { message: ORG_API_REFUSED });
  }
  const session = await getSessionFromCtx(ctx);
  const membership = session && (await findMembership(session.user.id));
  if (!membership || effectivePermissions(membership).role !== 'owner') {
    throw new APIError('FORBIDDEN', { message: ORG_API_REFUSED });
  }
});

export const USERNAME_IMMUTABLE = 'Usernames cannot be changed';
export const MEMBER_EMAIL_REFUSED = `Emails at ${MEMBER_EMAIL_DOMAIN} are reserved for team members`;
export const SIGNUP_USERNAME_REFUSED = 'Usernames are set by a team invite, not at sign-up';

/**
 * A username is set once, by the invite: `/update-user` cannot change it (or the display form the Team page shows),
 * and public sign-up can neither set one nor take a member email.
 */
const memberIdentityGuard = {
  id: 'member-identity-guard',
  hooks: {
    before: [
      {
        matcher: (ctx) => ctx.path === '/update-user' || ctx.path === '/sign-up/email',
        handler: createAuthMiddleware(async (ctx) => {
          const body = (ctx.body ?? {}) as Record<string, unknown>;
          if (ctx.path === '/update-user' && ('username' in body || 'displayUsername' in body)) {
            throw new APIError('FORBIDDEN', { message: USERNAME_IMMUTABLE });
          }
          if (ctx.path !== '/sign-up/email') return;
          if ('username' in body || 'displayUsername' in body) {
            throw new APIError('FORBIDDEN', { message: SIGNUP_USERNAME_REFUSED, code: 'USERNAME_SET_BY_INVITE' });
          }
          if (typeof body.email === 'string' && isMemberEmail(body.email)) {
            throw new APIError('FORBIDDEN', { message: MEMBER_EMAIL_REFUSED });
          }
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin;

/**
 * The dashboard page a reset token is used on, rather than better-auth's `url` (on BETTER_AUTH_URL, which can be a
 * different origin from the dashboard in dev). The page posts the token to /reset-password.
 */
export function resetPasswordLink(token: string): string {
  return new URL(`/reset-password?token=${encodeURIComponent(token)}`, env.APP_URL).toString();
}

type ResetDelivery = (reset: { mail: Mail; link: string }) => void;
// Not awaited: better-auth answers an unknown email at once, so waiting on SMTP here would reveal which exist.
let deliverReset: ResetDelivery = ({ mail }) => {
  void sendMail(mail).catch((err) => console.error('reset mail failed', err));
};

/** Replaces how a reset is delivered (the reset-link CLI prints the link instead of mailing it). */
export function setResetDelivery(next: ResetDelivery): void {
  deliverReset = next;
}

export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  basePath: '/api/auth',
  // username()'s unauthenticated availability check would enumerate member usernames; nothing here uses it.
  disabledPaths: ['/is-username-available'],
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [appOrigin],
  database: drizzleAdapter(db, { provider: 'pg', schema }),
  emailAndPassword: {
    enabled: true,
    // REGISTRATION_OPEN=false: /sign-up/email is refused; existing users still sign in.
    disableSignUp: !env.REGISTRATION_OPEN,
    // A reset signs the user out everywhere, so a session taken over with the old password ends.
    revokeSessionsOnPasswordReset: true,
    // The mail below says "1 hour": change both together.
    resetPasswordTokenExpiresIn: 3600,
    sendResetPassword: async ({ user, token }) => {
      const link = resetPasswordLink(token);
      const intro = 'Someone asked to reset the password for this account. Choose a new password:';
      const outro = 'The link expires in 1 hour. If you did not request this, ignore this email.';
      deliverReset({
        link,
        mail: {
          to: user.email,
          subject: 'Reset your password',
          text: `${intro}\n\n${link}\n\n${outro}`,
          html: `<p>${intro}</p><p><a href="${link.replaceAll('&', '&amp;')}">Reset password</a></p><p>${outro}</p>`,
        },
      });
    },
  },
  advanced: {
    // better-auth skips its Origin check under NODE_ENV=test by default; keep it on everywhere so tests cover it.
    disableOriginCheck: false,
    // Set by the Fastify bridge from request.ip (plugins/session.ts).
    ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
  },
  plugins: [
    organization({
      allowUserToCreateOrganization: false,
      disableOrganizationDeletion: true,
      // A member's permissions (plan-team §1.4); set only by the team routes, never through the auth API. The owner's
      // row ignores both.
      schema: {
        member: {
          additionalFields: {
            /** null = every account the workspace owns */
            allowedAccountIds: { type: 'number[]', required: false, input: false },
            features: { type: 'string[]', required: true, defaultValue: [], input: false },
          },
        },
      },
    }),
    // Before username(): its sign-up hook would otherwise answer a taken or invalid username with its own 400.
    memberIdentityGuard,
    // Members sign in with a username (plan-team §1.2); their email is the synthetic, unused `memberEmail(id)`
    // (modules/team/service.ts, which also signs them up).
    username(),
  ],
  hooks: { before: blockOrganizationWrites },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          await ensureWorkspace(user);
        },
      },
    },
    session: {
      create: {
        // Sign-up and every later sign-in: start the new session in the user's workspace.
        before: async (session) => {
          const m = await findMembership(session.userId);
          return { data: { ...session, activeOrganizationId: m?.organizationId ?? null } };
        },
      },
    },
  },
});
