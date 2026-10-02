import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureWorkspace, ORG_WRITE_REFUSED } from '../src/auth.js';
import { db, pool } from '../src/db/index.js';
import { member, organization, user } from '../src/db/schema.js';
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
  });
});
