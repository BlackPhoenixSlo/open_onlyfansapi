// Step 2 of docs/spec/future-client-story-ask.md §6: lists up to 20 openers of one account's backfilled range in a
// markdown file, each with why we think it is an opener, to check by hand in OF.
// Usage: pnpm --filter @gateway/api analytics:openers --account <id> --from <date> --to <date> --out <file.md> [--team <teamId>]
//        (in the container: node dist/cli/analytics-openers.js ...)
// `--to` is exclusive; dates without a time are UTC midnight. Windows (open_gap, open_reply) come from the workspace's
// stats config. Reads the analytics tables only (the config's default row is made on first read); no upstream access.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { and, eq } from 'drizzle-orm';
import { db, pool } from '../db/index.js';
import { chatCoverage } from '../db/schema.js';
import { scopedOpeners, type AccountOpener } from '../modules/analytics/metrics.js';
import { getStatsConfig } from '../modules/analytics/stats-config.js';
import { accountTeam } from './analytics-export.js';

const USAGE = 'usage: analytics:openers --account <id> --from <date> --to <date> --out <file.md> [--team <teamId>]';
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

const iso = (t: Date) => t.toISOString().replace('.000Z', 'Z');
function duration(seconds: number): string {
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`].filter(Boolean).join(' ') || '0m';
}

type Coverage = { oldestMessageId: number | null; oldestAt: Date | null; reachedStart: boolean };

/** Why we think `o` is an opener: the gap and what was (not) before it. */
function why(o: AccountOpener, cov: Coverage | undefined): string {
  const ignored = o.ignoredInGap ? `; ${o.ignoredInGap} mass/automated message(s) in the gap ignored` : '';
  if (o.previousAt) {
    const who = o.previousDirection === 'inbound' ? 'fan message' : 'DM';
    return `last fan message or DM was ${who} ${o.previousMessageId} at ${iso(o.previousAt)}, ${duration((o.sentAt.getTime() - o.previousAt.getTime()) / 1000)} before; no fan message since${ignored}`;
  }
  const oldest = cov?.oldestAt ? `oldest stored message ${cov.oldestMessageId} at ${iso(cov.oldestAt)}, ${duration((o.sentAt.getTime() - cov.oldestAt.getTime()) / 1000)} before` : 'no coverage row';
  return o.kind === 'first_ever'
    ? `no fan message or DM before it; chat walked to its start (${oldest})${ignored}`
    : `no fan message or DM stored before it, but the walk did not reach the chat start (${oldest})${ignored}`;
}

const cell = (s: string | number | null) => String(s ?? '').replace(/\|/g, '\\|');

try {
  const teamId = await accountTeam(accountId, values.team);
  const cfg = await getStatsConfig(teamId);
  const asOf = new Date();
  const openers = await scopedOpeners(teamId, [accountId], cfg, { from, to, asOf });
  const coverage = new Map(
    (
      await db
        .select({ chatId: chatCoverage.chatId, oldestMessageId: chatCoverage.oldestMessageId, oldestAt: chatCoverage.oldestAt, reachedStart: chatCoverage.reachedStart })
        .from(chatCoverage)
        .where(and(eq(chatCoverage.teamId, teamId), eq(chatCoverage.accountId, accountId)))
    ).map((c) => [c.chatId, c]),
  );
  // Spread over the range rather than the first 20, so the check sees every part of it.
  const picked = openers.length <= LIMIT ? openers : Array.from({ length: LIMIT }, (_, i) => openers[Math.floor((i * openers.length) / LIMIT)]!);
  const count = (keep: (o: AccountOpener) => boolean) => openers.filter(keep).length;

  const lines = [
    `# Openers to check by hand: account ${accountId}`,
    '',
    `Workspace ${teamId}; ${iso(from)} to ${iso(to)} (exclusive); as of ${iso(asOf)}.`,
    `Stats config version ${cfg.version}: open_gap ${duration(cfg.openGapSeconds)}, open_reply ${duration(cfg.openReplySeconds)}. Times are UTC.`,
    '',
    `Openers: ${openers.length} (first_ever ${count((o) => o.kind === 'first_ever')}, reactivation ${count((o) => o.kind === 'reactivation')}, unknown ${count((o) => o.kind === 'unknown')}); ` +
      `fan replied within open_reply ${count((o) => o.status === 'replied')}, no reply ${count((o) => o.status === 'no_reply')}, pending ${count((o) => o.status === 'pending')}.`,
    `Listed: ${picked.length}${openers.length > LIMIT ? ', spread evenly over the range' : ''}.`,
    '',
    'An opener is a DM (not mass, not automated) with no fan message and no DM in the chat for open_gap before it; mass and automated messages do not reset the gap. ' +
      'To check one: open the chat (chat id = the fan\'s user id) in OF, find the message, and confirm nothing but mass or welcome messages came before it within open_gap.',
    '',
    '| # | Chat id | Message id | Sent at | Kind | Fan reply | Why we think this is an opener |',
    '|---|---|---|---|---|---|---|',
    ...picked.map((o, i) => {
      const reply = o.fanReplyAt ? `${o.fanReplyMessageId} at ${iso(o.fanReplyAt)} (${duration(o.fanReplySeconds!)}, ${o.status})` : o.status;
      return `| ${i + 1} | ${o.chatId} | ${o.messageId} | ${iso(o.sentAt)} | ${o.kind} | ${cell(reply)} | ${cell(why(o, coverage.get(o.chatId)))} |`;
    }),
    '',
  ];
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, lines.join('\n'));
  console.log(`openers ${openers.length}, listed ${picked.length}: wrote ${outFile}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
