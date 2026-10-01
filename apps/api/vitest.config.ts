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
      BACKEND_URL: 'http://127.0.0.1:9',
      BACKEND_JWT_SECRET: 'test-only-backend-jwt-secret',
      BACKEND_TIMEOUT_MS: '2000',
      RUN_JOBS: 'false',
    },
  },
});
