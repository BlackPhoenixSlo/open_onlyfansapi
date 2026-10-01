import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

/**
 * Fastify `trustProxy`: `false`, a hop count (`1` = one reverse proxy in front), or comma-separated proxy IPs/CIDRs.
 * `true` trusts every hop, so a client-sent X-Forwarded-For becomes request.ip; only use it if the proxy overwrites it.
 */
export function parseTrustProxy(value: string): boolean | string[] | ((address: string, hop: number) => boolean) {
  if (value === 'true' || value === 'false') return value === 'true';
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    return (_address, hop) => hop < hops;
  }
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1'];

/** True for an `http:` URL whose host is not one of `allowedHosts`. */
function isPlainHttp(value: string, allowedHosts: string[]) {
  const url = URL.parse(value);
  return url?.protocol === 'http:' && !allowedHosts.includes(url.hostname);
}

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default('0.0.0.0'),
  APP_URL: z.string().url(),
  BETTER_AUTH_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(16),
  TRUST_PROXY: z.string().default('false').transform(parseTrustProxy),
  /** The upstream service's origin; any path in it is ignored. */
  UPSTREAM_URL: z.string().url(),
  UPSTREAM_TOKEN: z.string().min(16),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  KEY_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(120),
  RUN_JOBS: bool.default(true),
  /** Which request logs keep bodies: `errors` = status >= 400 only. */
  LOG_BODIES: z.enum(['errors', 'all', 'none']).default('errors'),
  LOG_BODY_MAX_BYTES: z.coerce.number().int().positive().default(16_384),
  LOG_RETENTION_DAYS: z.coerce.number().int().positive().default(14),
}).superRefine((e, ctx) => {
  if (e.NODE_ENV !== 'production') return;
  for (const key of ['APP_URL', 'BETTER_AUTH_URL'] as const) {
    if (isPlainHttp(e[key], LOCAL_HOSTS)) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `${key} must be https:// in production: plain HTTP sends session cookies without the Secure flag (http is allowed only for localhost and 127.0.0.1)`,
      });
    }
  }
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment:\n' + z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
if (isPlainHttp(env.UPSTREAM_URL, [...LOCAL_HOSTS, 'host.docker.internal'])) {
  console.warn('UPSTREAM_URL is plain http:// to a remote host: UPSTREAM_TOKEN and request bodies travel unencrypted.');
}
/** Every variable the API reads (`.env.example` must list them all). */
export const ENV_KEYS = Object.keys(envSchema.shape);
/** Origin (scheme://host:port) the dashboard is served from; the only Origin allowed on cookie writes. */
export const appOrigin = new URL(env.APP_URL).origin;
