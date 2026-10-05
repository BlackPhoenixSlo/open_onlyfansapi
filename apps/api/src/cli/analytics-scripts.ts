// Step 3 of docs/spec/future-client-story-ask.md §6: lists the top 20 script candidates of one account's backfilled
// range in a markdown file, with sends, reply rate and exact variants, to check by hand.
// Usage: pnpm --filter @gateway/api analytics:scripts --account <id> --from <date> --to <date> --out <file.md> [--team <teamId>]
//        (in the container: node dist/cli/analytics-scripts.js ...)
// `--to` is exclusive; dates without a time are UTC midnight. Windows (open_reply, min_reply_chars) come from the
// workspace's stats config. Reads the analytics tables only (the config's default row is made on first read).
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pool } from '../db/index.js';
import { NORMALISER_VERSION } from '../modules/analytics/derive.js';
import { MAX_VARIANTS, scopedScripts } from '../modules/analytics/scripts.js';
import { getStatsConfig } from '../modules/analytics/stats-config.js';
import { accountTeam } from './analytics-export.js';

const USAGE = 'usage: analytics:scripts --account <id> --from <date> --to <date> --out <file.md> [--team <teamId>]';
const LIMIT = 20;

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
  },
});
const accountId = Number(values.account);
const from = new Date(values.from ?? '');
const to = new Date(values.to ?? '');
if (!Number.isInteger(accountId) || accountId <= 0 || !values.out) fail(USAGE);
if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || !(from < to)) fail(`--from and --to must be dates, --from first\n${USAGE}`);
// pnpm runs scripts in apps/api; a relative --out is taken from where the command was typed.
const outFile = resolve(process.env.INIT_CWD ?? process.cwd(), values.out);

const iso = (t: Date | string) => new Date(t).toISOString().replace('.000Z', 'Z');
const pct = (v: number | null) => (v === null ? 'n/a' : `${Math.round(v)}%`);
const hours = (seconds: number) => `${seconds / 3600} h`;

try {
  const teamId = await accountTeam(accountId, values.team);
  const cfg = await getStatsConfig(teamId);
  const asOf = new Date();
  const scripts = await scopedScripts(teamId, [accountId], cfg, { from, to, asOf });
  const top = scripts.slice(0, LIMIT);

  const lines = [
    `# Script candidates to check by hand: account ${accountId}`,
    '',
    `Workspace ${teamId}; ${iso(from)} to ${iso(to)} (exclusive); as of ${iso(asOf)}.`,
    `Stats config version ${cfg.version}: open_reply ${hours(cfg.openReplySeconds)}, min_reply_chars ${cfg.minReplyChars}. Normaliser version ${NORMALISER_VERSION}. Times are UTC.`,
    '',
    `Scripts sent in the range: ${scripts.length}. Listed: the top ${top.length} by sends.`,
    '',
    "A script is a DM (not mass, not automated) whose normalised text (tags stripped, HTML unescaped, NFKC, lowercase, whitespace collapsed, the fan's name, username and custom name replaced by <name>; 4+ words or 20+ characters) was sent 5+ times in 3+ chats within 30 days. " +
      'Reply rate is per outbound sequence (consecutive DMs with no fan message between): replied if the fan wrote within open_reply after its last DM; pending sequences are left out of the rate. ' +
      `Substantive counts only a fan message of min_reply_chars+. Each script lists up to ${MAX_VARIANTS} exact texts as sent, so check that they are one script and not different offers.`,
    '',
    ...top.flatMap((s, i) => [
      `## ${i + 1}. \`${s.hash}\``,
      '',
      `Sends ${s.sends} in ${s.chats} chats, ${iso(s.firstSentAt)} to ${iso(s.lastSentAt)}. ` +
        `Sequences ${s.sequences}: replied ${s.replied}, no reply ${s.noReply}, pending ${s.pending}; reply rate ${pct(s.replyRate)}. ` +
        `Substantive: replied ${s.substantiveReplied}, no reply ${s.substantiveNoReply}, pending ${s.substantivePending}; rate ${pct(s.substantiveReplyRate)}.`,
      '',
      `Variants (${s.variantCount}${s.variantCount > s.variants.length ? `, top ${s.variants.length}` : ''}):`,
      '',
      ...s.variants.map((v) => `- ${v.count}x ${JSON.stringify(v.text)}`),
      '',
    ]),
  ];
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, lines.join('\n'));
  console.log(`scripts ${scripts.length}, listed ${top.length}: wrote ${outFile}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
