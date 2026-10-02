// The 2.0 data migration (drizzle/0006, plan-v5 §2.4) on v4-named rows, in a scratch database.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migrations = fileURLToPath(new URL('../drizzle', import.meta.url));
const testUrl = new URL(process.env.TEST_DATABASE_URL!);
const dbName = `${testUrl.pathname.slice(1)}_migration`;
const url = Object.assign(new URL(testUrl), { pathname: `/${dbName}` }).toString();
const adminUrl = Object.assign(new URL(testUrl), { pathname: '/postgres' }).toString();

async function admin(query: string) {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(query);
  } finally {
    await client.end();
  }
}

/** A copy of drizzle/ whose journal stops before 0006, i.e. the v1 (plan-v4) schema. */
function v1Migrations(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-v1-migrations-'));
  cpSync(migrations, dir, { recursive: true });
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((e) => e.idx <= 5);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

let pool: pg.Pool;
let v1Dir: string;

beforeAll(async () => {
  await admin(`DROP DATABASE IF EXISTS "${dbName}"`);
  await admin(`CREATE DATABASE "${dbName}"`);
  pool = new pg.Pool({ connectionString: url, max: 1 });
  v1Dir = v1Migrations();
});
afterAll(async () => {
  await pool.end();
  rmSync(v1Dir, { recursive: true, force: true });
  await admin(`DROP DATABASE IF EXISTS "${dbName}"`);
});

describe('migration 0006 (v2.0 event names)', () => {
  it('renames stored filters and ledger types, keeps dedup_key, drops pending v4 deliveries, backfills event_id', async () => {
    await migrate(drizzle(pool), { migrationsFolder: v1Dir });
    await pool.query(`INSERT INTO organization (id, name, slug, created_at) VALUES ('team_1', 'Team', 'team-1', now())`);
    await pool.query(`
      INSERT INTO webhook_endpoint (id, team_id, url, events, secret) VALUES
        ('whe_1', 'team_1', 'https://a.example.test/h', '{message.received,upstream.*,account.session_expired,post.expired}', 'whsec_x'),
        ('whe_2', 'team_1', 'https://b.example.test/h', '{}', 'whsec_x'),
        ('whe_3', 'team_1', 'https://c.example.test/h', '{tip.received,ppv.unlocked,subscription.new,subscription.renewed,subscription.expired,message.sent}', 'whsec_x')`);
    await pool.query(`
      INSERT INTO event (id, account_id, type, amount_cents, dedup_key) VALUES
        ('evt_1', 1001, 'message.received', null, 'message.received:1001:1002'),
        ('evt_2', 1001, 'tip.received', 500, 'tip.received:1001:1003'),
        ('evt_3', 1001, 'post.expired', null, null)`);
    await pool.query(`
      INSERT INTO webhook_delivery (id, team_id, endpoint_id, event_type, account_id, payload, status) VALUES
        ('whd_1', 'team_1', 'whe_2', 'message.received', 1001, '{}', 'pending'),
        ('whd_2', 'team_1', 'whe_2', 'account.session_expired', 1001, '{}', 'pending'),
        ('whd_3', 'team_1', 'whe_2', 'message.received', 1001, '{}', 'succeeded'),
        ('whd_4', 'team_1', 'whe_2', 'webhook.test', null, '{}', 'pending'),
        ('whd_5', 'team_1', 'whe_2', 'upstream.chat_typing', 1001, '{}', 'pending')`);

    await migrate(drizzle(pool), { migrationsFolder: migrations });

    const endpoints = (await pool.query('SELECT id, events FROM webhook_endpoint ORDER BY id')).rows;
    expect(endpoints).toEqual([
      { id: 'whe_1', events: ['messages.received', 'upstream.*', 'accounts.session_expired', 'posts.expired'] },
      { id: 'whe_2', events: [] },
      {
        id: 'whe_3',
        events: ['tips.received', 'messages.ppv.unlocked', 'subscriptions.new', 'subscriptions.renewed', 'subscriptions.expired', 'messages.sent'],
      },
    ]);
    expect((await pool.query('SELECT id, type, amount_cents, dedup_key FROM event ORDER BY id')).rows).toEqual([
      { id: 'evt_1', type: 'messages.received', amount_cents: null, dedup_key: 'message.received:1001:1002' },
      { id: 'evt_2', type: 'tips.received', amount_cents: 500, dedup_key: 'tip.received:1001:1003' },
      { id: 'evt_3', type: 'posts.expired', amount_cents: null, dedup_key: null },
    ]);
    // Pending v4 deliveries are dropped (the worker only claims `pending`); finished ones keep their v4 name.
    expect((await pool.query('SELECT id, event_type, status, event_id FROM webhook_delivery ORDER BY id')).rows).toEqual([
      { id: 'whd_1', event_type: 'message.received', status: 'dropped', event_id: 'whd_1' },
      { id: 'whd_2', event_type: 'account.session_expired', status: 'dropped', event_id: 'whd_2' },
      { id: 'whd_3', event_type: 'message.received', status: 'succeeded', event_id: 'whd_3' },
      { id: 'whd_4', event_type: 'webhook.test', status: 'pending', event_id: 'whd_4' },
      { id: 'whd_5', event_type: 'upstream.chat_typing', status: 'pending', event_id: 'whd_5' },
    ]);
    const column = await pool.query(
      `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'webhook_delivery' AND column_name = 'event_id'`,
    );
    expect(column.rows).toEqual([{ is_nullable: 'NO' }]);
    expect((await pool.query(`SELECT to_regclass('v5_event_name') AS t`)).rows).toEqual([{ t: null }]);
  });
});
