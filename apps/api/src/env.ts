import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default('0.0.0.0'),
  APP_URL: z.string().url(),
  BETTER_AUTH_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(16),
  TRUST_PROXY: bool.default(false),
  BACKEND_URL: z.string().url(),
  BACKEND_JWT_SECRET: z.string().min(8),
  BACKEND_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  KEY_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(120),
  RUN_JOBS: bool.default(true),
  /** Which request logs keep bodies: `errors` = status >= 400 only. */
  LOG_BODIES: z.enum(['errors', 'all', 'none']).default('errors'),
  LOG_BODY_MAX_BYTES: z.coerce.number().int().positive().default(16_384),
  LOG_RETENTION_DAYS: z.coerce.number().int().positive().default(14),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment:\n' + z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
/** Origin (scheme://host:port) the dashboard is served from; the only Origin allowed on cookie writes. */
export const appOrigin = new URL(env.APP_URL).origin;
