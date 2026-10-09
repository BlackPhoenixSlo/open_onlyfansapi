import { defineConfig } from 'vitest/config';

const testDb = process.env.TEST_DATABASE_URL ?? 'postgres://gateway:gateway@localhost:5434/gateway_test';

export default defineConfig({
  test: {
    fileParallelism: false,
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 15_000,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
      TEST_DATABASE_URL: testDb,
      DATABASE_URL: testDb,
      APP_URL: 'http://localhost:5173',
      BETTER_AUTH_URL: 'http://localhost:4000',
      BETTER_AUTH_SECRET: 'test-only-better-auth-secret-0123456789abcdef',
      UPSTREAM_URL: 'http://127.0.0.1:9',
      UPSTREAM_TOKEN: 'test-only-upstream-token',
      UPSTREAM_TIMEOUT_MS: '2000',
      RUN_JOBS: 'false',
      // No backfill request spacing (under 1 ms): the default 600 an hour spaces requests 6 s apart, and a test with a
      // frozen clock (vi.setSystemTime) would wait for ever.
      ANALYTICS_REQUESTS_PER_HOUR: '1000000000',
    },
  },
});
