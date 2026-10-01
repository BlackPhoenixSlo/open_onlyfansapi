import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';

const BATCH = 10_000;

/** Deletes request logs older than `days`, 10k rows per statement so no single delete holds locks for long. */
export async function deleteExpiredLogs(days: number): Promise<number> {
  let deleted = 0;
  for (;;) {
    const res = await db.execute(sql`
      delete from request_log where id in (
        select id from request_log where created_at < now() - make_interval(days => ${days}) limit ${BATCH}
      )`);
    deleted += res.rowCount ?? 0;
    if ((res.rowCount ?? 0) < BATCH) return deleted;
  }
}
