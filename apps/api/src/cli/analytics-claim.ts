// Records that an OF account belongs to a workspace (docs/analytics-backfill.md, before the first run). Idempotent.
// The operator's repair path for an account connected outside the dashboard (the upstream's connect.py) or before
// connect recorded ownership. The workspace must be linked (link-team); another workspace's account is refused.
// Usage: pnpm --filter @gateway/api analytics:claim --team <teamId> --account <id>
//        (in the container: node dist/cli/analytics-claim.js ...)
import { parseArgs } from 'node:util';
import { pool } from '../db/index.js';
import { claimAccount } from '../modules/accounts/ownership.js';

const { values } = parseArgs({ options: { team: { type: 'string' }, account: { type: 'string' } } });
const accountId = Number(values.account);
if (!values.team || !Number.isInteger(accountId) || accountId <= 0) {
  console.error('usage: analytics:claim --team <teamId> --account <id>');
  process.exit(1);
}

try {
  await claimAccount(values.team, accountId);
  console.log(`account ${accountId} belongs to workspace ${values.team}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
