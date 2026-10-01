import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/index.js';
import { bearer, createKey, dashboard, resetDb, signUp } from './helpers.js';

const app = await buildApp({ logger: false });

beforeAll(resetDb);
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('api keys', () => {
  it('creates, lists, edits and revokes a key; a revoked key gets 401', async () => {
    const { cookie, teamId } = await signUp(app, 'keys@example.test');
    const { key, secret } = await createKey(app, cookie, { name: 'ci', scope: 'write', allowedAccountIds: [7] });
    expect(secret).toMatch(/^gk_[0-9A-Za-z]{32}$/);
    expect(key).toMatchObject({ name: 'ci', scope: 'write', allowedAccountIds: [7], start: secret.slice(0, 12), revokedAt: null });
    expect(key.id).toMatch(/^key_[0-9A-Za-z]{20}$/);

    const list = await app.inject({ method: 'GET', url: '/api/keys', headers: { cookie } });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
    expect(JSON.stringify(list.json())).not.toContain(secret);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/keys/${key.id}`,
      headers: dashboard(cookie),
      payload: { name: 'renamed' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().key).toMatchObject({ name: 'renamed', scope: 'write', allowedAccountIds: [7] });

    const who = await app.inject({ method: 'GET', url: '/v1/whoami', headers: bearer(secret) });
    expect(who.statusCode).toBe(200);
    expect(who.json()).toMatchObject({ team: { id: teamId, linked: false }, key: { id: key.id, name: 'renamed' } });

    const revoked = await app.inject({ method: 'DELETE', url: `/api/keys/${key.id}`, headers: dashboard(cookie) });
    expect(revoked.statusCode).toBe(204);

    const after = await app.inject({ method: 'GET', url: '/v1/whoami', headers: bearer(secret) });
    expect(after.statusCode).toBe(401);
    expect(after.json().error).toMatchObject({ code: 'invalid_api_key', requestId: after.headers['x-request-id'] });

    const listed = await app.inject({ method: 'GET', url: '/api/keys', headers: { cookie } });
    expect(listed.json().items[0].revokedAt).not.toBeNull();
  });

  it('rejects a missing or malformed key', async () => {
    const none = await app.inject({ method: 'GET', url: '/v1/whoami' });
    expect(none.statusCode).toBe(401);
    const bad = await app.inject({ method: 'GET', url: '/v1/whoami', headers: bearer('gk_nope') });
    expect(bad.statusCode).toBe(401);
  });

  it('validates the create body', async () => {
    const { cookie } = await signUp(app, 'keys2@example.test');
    const res = await app.inject({ method: 'POST', url: '/api/keys', headers: dashboard(cookie), payload: { name: '' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('validation_error');
  });
});
