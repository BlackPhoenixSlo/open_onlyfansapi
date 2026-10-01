import { describe, expect, it } from 'vitest';
import { normaliseEndpoint } from '../src/modules/logs/capture.js';
import { MASK, redactBody, redactHeaders, redactQuery } from '../src/modules/logs/redact.js';

describe('redact', () => {
  it('drops credential headers and keeps only allow-listed ones', () => {
    const out = redactHeaders({
      authorization: 'Bearer gk_secret',
      cookie: 'session=abc',
      'set-cookie': ['a=b'],
      'x-internal-key': 'internal',
      'x-custom': 'not logged',
      'content-type': 'application/json',
      'user-agent': 'curl/8',
    });
    expect(out).toEqual({ 'content-type': 'application/json', 'user-agent': 'curl/8' });
  });

  it('masks sensitive keys at any depth, including inside arrays', () => {
    const body = JSON.stringify({
      user: { name: 'a', password: 'hunter2', profile: { apiToken: 't', otp_code: '123456', codeName: 'kept' } },
      items: [{ secret: 's', id: 1 }],
      sessionId: 'x',
      cookies: ['c'],
    });
    const out = JSON.parse(redactBody(body, 'application/json; charset=utf-8', 10_000)!);
    expect(out).toEqual({
      user: { name: 'a', password: MASK, profile: { apiToken: MASK, otp_code: MASK, codeName: 'kept' } },
      items: [{ secret: MASK, id: 1 }],
      sessionId: MASK,
      cookies: MASK,
    });
  });

  it('masks sensitive query parameters, encoded or not', () => {
    expect(redactQuery('limit=5&access_token=abc&p%61ssword=x&code=9&q=a+b')).toBe(
      `limit=5&access_token=${MASK}&p%61ssword=${MASK}&code=${MASK}&q=a+b`,
    );
    expect(redactQuery('')).toBeNull();
  });

  it('redacts before truncating', () => {
    // The secret sits past the cut: truncating first would leave invalid JSON (placeholder) or leak the value.
    const late = JSON.stringify({ note: 'x'.repeat(40), password: 'hunter2' });
    const cut = redactBody(late, 'application/json', 30)!;
    expect(cut).toBe(`${JSON.stringify({ note: 'x'.repeat(40) }).slice(0, 30)}…[truncated]`);
    expect(cut).not.toContain('hunter2');
    // A long secret is masked first, so what follows it survives the size limit.
    const long = JSON.stringify({ token: 't'.repeat(5000), keep: 1 });
    expect(redactBody(long, 'application/json', 64)).toBe(`{"token":"${MASK}","keep":1}`);
  });

  it('replaces non-JSON and unparseable bodies with a size placeholder', () => {
    expect(redactBody('password=hunter2', 'application/x-www-form-urlencoded', 1000)).toBe(
      '[16 bytes application/x-www-form-urlencoded]',
    );
    expect(redactBody(Buffer.alloc(2048), 'image/png', 1000)).toBe('[2048 bytes image/png]');
    expect(redactBody('{"password":', 'application/json', 1000)).toBe('[12 bytes application/json]');
    expect(redactBody('', 'application/json', 1000)).toBeNull();
    expect(redactBody(null, undefined, 1000)).toBeNull();
  });

  it('normalises endpoints', () => {
    expect(normaliseEndpoint('GET', '/v1/:account/*', '/v1/12/users/me')).toBe('GET /users/me');
    expect(normaliseEndpoint('POST', '/v1/:account/*', '/v1/12/chats/123/messages')).toBe('POST /chats/:id/messages');
    expect(normaliseEndpoint('GET', '/v1/:account/*', '/v1/12/posts/0b6f3c5e-1d2a-4c3b-9e8f-7a6b5c4d3e2f')).toBe('GET /posts/:id');
    expect(normaliseEndpoint('GET', '/v1/whoami', '/v1/whoami')).toBe('GET /v1/whoami');
  });
});
