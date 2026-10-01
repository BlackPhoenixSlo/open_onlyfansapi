import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins/organization';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from './db/index.js';
import * as schema from './db/schema.js';
import { appOrigin, env } from './env.js';
import { randomBase62 } from './lib/ids.js';

/** Header the Fastify bridge sets to the resolved client IP; client-sent values are dropped. */
export const CLIENT_IP_HEADER = 'x-gateway-client-ip';

/** One workspace (better-auth "organization") per user, created right after sign-up. */
async function createPersonalWorkspace(user: { id: string; name: string; email: string }) {
  const base = (user.name || user.email.split('@')[0] || 'workspace').trim();
  const slug = `${base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'ws'}-${randomBase62(6).toLowerCase()}`;
  const orgId = crypto.randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(schema.organization).values({ id: orgId, name: `${base}'s workspace`, slug, createdAt: new Date() });
    await tx.insert(schema.member).values({ id: crypto.randomUUID(), organizationId: orgId, userId: user.id, role: 'owner', createdAt: new Date() });
    // Sign-up creates the session inside the same transaction, before this hook runs: activate it now.
    await tx
      .update(schema.session)
      .set({ activeOrganizationId: orgId })
      .where(and(eq(schema.session.userId, user.id), isNull(schema.session.activeOrganizationId)));
  });
}

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
  databaseHooks: {
    user: { create: { after: createPersonalWorkspace } },
    session: {
      create: {
        // Later sign-ins: start the new session in the user's workspace.
        before: async (session) => {
          const [m] = await db
            .select({ organizationId: schema.member.organizationId })
            .from(schema.member)
            .where(eq(schema.member.userId, session.userId))
            .limit(1);
          return { data: { ...session, activeOrganizationId: m?.organizationId ?? null } };
        },
      },
    },
  },
});
