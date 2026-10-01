// Thin wrapper around src/db/migrate.ts, kept for `pnpm db:migrate` and test/global-setup.ts.
// Usage: tsx scripts/migrate.ts [databaseUrl]  (defaults to DATABASE_URL)
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/db/migrate.js';

export { runMigrations };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.argv[2] ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  await runMigrations(url);
  console.log('migrations applied');
}
