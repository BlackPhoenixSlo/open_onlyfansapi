import pg from 'pg';
import { runMigrations } from '../scripts/migrate.js';

/** Creates gateway_test if missing (initdb only runs on a fresh volume) and applies migrations. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://gateway:gateway@localhost:5434/gateway_test';
  const target = new URL(url);
  const dbName = target.pathname.slice(1);
  const admin = new pg.Client({ connectionString: Object.assign(new URL(url), { pathname: '/postgres' }).toString() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${dbName}"`);
  } catch (err) {
    if ((err as { code?: string }).code !== '42P04') throw err;
  } finally {
    await admin.end();
  }
  await runMigrations(url);
}
