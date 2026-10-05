import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { organization } from 'better-auth/plugins/organization';
import { eq, TransactionRollbackError } from 'drizzle-orm';
import { z } from 'zod';
import { db } from './db/index.js';
import * as schema from './db/schema.js';
import { appOrigin, env } from './env.js';
import { randomBase62 } from './lib/ids.js';
import { sendMail } from './lib/mailer.js';

/** Header the Fastify bridge sets to the resolved client IP; client-sent values are dropped. */
export const CLIENT_IP_HEADER = 'x-gateway-client-ip';

/** The user's one workspace membership (unique on `member.user_id`), or undefined. */
async function findMembership(userId: string) {
  const [m] = await db
    .select({ organizationId: schema.member.organizationId, role: schema.member.role })
    .from(schema.member)
    .where(eq(schema.member.userId, userId))
    .limit(1);
  return m;
}

/**
 * One workspace (better-auth "organization") per user. Runs right after sign-up and again on each dashboard session
 * load, so a failed sign-up insert cannot leave the user without one. Idempotent and race-safe: the unique index on
 * `member.user_id` lets exactly one concurrent caller insert; the others roll back their organization row.
 */
export async function ensureWorkspace(user: { id: string; name: string; email: string }) {
  const existing = await findMembership(user.id);
  if (existing) return existing;
  const base = (user.name || user.email.split('@')[0] || 'workspace').trim();
  const slug = `${base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'ws'}-${randomBase62(6).toLowerCase()}`;
  const orgId = crypto.randomUUID();
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
      // Sign-up creates the session before this runs. With one membership per user any other active id is stale
      // (it has no FK, so it survives an org delete): point every session of the user at this workspace.
      await tx.update(schema.session).set({ activeOrganizationId: orgId }).where(eq(schema.session.userId, user.id));
    });
  } catch (err) {
    if (!(err instanceof TransactionRollbackError)) throw err;
  }
  const created = await findMembership(user.id);
  if (!created) throw new Error(`workspace for user ${user.id} was not created`);
  return created;
}

/**
 * Refuses organization writes through the auth API (create, delete, invite, accept, members, roles, teams,
 * set-active, leave), so a user can never gain a second membership. Renaming the workspace (Settings) is the one
 * allowed write; the slug stays fixed because `link-team` matches on it.
 */
export const ORG_WRITE_REFUSED = 'Workspaces and memberships cannot be changed through the auth API';
const renameOnly = z.object({ data: z.object({ name: z.string() }).strict() });

const blockOrganizationWrites = createAuthMiddleware(async (ctx) => {
  if (!ctx.path.startsWith('/organization/') || ctx.request?.method === 'GET') return;
  if (ctx.path === '/organization/update' && renameOnly.safeParse(ctx.body).success) return;
  throw new APIError('FORBIDDEN', { message: ORG_WRITE_REFUSED });
});

/**
 * better-auth serves the verification link from BETTER_AUTH_URL and redirects to its callbackURL, `/` when the
 * client sent none. Point that default at the dashboard's /login (on APP_URL, so it also works when the API and the
 * dashboard are on different origins in dev): after verification the user is signed in and /login forwards to `/`;
 * an expired or invalid link arrives as `/login?error=TOKEN_EXPIRED|INVALID_TOKEN|USER_NOT_FOUND`, where the page
 * offers a resend.
 */
function verificationLink(url: string) {
  const link = new URL(url);
  const callback = link.searchParams.get('callbackURL');
  link.searchParams.set('callbackURL', new URL(!callback || callback === '/' ? '/login' : callback, env.APP_URL).toString());
  return link.toString();
}

export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  basePath: '/api/auth',
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [appOrigin],
  database: drizzleAdapter(db, { provider: 'pg', schema }),
  emailAndPassword: { enabled: true, requireEmailVerification: true },
  emailVerification: {
    // Sent on sign-up because requireEmailVerification is on.
    autoSignInAfterVerification: true,
    expiresIn: 3600,
    sendVerificationEmail: async ({ user, url }) => {
      const link = verificationLink(url);
      await sendMail({
        to: user.email,
        subject: 'Verify your email address',
        text: `Confirm your email address to finish signing up:\n\n${link}\n\nThe link expires in 1 hour. If you did not sign up, ignore this email.`,
        html: `<p>Confirm your email address to finish signing up:</p><p><a href="${link.replaceAll('&', '&amp;')}">Verify email</a></p><p>The link expires in 1 hour. If you did not sign up, ignore this email.</p>`,
      });
    },
  },
  advanced: {
    // better-auth skips its Origin check under NODE_ENV=test by default; keep it on everywhere so tests cover it.
    disableOriginCheck: false,
    // Set by the Fastify bridge from request.ip (plugins/session.ts).
    ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
  },
  plugins: [organization({ allowUserToCreateOrganization: false, disableOrganizationDeletion: true })],
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
        // Later sign-ins: start the new session in the user's workspace.
        before: async (session) => {
          const m = await findMembership(session.userId);
          return { data: { ...session, activeOrganizationId: m?.organizationId ?? null } };
        },
      },
    },
  },
});
