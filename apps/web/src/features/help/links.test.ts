import { describe, expect, it } from 'vitest';
import { linkTarget } from './links';

const DOCS = 'https://github.com/BlackPhoenixSlo/open_onlyfansapi/blob/master';

describe('linkTarget', () => {
  it('allows the sidebar routes, with a query string', () => {
    expect(linkTarget('/keys')).toEqual({ kind: 'route', to: '/keys', search: {} });
    expect(linkTarget('/dashboard')).toEqual({ kind: 'route', to: '/dashboard', search: {} });
    expect(linkTarget('/usage?groupBy=key')).toEqual({ kind: 'route', to: '/usage', search: { groupBy: 'key' } });
  });

  it('opens /docs, /openapi.json and the public docs in a new tab', () => {
    for (const href of ['/docs', '/openapi.json', `${DOCS}/README.md`, `${DOCS}/docs/webhooks.md`, `${DOCS}/docs/authentication.md#team-members`]) {
      expect(linkTarget(href)).toEqual({ kind: 'external', href });
    }
  });

  it('refuses everything else', () => {
    for (const href of [
      'javascript:alert(1)',
      '//evil.example',
      'https://evil.example/keys',
      '/foo',
      '/logs/req_123',
      '/keys/../team',
      '/keys?x#y',
      'https://github.com/BlackPhoenixSlo/open_onlyfansapi/blob/master/apps/api/src/env.ts',
      'https://github.com/someone/else/blob/master/README.md',
      `${DOCS}/docs/webhooks.md#"onmouseover`,
    ]) {
      expect(linkTarget(href), href).toBeNull();
    }
  });
});
