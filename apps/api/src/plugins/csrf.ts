import type { FastifyRequest } from 'fastify';
import { appOrigin } from '../env.js';
import { AppError } from '../lib/errors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF guard for cookie-authenticated requests (`/api/*` and session-authenticated `/v1/*`).
 * Writes must carry `x-dashboard: 1` and an `Origin` equal to APP_URL's origin.
 * (better-auth guards its own `/api/auth/*` writes with its trusted-origins check.)
 */
export function assertCsrf(request: FastifyRequest): void {
  if (SAFE_METHODS.has(request.method)) return;
  if (request.headers['x-dashboard'] !== '1' || request.headers.origin !== appOrigin) {
    throw new AppError(403, 'csrf_failed', 'Cookie-authenticated writes need the x-dashboard header and a trusted Origin');
  }
}
