import { describe, expect, it } from 'vitest';
import { fillPath, urlProblem } from './spec';

const ORIGIN = 'http://localhost:5173';

describe('urlProblem', () => {
  it('accepts plain /v1 URLs', () => {
    expect(urlProblem('/v1/whoami', ORIGIN)).toBeNull();
    expect(urlProblem('/v1/12/users/me?limit=5&q=..', ORIGIN)).toBeNull();
  });

  // A logged path or a path parameter must not steer a cookie-authenticated request out of /v1.
  it.each([
    '/api/keys/key_x',
    '/v1/%2e%2e/api/keys/key_x',
    '/v1/%2E./api/auth/sign-out',
    '/v1/../api/keys',
    '/v1/12/./users/me',
    '/v1/12\\..\\..\\api\\keys',
    '//evil.example/v1/x',
    fillPath('/v1/{account}/users/{userId}', { account: '12', userId: '..' }) + '/../../api/keys',
  ])('rejects %s', (url) => {
    expect(urlProblem(url, ORIGIN)).not.toBeNull();
  });
});
