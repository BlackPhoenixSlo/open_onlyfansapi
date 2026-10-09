import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
/** Unset or empty = undefined. */
const optionalString = z.string().optional().transform((v) => v || undefined);

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
/** Hosts the upstream may be reached on over plain http/ws: local, the Docker host, the compose service. */
const UPSTREAM_PLAIN_HOSTS = [...LOCAL_HOSTS, 'host.docker.internal', 'upstream'];

/** True for an unencrypted (`http:` or `ws:`) URL whose host is not one of `allowedHosts`. */
function isUnencrypted(value: string, allowedHosts: string[]) {
  const url = URL.parse(value);
  return (url?.protocol === 'http:' || url?.protocol === 'ws:') && !allowedHosts.includes(url.hostname);
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
  // Also travels as the WebSocket subprotocol `bearer.<token>` (plan v4 §1.7), so RFC 7230 token chars only:
  // a base64 token with `=` or `/` would make `new WebSocket()` throw at boot. Use `openssl rand -hex 32`.
  UPSTREAM_TOKEN: z
    .string()
    .min(16)
    .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/, 'UPSTREAM_TOKEN: use letters, digits and -._~ only (e.g. openssl rand -hex 32)'),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  /** The upstream's event socket (`ws://…/ws`). Unset or empty = no event source, and `/v1/ws` answers 503. */
  UPSTREAM_WS_URL: z
    .literal('')
    .or(z.url({ protocol: /^wss?$/ }))
    .optional()
    .transform((v) => v || undefined),
  KEY_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(120),
  RUN_JOBS: bool.default(true),
  /** Which request logs keep bodies: `errors` = status >= 400 only. */
  LOG_BODIES: z.enum(['errors', 'all', 'none']).default('errors'),
  LOG_BODY_MAX_BYTES: z.coerce.number().int().positive().default(16_384),
  LOG_RETENTION_DAYS: z.coerce.number().int().positive().default(14),
  /** Dev / trusted network only: allows http:// webhook URLs and also relaxes the private-host check (link-local stays blocked). */
  ALLOW_HTTP_WEBHOOKS: bool.default(false),
  /** Attempts per delivery before it is marked failed. */
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().positive().default(6),
  /** Consecutive failed deliveries that pause an endpoint. */
  WEBHOOK_PAUSE_AFTER: z.coerce.number().int().positive().default(20),
  WEBHOOK_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
  /** Days the event ledger (`/v1/stats`) keeps. */
  EVENT_RETENTION_DAYS: z.coerce.number().int().positive().default(365),
  /** Analytics backfill (spec 6.1): upstream requests per account per hour, a guess at OF's tolerance. */
  ANALYTICS_REQUESTS_PER_HOUR: z.coerce.number().int().positive().default(600),
  /** Analytics backfill: delay between upstream pages, as `of_client.iter_messages`. */
  ANALYTICS_PAGE_DELAY_MS: z.coerce.number().int().nonnegative().default(300),
  /** Analytics backfill: the longest wait after a 429 (Retry-After or exponential backoff). */
  ANALYTICS_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(300_000),
  /**
   * Analytics refresh: the hour (UTC, 0 to 23) of the daily backfill refresh; set, it also turns on the hourly
   * transactions poll. Unset, empty or blank = both off (no default: they call OF on their own).
   */
  STATS_REFRESH_HOUR_UTC: z
    .preprocess((v) => (typeof v === 'string' ? v.trim() : v), z.literal('').or(z.coerce.number().int().min(0).max(23)).optional())
    .transform((v) => (v === '' ? undefined : v)),
  /** Outgoing mail (sign-up verification links). Unset or empty = no mail is sent; the link is logged instead. */
  SMTP_HOST: optionalString,
  /** 465 = implicit TLS; anything else (587) must upgrade with STARTTLS. */
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: optionalString,
  SMTP_PASSWORD: optionalString,
  /** Sender address; defaults to SMTP_USER. */
  SMTP_FROM_EMAIL: optionalString,
  SMTP_FROM_NAME: optionalString,
}).superRefine((e, ctx) => {
  if (e.SMTP_HOST && !e.SMTP_FROM_EMAIL && !e.SMTP_USER) {
    ctx.addIssue({ code: 'custom', path: ['SMTP_FROM_EMAIL'], message: 'SMTP_HOST is set: set SMTP_FROM_EMAIL or SMTP_USER (the sender address)' });
  }
  if (e.SMTP_USER && !e.SMTP_PASSWORD) {
    ctx.addIssue({ code: 'custom', path: ['SMTP_PASSWORD'], message: 'SMTP_USER is set: set SMTP_PASSWORD too' });
  }
  if (e.NODE_ENV !== 'production') return;
  for (const key of ['APP_URL', 'BETTER_AUTH_URL'] as const) {
    if (isUnencrypted(e[key], LOCAL_HOSTS)) {
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
if (isUnencrypted(env.UPSTREAM_URL, UPSTREAM_PLAIN_HOSTS)) {
  console.warn('UPSTREAM_URL is plain http:// to a remote host: UPSTREAM_TOKEN and request bodies travel unencrypted.');
}
if (env.UPSTREAM_WS_URL && isUnencrypted(env.UPSTREAM_WS_URL, UPSTREAM_PLAIN_HOSTS)) {
  console.warn('UPSTREAM_WS_URL is plain ws:// to a remote host: UPSTREAM_TOKEN and events travel unencrypted.');
}
if (env.NODE_ENV === 'production' && !env.SMTP_HOST) {
  console.warn('SMTP_HOST is not set: email verification links, which sign the user in, are printed to this log instead of being emailed.');
}
/** Every variable the API reads (`.env.example` must list them all). */
export const ENV_KEYS = Object.keys(envSchema.shape);
/** Origin (scheme://host:port) the dashboard is served from; the only Origin allowed on cookie writes. */
export const appOrigin = new URL(env.APP_URL).origin;
