import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { assertTeamLinked } from '../../lib/team-link.js';
import { assertWriteScope } from '../../plugins/actor.js';

const ENCODED_SEPARATOR = /%2f|%5c|\\/i;
const MAX_ACCOUNT_ID = 2_147_483_647;
const FORWARDED_RESPONSE_HEADERS = new Set(['content-type', 'x-of-cache', 'retry-after']);

/** The `{account}` path segment as an id, or null. Account ids are int4 (upstream and `request_log.account_id`). */
export function parseAccountId(segment: string): number | null {
  if (!/^\d{1,10}$/.test(segment)) return null;
  const id = Number(segment);
  return id <= MAX_ACCOUNT_ID ? id : null;
}

const invalidPath = () => new AppError(400, 'invalid_path', 'The path contains a disallowed segment');

/**
 * Splits the raw request URL `/v1/{account}/<rest>?<query>` into the account id and `/<rest>?<query>`,
 * which the upstream adapter maps to `/of/<rest>?<query>`. Works on the undecoded URL: encoded separators
 * and dot segments are rejected.
 */
export function resolveUpstream(rawUrl: string): { accountId: number; path: string } {
  const q = rawUrl.indexOf('?');
  const path = q === -1 ? rawUrl : rawUrl.slice(0, q);
  const query = q === -1 ? '' : rawUrl.slice(q);
  const m = /^\/v1\/([^/]+)(\/.*)?$/.exec(path);
  const accountId = m ? parseAccountId(m[1]!) : null;
  if (!m || accountId === null) throw new AppError(404, 'not_found', 'Unknown account or route');
  const rest = m[2] ?? '/';
  if (ENCODED_SEPARATOR.test(rest)) throw invalidPath();
  for (const segment of rest.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw invalidPath();
    }
    if (decoded === '.' || decoded === '..') throw invalidPath();
  }
  return { accountId, path: `${rest}${query}` };
}

/**
 * Whether `/<rest>?<query>` (as returned by `resolveUpstream`) is the raw passthrough `/_of/…`: its first segment,
 * decoded, is `_of`, so `%5Fof` counts too. Passthrough responses are forwarded as they are (plan-v5 §2.2).
 */
export function isPassthrough(rest: string): boolean {
  const segment = rest.slice(1).split(/[/?]/, 1)[0] ?? '';
  try {
    return decodeURIComponent(segment) === '_of';
  } catch {
    return false;
  }
}

/** `ALL /v1/:account/*` → upstream `/of/*`, for a linked workspace, scoped by `x-of-proxy-account-id`. */
export default async function proxyRoutes(app: FastifyInstance) {
  // Forward JSON bodies verbatim (and allow empty ones).
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  app.all('/:account/*', async (request, reply) => {
    const { actor } = request;
    const { accountId, path } = resolveUpstream(request.raw.url ?? request.url);
    await assertTeamLinked(actor.teamId);
    assertWriteScope(actor, request.method);
    if (actor.accountIds && !actor.accountIds.includes(accountId)) {
      throw new AppError(403, 'account_not_allowed', `This API key cannot use account ${accountId}`);
    }

    const headers: Record<string, string> = {
      'x-request-id': request.id,
      accept: request.headers.accept ?? 'application/json',
    };
    const cache = request.headers['x-of-cache'];
    if (typeof cache === 'string') headers['x-of-cache'] = cache;
    const body =
      typeof request.body === 'string' && request.body.length > 0 && request.method !== 'GET' && request.method !== 'HEAD'
        ? request.body
        : undefined;
    if (body) headers['content-type'] = request.headers['content-type'] ?? 'application/json';

    const res = await app.upstream.forward({ accountId, path, method: request.method, headers, body });
    reply.status(res.status);
    res.headers.forEach((value, key) => {
      if (FORWARDED_RESPONSE_HEADERS.has(key) || key.startsWith('x-ratelimit-')) reply.header(key, value);
    });
    return reply.send(res.body);
  });
}
