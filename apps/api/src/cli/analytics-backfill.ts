// Step 0 of docs/spec/future-client-story-ask.md §6: backfills one account's range, then writes the CSVs.
// Usage: pnpm --filter @gateway/api analytics:backfill --account <id> --from <date> --to <date> --out <dir> [--team <teamId>] [--automation <file>] [--dry-run]
//        (in the container: node dist/cli/analytics-backfill.js ...)
// `--to` is exclusive; dates without a time are UTC midnight. `--automation` names a file of the client's automation
// texts, one per line: outbound messages matching one are `automated` (reason `automation`). Ctrl-C stops the run at once (a request in flight
// finishes) and still writes the CSVs; a second Ctrl-C quits without writing. `--dry-run` stores nothing and writes the
// CSVs from what it read. A progress line goes to stderr every 5 minutes; a run that fails prints its last counts and
// still writes the CSVs of what it stored. See docs/analytics-backfill.md.
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pool } from '../db/index.js';
import { env } from '../env.js';
import { createUpstream } from '../lib/upstream.js';
import { dbStore, memoryStore } from '../modules/analytics/backfill-store.js';
import { backfill, progressLine, type BackfillResult, type BackfillRows, type BackfillStore } from '../modules/analytics/backfill.js';
import { claimAccount } from '../modules/accounts/ownership.js';
import { accountTeam, readAutomationTexts, writeExport, writeRowsExport } from './analytics-export.js';

const USAGE = 'usage: analytics:backfill --account <id> --from <date> --to <date> --out <dir> [--team <teamId>] [--automation <file>] [--dry-run]';
const PROGRESS_EVERY_MS = 5 * 60_000;

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

/** The run's counts so far, and when its chat phase began (for the ETA). */
let last: Readonly<BackfillResult> | null = null;
let chatsStartedAt: number | null = null;
const progress = setInterval(() => last && console.error(progressLine(last, chatsStartedAt)), PROGRESS_EVERY_MS);
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The run's counts; `threw` when the run failed (the counts are its last progress). */
function report(result: Readonly<BackfillResult>, threw = false) {
  const partial = dryRun ? 'yes (partial dry run)' : 'yes (partial: re-run to finish, rows upsert)';
  console.log(`requests: ${result.requests}; ${threw ? 'failed' : `stopped: ${result.stopped ? partial : 'no'}`}`);
  console.log(
    `chats ${result.chats}, messages ${result.messages}, broadcasts ${result.broadcasts}, transactions ${result.transactions}, welcome message ${result.welcome ? 'set' : 'none'}`,
  );
  console.log(`incomplete chats ${result.incompleteChats} (the walk stopped before reaching --from: see chats.csv oldest_at)`);
  const failed = result.failedChats;
  const failedIds = failed.length ? `: ${failed.slice(0, 20).join(', ')}${failed.length > 20 ? ', ...' : ''}` : '';
  console.log(
    `chats the list left out ${result.seededChats} (the range's payers and chats with stored messages, walked; ${result.missingChats} not found upstream, skipped); list entries dropped ${result.droppedChats} (no readable fan id); chats failed ${failed.length} (a 4xx, skipped)${failedIds}`,
  );
}

try {
  const teamId = await accountTeam(accountId, values.team);
  const automationTexts = automationFile ? await readAutomationTexts(automationFile) : [];
  const upstream = createUpstream({ url: env.UPSTREAM_URL, token: env.UPSTREAM_TOKEN, timeoutMs: env.UPSTREAM_TIMEOUT_MS });
  console.log(`backfilling account ${accountId} of workspace ${teamId}, ${from.toISOString()} to ${to.toISOString()}${dryRun ? ' (dry run: stores nothing)' : ''}`);
  if (automationFile) console.log(`automation texts: ${automationTexts.length} from ${automationFile}`);
  let sink: { store: BackfillStore; write: () => ReturnType<typeof writeExport> };
  if (dryRun) {
    const rows: BackfillRows = { messages: [], chats: [], transactions: [] };
    sink = { store: memoryStore(rows), write: () => writeRowsExport({ rows, from, to, outDir }) };
  } else {
    await claimAccount(teamId, accountId);
    sink = { store: dbStore(teamId, accountId), write: () => writeExport({ teamId, accountId, from, to, outDir }) };
  }
  const onProgress = (r: Readonly<BackfillResult>) => {
    last = r;
    if (r.phase === 'chats') chatsStartedAt ??= Date.now();
  };
  try {
    report(await backfill({ upstream, accountId, from, to, config: { automationTexts }, signal: stop.signal, store: sink.store, onProgress }));
  } catch (err) {
    // The rows stored so far stay: print the counts and write the CSVs of what was stored.
    console.error(`backfill failed: ${errorText(err)}`);
    process.exitCode = 1;
    if (last) {
      console.error(progressLine(last, chatsStartedAt));
      report(last, true);
    }
  }
  const written = await sink.write();
  console.log(
    `wrote ${outDir}: messages.csv ${written.messages}, chats.csv ${written.chats}, transactions.csv ${written.transactions}, reply_times.csv ${written.replyTimes} rows`,
  );
} catch (err) {
  console.error(errorText(err));
  process.exitCode = 1;
} finally {
  clearInterval(progress);
  await pool.end();
}
