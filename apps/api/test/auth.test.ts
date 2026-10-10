import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureWorkspace, ORG_WRITE_REFUSED } from '../src/auth.js';
import { db, pool } from '../src/db/index.js';
import { member, organization, user } from '../src/db/schema.js';
import { isTeamLinked } from '../src/lib/team-link.js';
import { bearer, cookieOf, createKey, ORIGIN, outbox, resetDb, signUp, verificationPath } from './helpers.js';

const app = await buildApp({ logger: false });
let u: Awaited<ReturnType<typeof signUp>>;

beforeAll(async () => {
  await resetDb();
  u = await signUp(app, 'auth@example.test');
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const authPost = (path: string, payload: object) =>
  app.inject({
    method: 'POST',
    url: `/api/auth/${path}`,
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    payload,
  });

const orgPost = (path: string, payload: object) =>
  app.inject({
    method: 'POST',
    url: `/api/auth/organization/${path}`,
    headers: { cookie: u.cookie, origin: ORIGIN, 'content-type': 'application/json' },
    payload,
  });

const countOrgs = async () => (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM organization')).rows[0]!.n;
const membershipsOf = (userId: string) => db.select().from(member).where(eq(member.userId, userId));
const activeOrgOf = async (cookie: string) =>
  (await app.inject({ method: 'GET', url: '/api/auth/get-session', headers: { cookie } })).json().session
    .activeOrganizationId as string | null;

/**
 * Simulates an out-of-band org delete (or a failed sign-up insert): no membership left, and the session still holds
 * the dead organization id (active_organization_id has no FK).
 */
async function dropWorkspace(userId: string) {
  const [m] = await membershipsOf(userId);
  await db.delete(organization).where(eq(organization.id, m!.organizationId));
  return m!.organizationId;
}

describe('organization writes through the auth API', () => {
  it.each([
    ['create', { name: 'second', slug: 'second-ws' }],
    ['invite-member', { email: 'x@example.test', role: 'member' }],
    ['accept-invitation', { invitationId: 'nope' }],
    ['set-active', { organizationId: null }],
    ['leave', { organizationId: 'nope' }],
  ])('refuses %s', async (path, payload) => {
    const res = await orgPost(path, payload);
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe(ORG_WRITE_REFUSED);
  });

  it('refuses a slug change', async () => {
    const res = await orgPost('update', { organizationId: u.teamId, data: { slug: 'taken-over' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe(ORG_WRITE_REFUSED);
  });

  it('keeps the slug and the single membership after refused writes', async () => {
    const [team] = await db.select().from(organization).where(eq(organization.id, u.teamId));
    expect(team!.slug).toBe(u.slug);
    expect(await membershipsOf(u.userId)).toHaveLength(1);
  });

  it('still allows renaming the workspace', async () => {
    const res = await orgPost('update', { organizationId: u.teamId, data: { name: 'Renamed' } });
    expect(res.statusCode).toBe(200);
    const [team] = await db.select().from(organization).where(eq(organization.id, u.teamId));
    expect(team).toMatchObject({ name: 'Renamed', slug: u.slug });
  });

  it('the database refuses a second membership for a user', async () => {
    const orgId = crypto.randomUUID();
    await db.insert(organization).values({ id: orgId, name: 'other', slug: `other-${orgId}`, createdAt: new Date() });
    await expect(
      db.insert(member).values({ id: crypto.randomUUID(), organizationId: orgId, userId: u.userId, role: 'member', createdAt: new Date() }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });
});

describe('workspace creation on first session load', () => {
  it('gives a user with no membership a workspace and repairs the stale session', async () => {
    const dead = await dropWorkspace(u.userId);
    expect(await membershipsOf(u.userId)).toHaveLength(0);
    expect(await activeOrgOf(u.cookie)).toBe(dead);
    const res = await app.inject({ method: 'GET', url: '/api/keys', headers: { cookie: u.cookie } });
    expect(res.statusCode).toBe(200);
    const [m] = await membershipsOf(u.userId);
    expect(m).toMatchObject({ role: 'owner' });
    expect(m!.organizationId).not.toBe(dead);
    expect(await activeOrgOf(u.cookie)).toBe(m!.organizationId);
  });

  it('two concurrent first loads create exactly one workspace', async () => {
    await dropWorkspace(u.userId);
    const before = await countOrgs();
    const results = await Promise.all(
      Array.from({ length: 2 }, () => app.inject({ method: 'GET', url: '/api/keys', headers: { cookie: u.cookie } })),
    );
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    const ms = await membershipsOf(u.userId);
    expect(ms).toHaveLength(1);
    expect(await countOrgs()).toBe(before + 1);
    expect(await activeOrgOf(u.cookie)).toBe(ms[0]!.organizationId);
  });

  it('two concurrent ensureWorkspace calls for a fresh user create one org and one member', async () => {
    const fresh = { id: crypto.randomUUID(), name: 'fresh', email: 'fresh@example.test' };
    await db.insert(user).values(fresh);
    const before = await countOrgs();
    const [a, b] = await Promise.all([ensureWorkspace(fresh), ensureWorkspace(fresh)]);
    expect(a.organizationId).toBe(b.organizationId);
    expect(await membershipsOf(fresh.id)).toHaveLength(1);
    expect(await countOrgs()).toBe(before + 1);
    expect(await isTeamLinked(a.organizationId)).toBe(true);
  });

  it('sign-up links the new workspace to the upstream, with no operator step', async () => {
    const s = await signUp(app, 'autolink@example.test', { linked: true });
    expect(await isTeamLinked(s.teamId)).toBe(true);
    const { secret } = await createKey(app, s.cookie);
    const who = await app.inject({ method: 'GET', url: '/v1/whoami', headers: bearer(secret) });
    expect(who.json().team).toMatchObject({ id: s.teamId, linked: true });
  });
});

describe('email verification', () => {
  const email = 'verify@example.test';
  const credentials = { email, password: 'pw-12345678' };

  it('sign-up sends a verification mail and starts no session', async () => {
    const res = await authPost('sign-up/email', { ...credentials, name: 'verify' });
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toBeNull();
    expect(cookieOf(res)).not.toContain('session_token');
    const mail = outbox.findLast((m) => m.to === email);
    expect(mail?.subject).toBe('Verify your email address');
    expect(mail?.html).toContain('/api/auth/verify-email?token=');
  });

  it('refuses sign-in until the email is verified', async () => {
    const res = await authPost('sign-in/email', credentials);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('resends the verification mail', async () => {
    const before = outbox.length;
    const res = await authPost('send-verification-email', { email });
    expect(res.statusCode).toBe(200);
    expect(outbox.slice(before).map((m) => m.to)).toEqual([email]);
  });

  it('the link verifies the email, signs the user in and redirects to the dashboard login (which forwards to /)', async () => {
    const res = await app.inject({ method: 'GET', url: verificationPath(email) });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${ORIGIN}/login`);
    const session = await app.inject({ method: 'GET', url: '/api/auth/get-session', headers: { cookie: cookieOf(res) } });
    expect(session.json().user).toMatchObject({ email, emailVerified: true });
    expect(session.json().session.activeOrganizationId).toEqual(expect.any(String));
  });

  it('an invalid link redirects to /login with the error, for the resend prompt', async () => {
    const callbackURL = encodeURIComponent(`${ORIGIN}/login`);
    const res = await app.inject({ method: 'GET', url: `/api/auth/verify-email?token=bogus&callbackURL=${callbackURL}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${ORIGIN}/login?error=INVALID_TOKEN`);
  });

  it('allows sign-in once verified', async () => {
    const res = await authPost('sign-in/email', credentials);
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toEqual(expect.any(String));
  });
});
