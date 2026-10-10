import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureWorkspace, ORG_WRITE_REFUSED, resetPasswordLink } from '../src/auth.js';
import { db, pool } from '../src/db/index.js';
import { member, organization, user } from '../src/db/schema.js';
import { isTeamLinked } from '../src/lib/team-link.js';
import { bearer, cookieOf, createKey, ORIGIN, outbox, resetDb, signUp } from './helpers.js';

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

describe('sign-up', () => {
  const email = 'signup@example.test';
  const credentials = { email, password: 'pw-12345678' };

  it('signs the user in at once, in their workspace, and sends no mail', async () => {
    const res = await authPost('sign-up/email', { ...credentials, name: 'signup' });
    expect(res.statusCode).toBe(200);
    const cookie = cookieOf(res);
    expect(cookie).toContain('session_token');
    const session = await app.inject({ method: 'GET', url: '/api/auth/get-session', headers: { cookie } });
    expect(session.json().user).toMatchObject({ email });
    expect(session.json().session.activeOrganizationId).toEqual(expect.any(String));
    expect(outbox.filter((m) => m.to === email)).toEqual([]);
  });

  it('allows sign-in with the same credentials', async () => {
    const res = await authPost('sign-in/email', credentials);
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toEqual(expect.any(String));
  });

  it('REGISTRATION_OPEN=false refuses sign-up', async () => {
    // env.ts is read once at import: load a fresh auth module with the variable set.
    vi.stubEnv('REGISTRATION_OPEN', 'false');
    vi.resetModules();
    const { auth: closed } = await import('../src/auth.js');
    const { pool: closedPool } = await import('../src/db/index.js');
    try {
      const res = await closed.handler(
        new Request('http://localhost:4000/api/auth/sign-up/email', {
          method: 'POST',
          headers: { origin: ORIGIN, 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'closed@example.test', password: 'pw-12345678', name: 'closed' }),
        }),
      );
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('EMAIL_PASSWORD_SIGN_UP_DISABLED');
      expect(await db.select().from(user).where(eq(user.email, 'closed@example.test'))).toEqual([]);
    } finally {
      await closedPool.end();
      vi.unstubAllEnvs();
    }
  });
});

describe('password reset', () => {
  const email = 'reset@example.test';
  const oldPassword = 'pw-12345678';
  const newPassword = 'new-pw-87654321';
  let token: string;
  let cookie: string;
  let userId: string;
  /** The answer to a reset request for the known address, compared with the unknown one. */
  let knownBody: unknown;

  beforeAll(async () => {
    ({ cookie, userId } = await signUp(app, email));
  });

  it('request-password-reset mails a link to the dashboard reset page', async () => {
    const res = await authPost('request-password-reset', { email });
    expect(res.statusCode).toBe(200);
    knownBody = res.json();
    const { rows } = await pool.query<{ identifier: string }>(
      `SELECT identifier FROM verification WHERE value = $1 AND identifier LIKE 'reset-password:%'`,
      [userId],
    );
    expect(rows).toHaveLength(1);
    token = rows[0]!.identifier.slice('reset-password:'.length);
    const link = resetPasswordLink(token);
    expect(link).toBe(`${ORIGIN}/reset-password?token=${token}`);
    const mail = outbox.findLast((m) => m.to === email);
    expect(mail?.subject).toBe('Reset your password');
    expect(mail?.text).toContain(link);
    expect(mail?.html).toContain(link);
  });

  it('answers an unknown email the same way and sends nothing', async () => {
    const before = outbox.length;
    const res = await authPost('request-password-reset', { email: 'nobody@example.test' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(knownBody);
    expect(outbox.length).toBe(before);
  });

  it('refuses an invalid token', async () => {
    const res = await authPost('reset-password', { token: 'bogus', newPassword });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_TOKEN');
  });

  it('the token sets the new password: the old one is refused, the new one accepted', async () => {
    const res = await authPost('reset-password', { token, newPassword });
    expect(res.statusCode).toBe(200);
    expect((await authPost('sign-in/email', { email, password: oldPassword })).statusCode).toBe(401);
    expect((await authPost('sign-in/email', { email, password: newPassword })).statusCode).toBe(200);
  });

  it('the reset signs out the sessions started before it', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/get-session', headers: { cookie } });
    expect(res.json()).toBeNull();
  });

  it('the token works once', async () => {
    const res = await authPost('reset-password', { token, newPassword: 'third-pw-12345678' });
    expect(res.statusCode).toBe(400);
  });
});
