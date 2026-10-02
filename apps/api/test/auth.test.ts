import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { db, pool } from '../src/db/index.js';
import { member, organization } from '../src/db/schema.js';
import { ORIGIN, resetDb, signUp } from './helpers.js';

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

const orgPost = (path: string, payload: unknown) =>
  app.inject({
    method: 'POST',
    url: `/api/auth/organization/${path}`,
    headers: { cookie: u.cookie, origin: ORIGIN, 'content-type': 'application/json' },
    payload: payload as object,
  });

const countOrgs = async () => (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM organization')).rows[0]!.n;
const membershipsOf = (userId: string) => db.select().from(member).where(eq(member.userId, userId));

/** Simulates a sign-up whose workspace insert failed: no membership, session not in any workspace. */
async function dropWorkspace(userId: string) {
  const [m] = await membershipsOf(userId);
  if (m) await db.delete(organization).where(eq(organization.id, m.organizationId));
  await pool.query('UPDATE session SET active_organization_id = NULL WHERE user_id = $1', [userId]);
}

describe('organization writes through the auth API', () => {
  it.each([
    ['create', { name: 'second', slug: 'second-ws' }],
    ['invite-member', { email: 'x@example.test', role: 'member' }],
    ['accept-invitation', { invitationId: 'nope' }],
    ['set-active', { organizationId: null }],
    ['leave', { organizationId: 'nope' }],
    ['update', { organizationId: 'nope', data: { slug: 'taken-over' } }],
  ])('refuses %s', async (path, payload) => {
    if (path === 'update') (payload as { organizationId: string }).organizationId = u.teamId;
    const res = await orgPost(path, payload);
    expect(res.statusCode).toBe(403);
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
  it('gives a user with no membership a workspace', async () => {
    await dropWorkspace(u.userId);
    expect(await membershipsOf(u.userId)).toHaveLength(0);
    const res = await app.inject({ method: 'GET', url: '/api/keys', headers: { cookie: u.cookie } });
    expect(res.statusCode).toBe(200);
    const [m] = await membershipsOf(u.userId);
    expect(m).toMatchObject({ role: 'owner' });
    const session = await app.inject({ method: 'GET', url: '/api/auth/get-session', headers: { cookie: u.cookie } });
    expect(session.json().session.activeOrganizationId).toBe(m!.organizationId);
  });

  it('two concurrent first loads create exactly one workspace', async () => {
    await dropWorkspace(u.userId);
    const before = await countOrgs();
    const results = await Promise.all(
      Array.from({ length: 2 }, () => app.inject({ method: 'GET', url: '/api/keys', headers: { cookie: u.cookie } })),
    );
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(await membershipsOf(u.userId)).toHaveLength(1);
    expect(await countOrgs()).toBe(before + 1);
  });
});
