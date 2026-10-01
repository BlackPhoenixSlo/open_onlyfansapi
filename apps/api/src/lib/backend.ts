import { eq } from 'drizzle-orm';
import { createSigner } from 'fast-jwt';
import { db } from '../db/index.js';
import { teamBackend } from '../db/schema.js';
import { AppError } from './errors.js';

const TOKEN_TTL_MS = 5 * 60_000;
const TOKEN_CACHE_MS = 4 * 60_000;

export type Backend = ReturnType<typeof createBackend>;

/**
 * Client for the backend. Each call carries a short-lived HS256 JWT `{ sub, iat, exp }` minted for the
 * workspace's linked backend owner (never `employeeId`, which switches the backend to the employee path).
 */
export function createBackend(opts: { url: string; jwtSecret: string; timeoutMs: number }) {
  const origin = new URL(opts.url).origin;
  const sign = createSigner({ key: opts.jwtSecret, algorithm: 'HS256', expiresIn: TOKEN_TTL_MS });
  const tokens = new Map<number, { token: string; until: number }>();

  function token(backendUserId: number): string {
    const now = Date.now();
    const hit = tokens.get(backendUserId);
    if (hit && hit.until > now) return hit.token;
    const fresh = sign({ sub: backendUserId });
    tokens.set(backendUserId, { token: fresh, until: now + TOKEN_CACHE_MS });
    return fresh;
  }

  /** Calls the backend as `backendUserId`. Network failure → 502, timeout → 504. */
  async function request(
    backendUserId: number,
    url: URL,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<Response> {
    if (url.origin !== origin) throw new AppError(400, 'invalid_path', 'Path escapes the backend');
    try {
      return await fetch(url, {
        method: init.method ?? 'GET',
        headers: { ...init.headers, authorization: `Bearer ${token(backendUserId)}` },
        body: init.body,
        redirect: 'manual',
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new AppError(504, 'upstream_timeout', 'The backend did not respond in time');
      }
      throw new AppError(502, 'upstream_unavailable', 'The backend is unreachable');
    }
  }

  return { origin, token, request };
}

/** The backend owner user id linked to a workspace, or 409 `team_not_linked`. */
export async function requireBackendUserId(teamId: string): Promise<number> {
  const [row] = await db
    .select({ backendUserId: teamBackend.backendUserId })
    .from(teamBackend)
    .where(eq(teamBackend.teamId, teamId))
    .limit(1);
  if (!row) {
    throw new AppError(409, 'team_not_linked', 'This workspace is not linked to a backend user yet');
  }
  return row.backendUserId;
}
