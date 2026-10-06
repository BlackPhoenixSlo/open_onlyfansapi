// Step 0 of docs/spec/future-client-story-ask.md §6: backfills one account's range, then writes the CSVs.
// Usage: pnpm --filter @gateway/api analytics:backfill --account <id> --from <date> --to <date> --out <dir> [--team <teamId>] [--automation <file>] [--dry-run]
//        (in the container: node dist/cli/analytics-backfill.js ...)
// `--to` is exclusive; dates without a time are UTC midnight. `--automation` names a file of the client's automation
// texts, one per line: outbound messages matching one are `automated` (reason `automation`). Ctrl-C stops the run at once (a request in flight
// finishes) and still writes the CSVs; a second Ctrl-C quits without writing. `--dry-run` stores nothing and writes the
// CSVs from what it read. See docs/analytics-backfill.md.
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pool } from '../db/index.js';
import { env } from '../env.js';
import { createUpstream } from '../lib/upstream.js';
import { backfill } from '../modules/analytics/backfill.js';
import { accountTeam, readAutomationTexts, writeExport, writeRowsExport } from './analytics-export.js';

const USAGE = 'usage: analytics:backfill --account <id> --from <date> --to <date> --out <dir> [--team <teamId>] [--automation <file>] [--dry-run]';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    account: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    out: { type: 'string' },
    team: { type: 'string' },
    automation: { type: 'string' },
    'dry-run': { type: 'boolean' },
  },
});
const accountId = Number(values.account);
const from = new Date(values.from ?? '');
const to = new Date(values.to ?? '');
if (!Number.isInteger(accountId) || accountId <= 0 || !values.out) fail(USAGE);
if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || !(from < to)) fail(`--from and --to must be dates, --from first\n${USAGE}`);
// pnpm runs scripts in apps/api; a relative --out is taken from where the command was typed.
const outDir = resolve(process.env.INIT_CWD ?? process.cwd(), values.out);
const dryRun = values['dry-run'] === true;
const automationFile = values.automation ? resolve(process.env.INIT_CWD ?? process.cwd(), values.automation) : undefined;

const stop = new AbortController();
process.on('SIGINT', () => {
  if (stop.signal.aborted) process.exit(130);
  stop.abort();
  console.error('stopping (Ctrl-C again to quit without writing the CSVs)');
});

try {
  const teamId = await accountTeam(accountId, values.team);
  const automationTexts = automationFile ? await readAutomationTexts(automationFile) : [];
  const upstream = createUpstream({ url: env.UPSTREAM_URL, token: env.UPSTREAM_TOKEN, timeoutMs: env.UPSTREAM_TIMEOUT_MS });
  console.log(`backfilling account ${accountId} of workspace ${teamId}, ${from.toISOString()} to ${to.toISOString()}${dryRun ? ' (dry run: stores nothing)' : ''}`);
  if (automationFile) console.log(`automation texts: ${automationTexts.length} from ${automationFile}`);
  const result = await backfill({ upstream, teamId, accountId, from, to, config: { automationTexts }, signal: stop.signal, dryRun });
  console.log(`requests: ${result.requests}; stopped: ${result.stopped ? 'yes (partial: re-run to finish, rows upsert)' : 'no'}`);
  console.log(
    `chats ${result.chats}, messages ${result.messages}, broadcasts ${result.broadcasts}, transactions ${result.transactions}, welcome message ${result.welcome ? 'set' : 'none'}`,
  );
  console.log(
    `unmatched queue ids ${result.unmatchedQueueIds} (outbound sends with a queue id mass history does not list); ` +
      `incomplete chats ${result.incompleteChats} (the walk stopped before reaching --from: see chats.csv oldest_at)`,
  );
  const written = result.rows ? await writeRowsExport({ rows: result.rows, from, to, outDir }) : await writeExport({ teamId, accountId, from, to, outDir });
  console.log(
    `wrote ${outDir}: messages.csv ${written.messages}, chats.csv ${written.chats}, transactions.csv ${written.transactions}, reply_times.csv ${written.replyTimes} rows`,
  );
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
