import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '../env.js';
import * as schema from './schema.js';

export const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 10 });
// An idle client losing its connection (a Postgres restart) emits `error` on the pool, which crashes the process when
// nothing listens. The pool drops that client and connects a new one on the next query, so logging is enough.
pool.on('error', (err) => console.error('postgres: an idle connection failed (the next query reconnects):', err.message));
export const db = drizzle(pool, { schema });
export type Db = typeof db;
