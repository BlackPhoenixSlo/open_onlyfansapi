// Compares an analytics:backfill export with an Infloww Message Dashboard export (docs/analytics-backfill.md).
// Usage: pnpm --filter @gateway/api analytics:diff --ours <dir> --infloww <file.csv> [--tz <offset, e.g. +02:00>]
//        (in the container: node dist/cli/analytics-diff.js ...)
// A report: exits 0 even with unresolved differences. No database or upstream access.
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { diffReport, parseOffset, readInfloww, readOurs } from './infloww-diff.js';

const USAGE = 'usage: analytics:diff --ours <dir> --infloww <file.csv> [--tz <offset, e.g. +02:00>]';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const { values } = parseArgs({ options: { ours: { type: 'string' }, infloww: { type: 'string' }, tz: { type: 'string' } } });
if (!values.ours || !values.infloww) fail(USAGE);
const offset = parseOffset(values.tz ?? 'UTC');
if (offset === null) fail(`--tz takes an offset such as UTC, +02:00 or -5\n${USAGE}`);
// pnpm runs scripts in apps/api; relative paths are taken from where the command was typed.
const base = process.env.INIT_CWD ?? process.cwd();
const oursDir = resolve(base, values.ours);
const inflowwFile = resolve(base, values.infloww);
if (['.xlsx', '.xls'].includes(extname(inflowwFile).toLowerCase())) {
  fail(
    `${inflowwFile} is a spreadsheet and this tool reads CSV only (no xlsx reader in the repo). Open it in Excel, ` +
      'Numbers or Google Sheets and export the sheet as CSV (UTF-8), then pass the .csv file.',
  );
}

try {
  const read = (name: string) => readFile(join(oursDir, name), 'utf8');
  const ours = readOurs({ messages: await read('messages.csv'), replyTimes: await read('reply_times.csv'), chats: await read('chats.csv') });
  const infloww = readInfloww(await readFile(inflowwFile, 'utf8'), offset);
  const sign = offset < 0 ? '-' : '+';
  const tz = `UTC${sign}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}:${String(Math.abs(offset) % 60).padStart(2, '0')}`;
  console.log(diffReport(ours, infloww, tz).lines.join('\n'));
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
