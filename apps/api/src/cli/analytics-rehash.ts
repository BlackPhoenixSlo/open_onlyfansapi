// Rebuilds the script hash (`text_hash`, `normaliser_version`) of one account's stored outbound messages from their
// raw text with the current normaliser (spec §4.4), then syncs its script candidates. Idempotent: a second run
// writes nothing. No upstream access.
// Usage: pnpm --filter @gateway/api analytics:rehash --account <id> [--team <teamId>]
//        (in the container: node dist/cli/analytics-rehash.js ...)
import { parseArgs } from 'node:util';
import { pool } from '../db/index.js';
import { NORMALISER_VERSION } from '../modules/analytics/derive.js';
import { rehashAccount } from '../modules/analytics/scripts.js';
import { accountTeam } from './analytics-export.js';

const USAGE = 'usage: analytics:rehash --account <id> [--team <teamId>]';

const { values } = parseArgs({ options: { account: { type: 'string' }, team: { type: 'string' } } });
const accountId = Number(values.account);
if (!Number.isInteger(accountId) || accountId <= 0) {
  console.error(USAGE);
  process.exit(1);
}

try {
  const teamId = await accountTeam(accountId, values.team);
  const r = await rehashAccount(teamId, accountId);
  console.log(`normaliser v${NORMALISER_VERSION}: outbound ${r.outbound}, updated ${r.updated}, scripts ${r.scripts}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
