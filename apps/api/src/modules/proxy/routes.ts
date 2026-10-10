import type { FastifyInstance } from 'fastify';
import { appOrigin } from '../../env.js';
import { AppError } from '../../lib/errors.js';
import { assertTeamLinked } from '../../lib/team-link.js';
import { assertWriteScope } from '../../plugins/actor.js';
import { assertAccountAllowed } from '../accounts/ownership.js';

const ENCODED_SEPARATOR = /%2f|%5c|\\/i;
const MAX_ACCOUNT_ID = 2_147_483_647;
const FORWARDED_RESPONSE_HEADERS = new Set(['content-type', 'x-of-cache', 'retry-after']);
/** `application/json` or any `+json` type, with or without parameters. */
export const JSON_TYPE = /^application\/([\w.+-]+\+)?json\s*(;|$)/i;

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

/** An `x-next-page` value the wrapper accepts: a path on this account (`/…`), never `//host…` or a full URL. */
const NEXT_PAGE = /^\/(?!\/)/;

/** Whether `body` is exactly one JSON value (whitespace around it allowed; a BOM is not). Validation only. */
function isJson(body: Buffer): boolean {
  try {
    JSON.parse(body.toString('utf8'));
    return true;
  } catch {
    return false;
  }
}

/**
 * The named-route response wrapper (plan-v5 §2.2): `{"data":<body>,"_meta":{}}`, plus `"_pagination":{"next_page":…}`
 * when the upstream marked a next page. Built by splicing the upstream bytes, so the body is never re-encoded (the
 * upstream client has already decoded any content-encoding). Returns null (forward unchanged) for the passthrough,
 * non-2xx, 204, non-JSON content types, and bodies that are not one complete JSON value (including empty ones).
 */
export function wrapResponse(
  res: { status: number; headers: Headers; body: Buffer },
  rest: string,
  accountId: number,
): Buffer | null {
  if (res.status < 200 || res.status > 299 || res.status === 204 || isPassthrough(rest)) return null;
  if (!JSON_TYPE.test(res.headers.get('content-type') ?? '') || !isJson(res.body)) return null;
  const nextPage = res.headers.get('x-next-page');
  const pagination =
    nextPage !== null && NEXT_PAGE.test(nextPage)
      ? `,"_pagination":{"next_page":${JSON.stringify(`${appOrigin}/v1/${accountId}${nextPage}`)}}`
      : '';
  return Buffer.concat([Buffer.from('{"data":'), res.body, Buffer.from(`,"_meta":{}${pagination}}`)]);
}

/** `ALL /v1/:account/*` → upstream `/of/*`, for a linked workspace that owns the account, scoped by `x-of-proxy-account-id`. */
export default async function proxyRoutes(app: FastifyInstance) {
  // Forward JSON bodies verbatim (and allow empty ones).
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  app.all('/:account/*', async (request, reply) => {
    const { actor } = request;
    const { accountId, path } = resolveUpstream(request.raw.url ?? request.url);
    await assertTeamLinked(actor.teamId);
    assertWriteScope(actor, request.method);
    await assertAccountAllowed(actor, accountId);

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
    // `x-next-page` is read by wrapResponse and, like content-length, never forwarded (Fastify sets the length).
    res.headers.forEach((value, key) => {
      if (FORWARDED_RESPONSE_HEADERS.has(key) || key.startsWith('x-ratelimit-')) reply.header(key, value);
    });
    return reply.send(wrapResponse(res, path, accountId) ?? res.body);
  });
}
