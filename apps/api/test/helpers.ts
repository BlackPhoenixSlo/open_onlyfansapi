import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db, pool } from '../src/db/index.js';
import { organization, teamBackend } from '../src/db/schema.js';

export const ORIGIN = 'http://localhost:5173';
/** Headers the dashboard sends on cookie-authenticated writes. */
export const dashboard = (cookie: string) => ({ cookie, origin: ORIGIN, 'x-dashboard': '1' });

export async function resetDb() {
  await pool.query('TRUNCATE "user", organization, verification CASCADE');
}

/** Signs up a user; returns the session cookie and the auto-created workspace. */
export async function signUp(app: FastifyInstance, email: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    payload: { email, password: 'pw-12345678', name: email.split('@')[0] },
  });
  if (res.statusCode !== 200) throw new Error(`sign-up failed: ${res.statusCode} ${res.body}`);
  const setCookie = res.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie : [setCookie ?? ''])
    .map((c) => c.split(';')[0])
    .join('; ');
  const session = await app.inject({ method: 'GET', url: '/api/auth/get-session', headers: { cookie } });
  const teamId = session.json().session.activeOrganizationId as string;
  const [team] = await db.select().from(organization).where(eq(organization.id, teamId));
  return { cookie, teamId, slug: team!.slug, userId: session.json().user.id as string };
}

export async function createKey(
  app: FastifyInstance,
  cookie: string,
  body: { name?: string; scope?: 'read' | 'write'; allowedAccountIds?: number[] | null } = {},
) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/keys',
    headers: dashboard(cookie),
    payload: { name: 'test key', ...body },
  });
  if (res.statusCode !== 201) throw new Error(`create key failed: ${res.statusCode} ${res.body}`);
  return res.json() as { key: { id: string; scope: string }; secret: string };
}

/** What `link-team <slug>` does: marks the workspace as allowed to reach the upstream. */
export async function linkTeam(teamId: string) {
  await db.insert(teamBackend).values({ teamId });
}

export const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

/** Request-log rows are inserted off the response path; waits until all `ids` are stored. */
export async function waitForLogs(ids: string[], timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM request_log WHERE id = ANY($1)', [ids]);
    if (rows[0]!.n === ids.length) return;
    if (Date.now() > deadline) throw new Error(`request logs not written: ${ids.join(', ')}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
