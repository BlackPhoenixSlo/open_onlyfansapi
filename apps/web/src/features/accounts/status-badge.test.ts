import { describe, expect, it } from 'vitest';
import { SESSION_EXPIRED_HINT } from './status-badge';

describe('SESSION_EXPIRED_HINT', () => {
  it('names the 2FA case and the logins that take the code, not only a fresh cURL', () => {
    expect(SESSION_EXPIRED_HINT).toMatch(/2FA code/);
    expect(SESSION_EXPIRED_HINT).toMatch(/Try Browserbase login/);
    expect(SESSION_EXPIRED_HINT).toMatch(/Browser login/);
    expect(SESSION_EXPIRED_HINT).toMatch(/Connect account/);
  });
});
