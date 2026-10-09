import { AppError } from './errors.js';

export type UpstreamResponse = { status: number; ok: boolean; headers: Headers; body: Buffer };

export type ForwardRequest = {
  accountId: number;
  /** `/<rest>?<query>` taken from the raw URL; the proxy has already rejected dot segments and encoded separators. */
  path: string;
  method: string;
  /** Allow-listed by the proxy: never the client's `authorization`, `cookie` or `host`. */
  headers: Record<string, string>;
  body?: string;
};

export interface Upstream {
  /** `GET {origin}/of-accounts` → JSON array of account rows (whitelisted by `modules/accounts`). */
  listAccounts(requestId: string): Promise<UpstreamResponse>;
  /** `POST {origin}/session/bootstrap` with a JSON `{ curl, nickname?, proxy_url? }` body (it carries live OF cookies). */
  bootstrapSession(body: string, requestId: string): Promise<UpstreamResponse>;
  /** `{method} {origin}/of{path}` with `x-of-proxy-account-id: {accountId}`. */
  forward(req: ForwardRequest): Promise<UpstreamResponse>;
  /** `GET {origin}/docs/json` → OpenAPI 3 document. It is optional: without it the gateway serves its own routes only. */
  openapi(): Promise<UpstreamResponse>;
}

/**
 * Client for the upstream service. It is the only module that knows the upstream's paths and credential, and it
 * does no database access. Every call sends `authorization: Bearer ${token}` and uses `redirect: 'manual'`.
 * `url` is reduced to its origin, so any path in it is ignored.
 */
export function createUpstream(opts: { url: string; token: string; timeoutMs: number }): Upstream {
  const origin = new URL(opts.url).origin;

  /**
   * Buffers the response body, so the timeout covers the whole exchange.
   * Network failure → 502 `upstream_unavailable`, timeout (headers or body) → 504 `upstream_timeout`.
   */
  async function request(
    url: URL,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<UpstreamResponse> {
    try {
      const res = await fetch(url, {
        method: init.method ?? 'GET',
        headers: { ...init.headers, authorization: `Bearer ${opts.token}` },
        body: init.body,
        redirect: 'manual',
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      return { status: res.status, ok: res.ok, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new AppError(504, 'upstream_timeout', 'The upstream did not respond in time (UPSTREAM_TIMEOUT_MS): check that it is running and not overloaded');
      }
      throw new AppError(502, 'upstream_unavailable', 'The upstream is unreachable: check that it is running and that UPSTREAM_URL points to it');
    }
  }

  return {
    listAccounts: (requestId) =>
      request(new URL('/of-accounts', origin), { headers: { accept: 'application/json', 'x-request-id': requestId } }),
    bootstrapSession: (body, requestId) =>
      request(new URL('/session/bootstrap', origin), {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'x-request-id': requestId },
        body,
      }),
    forward: async ({ accountId, path, method, headers, body }) => {
      const url = new URL(`/of${path}`, origin);
      if (!url.pathname.startsWith('/of/')) {
        throw new AppError(400, 'invalid_path', 'The path contains a disallowed segment');
      }
      return request(url, { method, headers: { ...headers, 'x-of-proxy-account-id': String(accountId) }, body });
    },
    openapi: () => request(new URL('/docs/json', origin), { headers: { accept: 'application/json' } }),
  };
}
