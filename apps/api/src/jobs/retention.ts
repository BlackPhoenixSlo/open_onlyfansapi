import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';

const BATCH = 10_000;

/** Rows retention keeps whatever their age: pending deliveries wait for their (paused) endpoint. */
const KEEP = {
  request_log: sql``,
  webhook_delivery: sql`and status <> 'pending'`,
  event: sql``,
};

/** Deletes rows of `table` older than `days`, 10k rows per statement so no single delete holds locks for long. */
export async function deleteExpired(table: keyof typeof KEEP, days: number): Promise<number> {
  const t = sql.identifier(table);
  let deleted = 0;
  for (;;) {
    const res = await db.execute(sql`
      delete from ${t} where id in (
        select id from ${t} where created_at < now() - make_interval(days => ${days}) ${KEEP[table]} limit ${BATCH}
      )`);
    deleted += res.rowCount ?? 0;
    if ((res.rowCount ?? 0) < BATCH) return deleted;
  }
}
