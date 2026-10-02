import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { organization } from 'better-auth/plugins/organization';
import { and, eq, isNull, TransactionRollbackError } from 'drizzle-orm';
import { db } from './db/index.js';
import * as schema from './db/schema.js';
import { appOrigin, env } from './env.js';
import { randomBase62 } from './lib/ids.js';

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
      // Sign-up creates the session before this runs; a session with no workspace yet gets this one.
      await tx
        .update(schema.session)
        .set({ activeOrganizationId: orgId })
        .where(and(eq(schema.session.userId, user.id), isNull(schema.session.activeOrganizationId)));
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
const blockOrganizationWrites = createAuthMiddleware(async (ctx) => {
  if (!ctx.path.startsWith('/organization/') || ctx.request?.method === 'GET') return;
  const data = (ctx.body as { data?: Record<string, unknown> } | undefined)?.data;
  if (ctx.path === '/organization/update' && data && Object.keys(data).every((k) => k === 'name')) return;
  throw new APIError('FORBIDDEN', { message: 'Workspaces and memberships cannot be changed through the auth API' });
});

export const auth = betterAuth({
  baseURL: env.BETTER_AUTH_URL,
  basePath: '/api/auth',
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [appOrigin],
  database: drizzleAdapter(db, { provider: 'pg', schema }),
  emailAndPassword: { enabled: true },
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
