import { buildApp } from './app.js';
import { pool } from './db/index.js';
import { env } from './env.js';

const app = await buildApp();
// RUN_JOBS gates the background jobs that arrive with later slices; there are none yet.

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: env.PORT, host: env.HOST });
