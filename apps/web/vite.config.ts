import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const api = 'http://localhost:4000';

export default defineConfig({
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // App code imports `@api/*` for types only. The build must not resolve it: no `@api` alias, and rolldown must not
  // read tsconfig `paths` (it does by default), so a value import fails the build instead of bundling server code.
  build: { rolldownOptions: { tsconfig: false } },
  // Tests only: manual.test.ts reads the API's help manual.
  test: {
    alias: { '@api': fileURLToPath(new URL('../api/src', import.meta.url)) },
  },
  server: {
    proxy: { '/api': api, '/v1': api, '/openapi.json': api, '/docs': api },
  },
});
