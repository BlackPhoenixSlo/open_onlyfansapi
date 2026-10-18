import { readdirSync, readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { db, pool } from '../src/db/index.js';
import { auth, MEMBER_EMAIL_REFUSED, ORG_API_REFUSED, SIGNUP_USERNAME_REFUSED, USERNAME_IMMUTABLE } from '../src/auth.js';
import { member, organization, session, teamInvite, user } from '../src/db/schema.js';
import { SEGMENTS_BY_FEATURE } from '../src/modules/proxy/feature-gate.js';
import { startFakeUpstream } from './fake-upstream.js';
import { cookieOf, dashboard, ORIGIN, ownAccounts, resetDb, signUp } from './helpers.js';

const TOKEN = process.env.UPSTREAM_TOKEN!;
const upstream = await startFakeUpstream(TOKEN, [
  { id: 100, label: 'A', ofUsername: 'a', ofDisplayName: 'A', ofAvatarUrl: null, status: 'active' },
  { id: 200, label: 'B', ofUsername: 'b', ofDisplayName: 'B', ofAvatarUrl: null, status: 'active' },
]);
const app = await buildApp({ logger: false, upstreamUrl: upstream.url });
const PASSWORD = 'pw-12345678';

let owner: Awaited<ReturnType<typeof signUp>>;
/** A chatter on account 100 with `chats` and `stats`. */
let chatter: { cookie: string; userId: string; memberId: string };

/** Creates an invite as the owner (all creators, no features unless `body` says otherwise); returns its id and token. */
async function invite(body: object = {}) {
  const payload = { allowedAccountIds: null, features: [], ...body };
  const res = await app.inject({ method: 'POST', url: '/api/invites', headers: dashboard(owner.cookie), payload });
  if (res.statusCode !== 201) throw new Error(`invite failed: ${res.statusCode} ${res.body}`);
  const { invite: created, url } = res.json() as { invite: { id: string }; url: string };
  return { id: created.id, url, token: url.split('/invite/')[1]! };
}

const accept = (token: string, username: string, headers: Record<string, string> = { origin: ORIGIN, 'x-dashboard': '1' }) =>
  app.inject({ method: 'POST', url: `/api/invites/${token}/accept`, headers, payload: { username, password: PASSWORD } });

async function signIn(username: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/username',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    payload: { username, password: PASSWORD },
  });
  if (res.statusCode !== 200) throw new Error(`sign-in failed: ${res.statusCode} ${res.body}`);
  return { cookie: cookieOf(res), userId: res.json().user.id as string };
}

/** Accepts a fresh invite with `body`'s permissions and signs the new member in. */
async function join(username: string, body: object) {
  const { token } = await invite(body);
  const res = await accept(token, username);
  if (res.statusCode !== 201) throw new Error(`accept failed: ${res.statusCode} ${res.body}`);
  const signedIn = await signIn(username);
  const [row] = await db.select().from(member).where(eq(member.userId, signedIn.userId));
  return { ...signedIn, memberId: row!.id };
}

/** A session-authenticated `/v1` or `/api` request. */
const as = (cookie: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  app.inject({ method, url, headers: dashboard(cookie), payload });

const countOrgs = async () => (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM organization')).rows[0]!.n;

beforeAll(async () => {
  await resetDb();
  owner = await signUp(app, 'owner@example.test', { linked: true });
  await ownAccounts(owner.teamId, 100, 200);
  chatter = await join('Chatter.One', { allowedAccountIds: [100], features: ['stats', 'chats', 'chats'] });
});
afterAll(async () => {
  await app.close();
  await upstream.close();
  await pool.end();
});

describe('joining by invite', () => {
  it("adds the member to the owner's workspace, creating none, with a synthetic email and the invite's permissions", async () => {
    const [row] = await db.select().from(member).where(eq(member.userId, chatter.userId));
    expect(row).toMatchObject({ organizationId: owner.teamId, role: 'member', allowedAccountIds: [100], features: ['chats', 'stats'] });
    expect(await countOrgs()).toBe(1);
    const [u] = await db.select().from(user).where(eq(user.id, chatter.userId));
    // The synthetic email is the user id's, so it cannot go stale or collide with another username.
    expect(u).toMatchObject({ username: 'chatter.one', displayUsername: 'Chatter.One', email: `${chatter.userId}@members.invalid` });

    const who = await as(chatter.cookie, 'GET', '/v1/whoami');
    expect(who.json()).toMatchObject({
      team: { id: owner.teamId },
      key: null,
      user: { id: chatter.userId, role: 'member', allowedAccountIds: [100], features: ['chats', 'stats'] },
    });
    const ownerWho = await as(owner.cookie, 'GET', '/v1/whoami');
    expect(ownerWho.json().user).toMatchObject({ role: 'owner', allowedAccountIds: null });
    expect(ownerWho.json().user.features).toHaveLength(7);
  });

  it('lists the owner first, never showing a member email', async () => {
    const res = await as(owner.cookie, 'GET', '/api/team/members');
    expect(res.json().items).toMatchObject([
      { role: 'owner', email: 'owner@example.test', allowedAccountIds: null },
      { id: chatter.memberId, role: 'member', username: 'Chatter.One', email: null, allowedAccountIds: [100], features: ['chats', 'stats'] },
    ]);
  });

  it('shows the workspace before sign-up, and the link is gone once used', async () => {
    const { token } = await invite();
    const preview = await app.inject({ method: 'GET', url: `/api/invites/${token}` });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().workspace.name).toEqual(expect.any(String));
    expect((await accept(token, 'reuse_one')).statusCode).toBe(201);
    const again = await accept(token, 'reuse_two');
    expect([again.statusCode, again.json().error.code]).toEqual([410, 'invite_used']);
    expect((await app.inject({ method: 'GET', url: `/api/invites/${token}` })).json().error.code).toBe('invite_used');
    expect(await db.select().from(user).where(eq(user.username, 'reuse_two'))).toEqual([]);
  });

  it('refuses unknown, revoked and expired links', async () => {
    expect((await accept('nope', 'unknown_one')).json().error.code).toBe('invite_not_found');

    const revoked = await invite();
    expect((await as(owner.cookie, 'GET', '/api/invites')).json().items.map((i: { id: string }) => i.id)).toContain(revoked.id);
    expect((await as(owner.cookie, 'DELETE', `/api/invites/${revoked.id}`)).statusCode).toBe(204);
    expect((await as(owner.cookie, 'DELETE', `/api/invites/${revoked.id}`)).statusCode).toBe(404);
    expect((await as(owner.cookie, 'GET', '/api/invites')).json().items.map((i: { id: string }) => i.id)).not.toContain(revoked.id);
    const r = await accept(revoked.token, 'revoked_one');
    expect([r.statusCode, r.json().error.code]).toEqual([410, 'invite_revoked']);

    const expired = await invite();
    await db.update(teamInvite).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(teamInvite.id, expired.id));
    const e = await accept(expired.token, 'expired_one');
    expect([e.statusCode, e.json().error.code]).toEqual([410, 'invite_expired']);
    expect(await db.select().from(user).where(eq(user.username, 'expired_one'))).toEqual([]);
  });

  it('refuses a link that is not pending before hashing the password', async () => {
    const hash = vi.spyOn((await auth.$context).password, 'hash');
    try {
      const used = await invite();
      expect((await accept(used.token, 'prehash_used')).statusCode).toBe(201);
      expect(hash).toHaveBeenCalledTimes(1);
      hash.mockClear();
      const revoked = await invite();
      expect((await as(owner.cookie, 'DELETE', `/api/invites/${revoked.id}`)).statusCode).toBe(204);
      const refusals = [];
      for (const token of ['nope', used.token, revoked.token]) refusals.push((await accept(token, 'prehash_again')).statusCode);
      expect(refusals).toEqual([404, 410, 410]);
      expect(hash).not.toHaveBeenCalled();
    } finally {
      hash.mockRestore();
    }
  });

  it('refuses a taken username (any case) and leaves the invite usable', async () => {
    const { id, token } = await invite();
    const res = await accept(token, 'CHATTER.one');
    expect([res.statusCode, res.json().error.code]).toEqual([409, 'username_taken']);
    expect((await as(owner.cookie, 'GET', '/api/invites')).json().items.map((i: { id: string }) => i.id)).toContain(id);
    expect((await accept(token, 'second_try')).statusCode).toBe(201);
  });

  it('gives one member when the same link is accepted concurrently', async () => {
    const { token } = await invite();
    const results = await Promise.all(['race_a', 'race_b', 'race_c'].map((name) => accept(token, name)));
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 410, 410]);
    const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM \"user\" WHERE username LIKE 'race_%'");
    expect(rows[0]!.n).toBe(1);
  });

  it('needs the dashboard CSRF headers and a valid body', async () => {
    const { token } = await invite();
    const csrf = await accept(token, 'csrf_one', { origin: 'https://evil.example', 'x-dashboard': '1' });
    expect([csrf.statusCode, csrf.json().error.code]).toEqual([403, 'csrf_failed']);
    expect((await accept(token, 'no spaces!')).statusCode).toBe(400);
    const badFeature = await as(owner.cookie, 'POST', '/api/invites', { allowedAccountIds: null, features: ['keys'] });
    expect(badFeature.statusCode).toBe(400);
    const foreign = await as(owner.cookie, 'POST', '/api/invites', { allowedAccountIds: [999], features: [] });
    expect([foreign.statusCode, foreign.json().error.code]).toEqual([403, 'account_not_allowed']);
    // Creators are an explicit choice: omitting them is not "all".
    expect((await as(owner.cookie, 'POST', '/api/invites', { features: ['chats'] })).statusCode).toBe(400);
  });

  it('never writes an invite token to the log', async () => {
    const lines: string[] = [];
    const logged = await buildApp({ upstreamUrl: upstream.url, logStream: { write: (line) => void lines.push(line) } });
    logged.log.level = 'info'; // the request lines (tests run at LOG_LEVEL=warn)
    try {
      const { token } = await invite();
      await logged.inject({ method: 'GET', url: `/api/invites/${token}` });
      await logged.inject({
        method: 'POST',
        url: `/api/invites/${token}/accept`,
        headers: { origin: ORIGIN, 'x-dashboard': '1' },
        payload: { username: 'logged_one', password: PASSWORD },
      });
      await logged.inject({ method: 'GET', url: `/invite/${token}` });
      const out = lines.join('');
      expect(out).toContain('/api/invites/<redacted>/accept');
      expect(out).toContain('/invite/<redacted>');
      expect(out).not.toContain(token);
    } finally {
      await logged.close();
    }
  });

  it('refuses public sign-up with a member email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: { email: `${chatter.userId}@Members.Invalid`, password: PASSWORD, name: 'squatter' },
    });
    expect([res.statusCode, res.json().message]).toEqual([403, MEMBER_EMAIL_REFUSED]);
  });

  it('does not answer whether a username is taken', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/is-username-available',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: { username: 'chatter.one' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('refuses public sign-up with a username or display username', async () => {
    // A taken (the chatter's) or invalid username is refused the same way, not with the username plugin's 400.
    const extras = [{ username: 'squatter_name' }, { displayUsername: 'Squatter_Name' }, { username: 'chatter.one' }, { username: 'x' }];
    for (const [i, extra] of extras.entries()) {
      const email = `squatter-${i}@example.test`;
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-up/email',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        payload: { email, password: PASSWORD, name: 'squatter', ...extra },
      });
      expect([res.statusCode, res.json().code, res.json().message]).toEqual([403, 'USERNAME_SET_BY_INVITE', SIGNUP_USERNAME_REFUSED]);
      expect(await db.select().from(user).where(eq(user.email, email))).toEqual([]);
    }
    expect(await db.select().from(user).where(eq(user.username, 'squatter_name'))).toEqual([]);
  });

  it('bypasses REGISTRATION_OPEN=false, which still refuses sign-up', async () => {
    const { token } = await invite();
    // env.ts is read once at import: build a fresh app with the variable set.
    vi.stubEnv('REGISTRATION_OPEN', 'false');
    vi.resetModules();
    const { buildApp: buildClosed } = await import('../src/app.js');
    const { pool: closedPool } = await import('../src/db/index.js');
    const closed = await buildClosed({ logger: false, upstreamUrl: upstream.url });
    try {
      const signUpRes = await closed.inject({
        method: 'POST',
        url: '/api/auth/sign-up/email',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        payload: { email: 'closed@example.test', password: PASSWORD, name: 'closed' },
      });
      expect(signUpRes.statusCode).toBe(400);
      const res = await closed.inject({
        method: 'POST',
        url: `/api/invites/${token}/accept`,
        headers: { origin: ORIGIN, 'x-dashboard': '1' },
        payload: { username: 'closed_member', password: PASSWORD },
      });
      expect(res.statusCode).toBe(201);
    } finally {
      await closed.close();
      await closedPool.end();
      vi.unstubAllEnvs();
    }
    expect((await signIn('closed_member')).cookie).not.toBe('');
  });
});

describe('a member is a person-bound key', () => {
  it('reaches its creators through the features it holds', async () => {
    const res = await as(chatter.cookie, 'GET', '/v1/100/chats');
    expect(res.statusCode).toBe(200);
    expect(upstream.requests.at(-1)!.url).toBe('/of/chats');
    const accounts = await as(chatter.cookie, 'GET', '/v1/accounts');
    expect(accounts.json().items.map((a: { id: number }) => a.id)).toEqual([100]);
    expect((await as(chatter.cookie, 'GET', '/v1/stats')).statusCode).toBe(200);
  });

  it('is refused outside its creators, its features, unmapped routes and the raw passthrough, before the upstream', async () => {
    const before = upstream.requests.length;
    const cases: [string, number, string][] = [
      ['/v1/200/chats', 403, 'account_not_allowed'],
      ['/v1/100/posts', 403, 'feature_not_allowed'],
      ['/v1/100/mass-messaging', 403, 'feature_not_allowed'],
      ['/v1/100/tracking-links', 403, 'feature_not_allowed'],
      ['/v1/100/settings', 403, 'feature_not_allowed'],
      ['/v1/100/somewhere-new', 403, 'feature_not_allowed'],
      ['/v1/100/', 403, 'feature_not_allowed'],
      ['/v1/100/_of/users/me', 403, 'owner_only'],
      ['/v1/100/%5Fof/users/me', 403, 'owner_only'],
    ];
    for (const [url, status, code] of cases) {
      const res = await as(chatter.cookie, 'GET', url);
      expect([url, res.statusCode, res.json().error?.code ?? res.body]).toEqual([url, status, code]);
    }
    expect(upstream.requests.length).toBe(before);
    // The owner reaches the same routes.
    expect((await as(owner.cookie, 'GET', '/v1/100/_of/users/me')).statusCode).toBe(200);
    expect((await as(owner.cookie, 'GET', '/v1/200/posts')).statusCode).toBe(200);
  });

  it('is refused every /v1 route that does not declare member access', async () => {
    const routes: [Parameters<typeof as>[1], string, object?][] = [
      ['GET', '/v1/webhooks'],
      ['GET', '/v1/webhooks/events'],
      ['POST', '/v1/webhooks', { url: 'https://example.com/hook' }],
      ['GET', '/v1/ws'],
      ['PUT', '/v1/stats/config', { slaSeconds: 60 }],
      ['POST', '/v1/stats/backfill', { accountId: 100, days: 1 }],
    ];
    for (const [method, url, payload] of routes) {
      const res = await as(chatter.cookie, method, url, payload);
      expect([method, url, res.statusCode, res.json().error?.code]).toEqual([method, url, 403, 'owner_only']);
    }
    expect((await as(owner.cookie, 'PUT', '/v1/stats/config', { slaSeconds: 60 })).statusCode).toBe(200);
    // The stats reads it holds `stats` for.
    expect((await as(chatter.cookie, 'GET', '/v1/stats/config')).statusCode).toBe(200);
  });

  it('is refused every owner /api route', async () => {
    const routes: [Parameters<typeof as>[1], string, object?][] = [
      ['GET', '/api/keys'],
      ['POST', '/api/keys', { name: 'escalate' }],
      ['GET', '/api/logs'],
      ['GET', '/api/usage'],
      ['GET', '/api/overview'],
      ['GET', '/api/proxies'],
      ['POST', '/api/proxies/bulk', { text: 'http://h:1' }],
      ['POST', '/api/accounts/connect', { curl: "curl 'x' -H 'user-id: 300'" }],
      ['PATCH', '/api/accounts/100', { label: 'x' }],
      ['DELETE', '/api/accounts/100'],
      ['POST', '/api/accounts/login/browser/start', { email: 'x@example.test', password: 'x' }],
      ['GET', '/api/webhooks/stream/recent'],
      ['POST', '/api/webhooks/stream/test'],
      ['GET', '/api/team/members'],
      ['PATCH', `/api/team/members/${chatter.memberId}`, { features: ['vault'] }],
      ['DELETE', `/api/team/members/${chatter.memberId}`],
      ['GET', '/api/invites'],
      ['POST', '/api/invites', { allowedAccountIds: null, features: [] }],
    ];
    for (const [method, url, payload] of routes) {
      const res = await as(chatter.cookie, method, url, payload);
      expect([method, url, res.statusCode, res.json().error?.code]).toEqual([method, url, 403, 'owner_only']);
    }
    const sse = await app.inject({ method: 'GET', url: '/api/webhooks/stream', headers: { cookie: chatter.cookie } });
    expect([sse.statusCode, sse.json().error.code]).toEqual([403, 'owner_only']);
    const [row] = await db.select().from(member).where(eq(member.id, chatter.memberId));
    expect(row!.features).toEqual(['chats', 'stats']);
  });

  it('cannot change the workspace or memberships, or read the roster, through the auth API', async () => {
    const authCall = (method: 'GET' | 'POST', path: string, payload?: object, cookie = chatter.cookie) =>
      app.inject({
        method,
        url: `/api/auth/${path}`,
        headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
        payload,
      });
    const refused = async (res: Awaited<ReturnType<typeof authCall>>, message: string) =>
      expect([res.statusCode, res.json().message]).toEqual([403, message]);
    const nameOf = async () => (await db.select().from(organization).where(eq(organization.id, owner.teamId)))[0]!.name;
    const name = await nameOf();
    await refused(await authCall('POST', 'organization/update', { data: { name: 'pwned' } }), ORG_API_REFUSED);
    expect(await nameOf()).toBe(name);
    await refused(await authCall('POST', 'organization/invite-member', { email: 'x@example.test', role: 'owner' }), ORG_API_REFUSED);
    await refused(await authCall('POST', 'organization/update-member-role', { memberId: chatter.memberId, role: 'owner' }), ORG_API_REFUSED);
    // The roster (every member's permissions, the owner's email) is the owner's.
    await refused(await authCall('GET', 'organization/get-full-organization'), ORG_API_REFUSED);
    await refused(await authCall('GET', 'organization/list-members'), ORG_API_REFUSED);
    expect((await authCall('GET', 'organization/get-full-organization', undefined, owner.cookie)).statusCode).toBe(200);
    // A username is set once, by the invite.
    await refused(await authCall('POST', 'update-user', { username: 'the_owner' }), USERNAME_IMMUTABLE);
    await refused(await authCall('POST', 'update-user', { displayUsername: 'Owner' }), USERNAME_IMMUTABLE);
    const [u] = await db.select().from(user).where(eq(user.id, chatter.userId));
    expect(u).toMatchObject({ username: 'chatter.one', displayUsername: 'Chatter.One' });
  });

  it('holds no creators when invited with an empty list', async () => {
    const none = await join('no_creators', { allowedAccountIds: [], features: ['chats'] });
    expect((await as(none.cookie, 'GET', '/v1/accounts')).json().items).toEqual([]);
    expect((await as(none.cookie, 'GET', '/v1/100/chats')).json().error.code).toBe('account_not_allowed');
  });

  it('is signed out, not given a workspace, when its member row is gone', async () => {
    const orphan = await join('orphan_member', { allowedAccountIds: null, features: ['chats'] });
    await db.delete(member).where(eq(member.id, orphan.memberId));
    const orgs = await countOrgs();
    const res = await as(orphan.cookie, 'GET', '/v1/whoami');
    expect([res.statusCode, res.json().error.code]).toEqual([401, 'unauthorized']);
    expect((await as(orphan.cookie, 'GET', '/api/me')).statusCode).toBe(401);
    expect(await countOrgs()).toBe(orgs);
    expect(await db.select().from(member).where(eq(member.userId, orphan.userId))).toEqual([]);
  });

  it('reads its role and permissions from /api/me, as the owner does', async () => {
    const mine = await as(chatter.cookie, 'GET', '/api/me');
    expect(mine.json()).toMatchObject({ role: 'member', allowedAccountIds: [100], features: ['chats', 'stats'] });
    const owners = await as(owner.cookie, 'GET', '/api/me');
    expect(owners.json()).toMatchObject({ role: 'owner', allowedAccountIds: null });
    expect(owners.json().features).toHaveLength(7);
    expect(owners.json().workspace.name).toBe(mine.json().workspace.name);
    expect((await app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
  });

  it('fails closed on a stored feature it does not know', async () => {
    const odd = await join('odd_member', {});
    await pool.query("UPDATE member SET features = '{everything}' WHERE id = $1", [odd.memberId]);
    expect((await as(odd.cookie, 'GET', '/v1/100/chats')).json().error.code).toBe('feature_not_allowed');
    expect((await as(odd.cookie, 'GET', '/v1/stats')).json().error.code).toBe('feature_not_allowed');
    // No allowlist: every creator the workspace owns, for the features it holds.
    expect((await as(odd.cookie, 'GET', '/v1/accounts')).json().items.map((a: { id: number }) => a.id)).toEqual([100, 200]);
  });
});

describe('the owner manages members', () => {
  it("edits a member's permissions, effective on the next request", async () => {
    const res = await as(owner.cookie, 'PATCH', `/api/team/members/${chatter.memberId}`, { allowedAccountIds: [200], features: ['vault'] });
    expect(res.json().member).toMatchObject({ allowedAccountIds: [200], features: ['vault'] });
    expect((await as(chatter.cookie, 'GET', '/v1/200/posts')).statusCode).toBe(200);
    expect((await as(chatter.cookie, 'GET', '/v1/200/chats')).json().error.code).toBe('feature_not_allowed');
    expect((await as(chatter.cookie, 'GET', '/v1/100/posts')).json().error.code).toBe('account_not_allowed');
    expect((await as(chatter.cookie, 'GET', '/v1/stats')).json().error.code).toBe('feature_not_allowed');
  });

  it("refuses a foreign account, and the owner's own row", async () => {
    const foreign = await as(owner.cookie, 'PATCH', `/api/team/members/${chatter.memberId}`, { allowedAccountIds: [999] });
    expect([foreign.statusCode, foreign.json().error.code]).toEqual([403, 'account_not_allowed']);
    const [own] = await db.select().from(member).where(eq(member.userId, owner.userId));
    expect((await as(owner.cookie, 'PATCH', `/api/team/members/${own!.id}`, { features: [] })).statusCode).toBe(404);
    expect((await as(owner.cookie, 'DELETE', `/api/team/members/${own!.id}`)).statusCode).toBe(404);
    const empty = await as(owner.cookie, 'PATCH', `/api/team/members/${chatter.memberId}`, {});
    expect([empty.statusCode, empty.json().error.code]).toEqual([400, 'validation_error']);
  });

  it("removes a member: user, membership and sessions go, and the member's cookie stops working", async () => {
    expect((await as(owner.cookie, 'DELETE', `/api/team/members/${chatter.memberId}`)).statusCode).toBe(204);
    expect(await db.select().from(user).where(eq(user.id, chatter.userId))).toEqual([]);
    expect(await db.select().from(member).where(eq(member.id, chatter.memberId))).toEqual([]);
    expect(await db.select().from(session).where(eq(session.userId, chatter.userId))).toEqual([]);
    expect((await as(chatter.cookie, 'GET', '/v1/whoami')).statusCode).toBe(401);
    expect((await as(owner.cookie, 'DELETE', `/api/team/members/${chatter.memberId}`)).statusCode).toBe(404);
  });

  it("cannot touch another workspace's members or invites", async () => {
    const other = await signUp(app, 'other@example.test');
    const victim = await join('victim_member', {});
    const { id } = await invite();
    expect((await as(other.cookie, 'PATCH', `/api/team/members/${victim.memberId}`, { features: ['vault'] })).statusCode).toBe(404);
    expect((await as(other.cookie, 'DELETE', `/api/team/members/${victim.memberId}`)).statusCode).toBe(404);
    expect((await as(other.cookie, 'DELETE', `/api/invites/${id}`)).statusCode).toBe(404);
    expect((await as(other.cookie, 'GET', '/api/team/members')).json().items).toHaveLength(1);
  });
});

describe('the proxy feature map', () => {
  it('covers every first path segment of the upstream route modules, and nothing else', () => {
    const dir = new URL('../../../services/upstream/routes/', import.meta.url);
    const segments = new Set<string>();
    // `@router.get("/seg…")` decorators and `router.add_api_route("/seg…")` / `(f"/seg/{…}")` loops.
    const route = /(?:@router\.\w+|router\.add_api_route)\(\s*f?"\/([^"/{]+)/g;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.py'))) {
      for (const m of readFileSync(new URL(file, dir), 'utf8').matchAll(route)) segments.add(m[1]!);
    }
    expect(segments).toContain('following');
    // `_of`, the raw passthrough, is no feature's: members are refused it.
    expect([...segments].sort()).toEqual([...Object.values(SEGMENTS_BY_FEATURE).flat(), '_of'].sort());
  });
});
