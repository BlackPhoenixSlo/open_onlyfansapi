import { buildApp } from './app.js';
import { pool } from './db/index.js';
import { env } from './env.js';

const app = await buildApp();

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: env.PORT, host: env.HOST });
