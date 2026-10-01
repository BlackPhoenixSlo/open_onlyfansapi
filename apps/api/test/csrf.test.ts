import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/index.js';
import { bearer, ORIGIN, resetDb, signUp } from './helpers.js';

const app = await buildApp({ logger: false });
let cookie: string;

beforeAll(async () => {
  await resetDb();
  ({ cookie } = await signUp(app, 'csrf@example.test'));
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const post = (headers: Record<string, string>) =>
  app.inject({ method: 'POST', url: '/api/keys', headers, payload: { name: 'x' } });

describe('csrf', () => {
  it('rejects a cookie write without x-dashboard', async () => {
    const res = await post({ cookie, origin: ORIGIN });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('csrf_failed');
  });

  it('rejects a cookie write without Origin or with a foreign Origin', async () => {
    expect((await post({ cookie, 'x-dashboard': '1' })).statusCode).toBe(403);
    expect((await post({ cookie, 'x-dashboard': '1', origin: 'https://evil.example' })).statusCode).toBe(403);
  });

  it('accepts a cookie write with both', async () => {
    expect((await post({ cookie, 'x-dashboard': '1', origin: ORIGIN })).statusCode).toBe(201);
  });

  it('allows cookie reads on /api without the header', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/keys', headers: { cookie } })).statusCode).toBe(200);
  });

  it('applies to session-authenticated /v1 writes too', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/12/chats/1/mute', headers: { cookie, 'x-dashboard': '1' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('csrf_failed');
  });

  it('does not accept a cookie on /v1 without x-dashboard', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/whoami', headers: { cookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/whoami', headers: { cookie, 'x-dashboard': '1' } })).statusCode).toBe(200);
  });

  it('an invalid bearer with a valid cookie is 401 (no cookie fallback)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: { ...bearer('gk_invalid'), cookie, 'x-dashboard': '1' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_api_key');
  });
});
