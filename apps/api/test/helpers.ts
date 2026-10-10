import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { db, pool } from '../src/db/index.js';
import { accountWorkspace, organization, teamBackend } from '../src/db/schema.js';
import { setMailTransport, type Mail } from '../src/lib/mailer.js';
import { dbStore } from '../src/modules/analytics/backfill-store.js';
import { backfill, type BackfillOptions } from '../src/modules/analytics/backfill.js';
import { claimAccount } from '../src/modules/accounts/ownership.js';

export const ORIGIN = 'http://localhost:5173';
/** Headers the dashboard sends on cookie-authenticated writes. */
export const dashboard = (cookie: string) => ({ cookie, origin: ORIGIN, 'x-dashboard': '1' });

/** Mail the API sent during this test file (nothing leaves the process). */
export const outbox: Mail[] = [];
setMailTransport(async (mail) => {
  outbox.push(mail);
});

/** The verification link in the latest mail to `email`, as a path for app.inject. */
export function verificationPath(email: string) {
  const mail = outbox.findLast((m) => m.to === email);
  const link = mail && /https?:\/\/\S+/.exec(mail.text)?.[0];
  if (!link) throw new Error(`no verification mail to ${email}`);
  const url = new URL(link);
  return url.pathname + url.search;
}

/** Session cookies from a response's Set-Cookie headers, as one Cookie header. */
export function cookieOf(res: { headers: Record<string, unknown> }) {
  const setCookie = res.headers['set-cookie'] as string | string[] | undefined;
  return (Array.isArray(setCookie) ? setCookie : [setCookie ?? '']).map((c) => c.split(';')[0]).join('; ');
}

export async function resetDb() {
  await pool.query('TRUNCATE "user", organization, verification CASCADE');
}

/**
 * Signs up a user and follows the emailed verification link; returns the session cookie and the auto-created workspace.
 * Sign-up links the workspace; this removes the link unless `linked`, so tests opt in with `linkTeam` as before and
 * the `team_not_linked` gate stays covered.
 */
export async function signUp(app: FastifyInstance, email: string, { linked = false }: { linked?: boolean } = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    payload: { email, password: 'pw-12345678', name: email.split('@')[0] },
  });
  if (res.statusCode !== 200) throw new Error(`sign-up failed: ${res.statusCode} ${res.body}`);
  const verified = await app.inject({ method: 'GET', url: verificationPath(email) });
  if (verified.statusCode !== 302) throw new Error(`verification failed: ${verified.statusCode} ${verified.body}`);
  const cookie = cookieOf(verified);
  const session = await app.inject({ method: 'GET', url: '/api/auth/get-session', headers: { cookie } });
  const teamId = session.json().session.activeOrganizationId as string;
  const [team] = await db.select().from(organization).where(eq(organization.id, teamId));
  if (!linked) await db.delete(teamBackend).where(eq(teamBackend.teamId, teamId));
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

/** What a dashboard connect records, without its link check (fixtures of unlinked workspaces own accounts too). */
export async function ownAccounts(teamId: string, ...accountIds: number[]) {
  await db.insert(accountWorkspace).values(accountIds.map((accountId) => ({ accountId, teamId })));
}

/** What `link-team <slug>` does: marks the workspace as allowed to reach the upstream. */
export { linkTeam } from '../src/lib/team-link.js';

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

/** As `analytics:backfill` (no dry run): claims the account for `teamId`, then backfills into the analytics tables. */
export async function claimAndBackfill({ teamId, ...opts }: Omit<BackfillOptions, 'store'> & { teamId: string }) {
  await claimAccount(teamId, opts.accountId);
  return backfill({ ...opts, store: dbStore(teamId, opts.accountId) });
}
