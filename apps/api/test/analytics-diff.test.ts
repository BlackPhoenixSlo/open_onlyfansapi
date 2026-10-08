import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHAT_COLUMNS,
  csvField,
  exportFiles,
  MESSAGE_COLUMNS,
  parseCsv,
  REPLY_TIME_COLUMNS,
  toCsv,
  TRANSACTION_COLUMNS,
  type ExportMessage,
} from '../src/cli/analytics-csv.js';
import { diffReport, joinRows, mapHeaders, parseDuration, parseOffset, parseSentAt, readInfloww, readOurs } from '../src/cli/infloww-diff.js';
import { fanTurns } from '../src/modules/analytics/turns.js';

const api = new URL('../', import.meta.url).pathname;

describe('analytics CSV', () => {
  it('quotes commas, quotes and line breaks; null is empty; dates are ISO', () => {
    expect(['plain', 'a,b', 'say "hi"', 'two\nlines', 'cr\r', null, undefined, 42, true].map(csvField)).toEqual([
      'plain',
      '"a,b"',
      '"say ""hi"""',
      '"two\nlines"',
      '"cr\r"',
      '',
      '',
      '42',
      'true',
    ]);
    expect(csvField(new Date('2026-09-01T10:00:00Z'))).toBe('2026-09-01T10:00:00.000Z');
    const csv = toCsv(['a', 'b'], [{ a: 'x,"y"', b: 'line\r\nbreak' }, { a: null }]);
    expect(parseCsv(csv)).toEqual([['a', 'b'], ['x,"y"', 'line\r\nbreak'], ['', '']]);
  });

  it('reads a BOM, CRLF and an Excel semicolon file', () => {
    expect(parseCsv('﻿a;b\r\n"1;2";3\r\n')).toEqual([['a', 'b'], ['1;2', '3']]);
  });

  it('writes the four files with their column sets, empty or not', () => {
    const empty = exportFiles({ messages: [], chats: [], transactions: [], turns: [] });
    expect(Object.keys(empty).sort()).toEqual(['chats.csv', 'messages.csv', 'reply_times.csv', 'transactions.csv']);
    expect(empty['messages.csv']).toBe(MESSAGE_COLUMNS.join(',') + '\n');
    expect(empty['chats.csv']).toBe(CHAT_COLUMNS.join(',') + '\n');
    expect(empty['transactions.csv']).toBe(TRANSACTION_COLUMNS.join(',') + '\n');
    expect(empty['reply_times.csv']).toBe(REPLY_TIME_COLUMNS.join(',') + '\n');
    const tx = exportFiles({
      messages: [],
      chats: [],
      transactions: [
        { txId: 'tx,1', createdAt: new Date(0), kind: 'tips', grossCents: 100, netCents: 80, currency: 'USD', fanId: null, fanIdSource: null },
      ],
      turns: [],
    });
    expect(tx['transactions.csv'].split('\n')[1]).toBe('"tx,1",1970-01-01T00:00:00.000Z,tips,100,80,USD,,');
  });
});

describe('Infloww export parsing', () => {
  it('maps the Message Dashboard headers, then aliases, and reports the rest', () => {
    const real = ['Sender', 'Creator', 'Fans Message', 'Creator Message', 'Sent time', 'Sent date', 'Replay time', 'Price', 'Purchased', 'Status', 'Sent to'];
    const m = mapHeaders(real);
    expect(m.columns).toMatchObject({ sentTime: 'Sent time', sentDate: 'Sent date', replyTime: 'Replay time', fan: 'Sent to', sender: 'Sender', price: 'Price' });
    expect(m.missing).toEqual(['messageId']);
    expect(m.unused).toEqual([]);

    const other = mapHeaders(['Message ID', 'DATE', 'time', 'Reply Time (min)', 'Employee', 'Fan', 'Price ($)', 'Notes']);
    expect(other.columns).toEqual({
      messageId: 'Message ID',
      sentDate: 'DATE',
      sentTime: 'time',
      replyTime: 'Reply Time (min)',
      sender: 'Employee',
      fan: 'Fan',
      price: 'Price ($)',
    });
    expect(other.unused).toEqual(['Notes']);
  });

  it('reads Infloww times, durations and offsets', () => {
    expect(parseSentAt('Aug 21, 2024 23:20:54')?.toISOString()).toBe('2024-08-21T23:20:54.000Z');
    expect(parseSentAt('Aug 21, 2024 23:20:54', 120)?.toISOString()).toBe('2024-08-21T21:20:54.000Z');
    expect(parseSentAt('21 August 2024 11:20 pm')?.toISOString()).toBe('2024-08-21T23:20:00.000Z');
    expect(parseSentAt('2024-08-21T23:20:54+02:00', 300)?.toISOString()).toBe('2024-08-21T21:20:54.000Z');
    expect([parseSentAt('Aug 21, 2024'), parseSentAt('soon')]).toEqual([null, null]);
    expect(['1m 49s', '1h 2m 3s', '2 mins', '00:01:49', '01:49', '90', '', '-'].map(parseDuration)).toEqual([109, 3723, 120, 109, 109, 90, null, null]);
    expect(['UTC', '+02:00', '-5', 'utc+5:30', 'Europe/Paris'].map(parseOffset)).toEqual([0, 120, -300, 330, null]);
  });
});

// Our side: three chats on 2026-09-01 (UTC).
const at = (hhmm: string) => new Date(`2026-09-01T${hhmm}:00.000Z`);
let nextId = 100;
const msg = (chatId: number, hhmm: string, direction: 'inbound' | 'outbound', over: Partial<ExportMessage> = {}): ExportMessage => ({
  messageId: ++nextId,
  chatId,
  createdAt: at(hhmm),
  direction,
  isMass: false,
  queueId: null,
  isAutomated: false,
  automatedReason: null,
  priceCents: 0,
  isTip: false,
  mediaCount: 0,
  textHash: null,
  ...over,
});
const messages = [
  msg(2001, '09:00', 'outbound', { isAutomated: true, automatedReason: 'welcome' }), // 101
  msg(2001, '10:00', 'inbound'),
  msg(2001, '10:05', 'inbound'),
  msg(2001, '10:10', 'outbound'), // 104: a reply, 600 s from the first fan message, 300 s from the last
  msg(2001, '11:00', 'outbound', { isMass: true, queueId: 900 }), // 105
  msg(2002, '12:00', 'inbound'),
  msg(2002, '12:30', 'outbound', { priceCents: 1999 }), // 107: a PPV reply, 1800 s
  msg(2002, '13:00', 'outbound'), // 108: a follow-up, no turn
  msg(2003, '14:00', 'inbound'),
  msg(2003, '14:20', 'outbound'), // 110: a reply Infloww does not list
];
const turns = fanTurns(messages, { asOf: at('23:00') });
const files = exportFiles({
  messages,
  chats: [2001, 2002, 2003].map((chatId) => ({ chatId, fanUsername: null, oldestMessageId: null, oldestAt: null, reachedStart: true, walkedAt: at('23:00') })),
  transactions: [],
  turns,
});
const ours = readOurs({ messages: files['messages.csv'], replyTimes: files['reply_times.csv'], chats: files['chats.csv'] });

const HEADER = 'Sender,Creator,Fans Message,Creator Message,Sent time,Sent date,Replay time,Price,Purchased,Status,Sent to';
const INFLOWW = [
  HEADER,
  'Anna,Model,"hey, you there?",yes babe,10:10:20,"Sep 1, 2026",5m 0s,0,no,Sent,fan_a', // 104, timer from the last fan message
  'Ben,Model,hi,"PPV ""special""",12:30:30,"Sep 1, 2026",30m 0s,19.99,yes,Sent,fan_b', // 107, agrees
  'Ben,Model,,later,13:00:10,"Sep 1, 2026",,0,no,Sent,fan_b', // 108, no reply either side
  'Cara,Model,u up,hey,13:30:00,"Sep 1, 2026",2m 0s,0,no,Sent,fan_c', // nothing of ours near
  'Cara,Model,x,oops,13:45:00,"Sep 1, 2026",1m,0,no,Withdrawn,fan_c',
  'Dan,Model,yo,hi,10:00:00,"Aug 30, 2026",,0,no,Sent,fan_d', // before our range
].join('\n');

describe('Infloww diff', () => {
  it('joins by time and price, classifies every difference, and summarises', () => {
    const report = diffReport(ours, readInfloww(INFLOWW));
    expect(report.summary).toEqual({
      matched: 3,
      byId: 0,
      byTime: 3,
      ambiguous: 0,
      oursOnly: 3,
      inflowwOnly: 3,
      explained: 5,
      unresolved: 2,
      byRule: { welcome: 1, mass: 1, lastFanMessage: 1, withdrawn: 1, outsideRange: 1 },
    });
    const diffs = report.lines.slice(report.lines.indexOf('differences:') + 1, report.lines.indexOf('summary:') - 1);
    expect(diffs).toEqual([
      'infloww-only  line 7 2026-08-30T10:00:00Z sender "Dan" to "fan_d" price 0 reply n/a -> explained: outside the time span of our messages.csv',
      'ours-only     msg 101 chat 2001 2026-09-01T09:00:00Z price 0 -> explained: Infloww excludes welcome messages (§7)',
      "reply time    msg 104 chat 2001 2026-09-01T10:10:00Z: ours 600 s from the first / 300 s from the last fan message, Infloww 300 s (line 2) -> explained: Infloww starts the clock at the first unanswered fan message, moved later if the chat was marked read (§8); here it matches ours from the turn's last fan message",
      'ours-only     msg 105 chat 2001 2026-09-01T11:00:00Z price 0 -> explained: Infloww excludes mass messages from DMs (§7)',
      'infloww-only  line 5 2026-09-01T13:30:00Z sender "Cara" to "fan_c" price 0 reply 120 s -> unresolved (no send of ours within ±60 s at this price)',
      'infloww-only  line 6 2026-09-01T13:45:00Z sender "Cara" to "fan_c" price 0 reply 60 s -> explained: withdrawn in Infloww: an unsent message is gone from OF history (spec §2)',
      'ours-only     msg 110 chat 2003 2026-09-01T14:20:00Z price 0 (a reply) -> unresolved (a reply Infloww does not list: sent outside Infloww? It sees only its own sends (§4))',
    ]);
    expect(report.lines).toContain('  could not map: message id');
    expect(report.lines[0]).toBe('Infloww columns:'); // every sent time was readable
    expect(report.lines.some((l) => l.includes('never by text'))).toBe(true);

    expect(report.replyTime).toEqual({
      ours: { replied: 3, meanFirst: 1200, meanLast: 1100, median: 1200, p90: 1680, perMessageMean: 975 },
      infloww: { rows: 4, mean: 570 },
    });
    expect(report.lines.join('\n')).toMatch(/median, replied within reply_cap\s+1200 s\s+n\/a/);
    expect(report.lines.at(-1)).toBe("  closest to Infloww's mean: timer from the last fan message (off by 530 s)");
  });

  it('joins by message id when the export has one, and flags a price that differs', () => {
    const csv = ['Message ID,Date,Price,Reply time', '107,2026-09-01 12:30:00,25.00,30m', '999,2026-09-01 13:00:05,0,'].join('\n');
    const report = diffReport(ours, readInfloww(csv));
    expect(report.summary).toMatchObject({ matched: 2, byId: 1, byTime: 1, inflowwOnly: 0 });
    expect(report.lines).toContain('price         msg 107 chat 2002 2026-09-01T12:30:00Z: ours 1999, Infloww 2500 (line 2) -> unresolved');
    expect(report.lines.some((l) => l.includes('could not map:') && l.includes('sent time'))).toBe(true);
  });

  it('takes median and p90 over turns replied within the cap, and the means over every replied turn', () => {
    const late = [
      msg(3001, '00:00', 'inbound'),
      msg(3001, '13:00', 'outbound'), // late: 13 h, past the 12 h cap
      msg(3002, '00:00', 'inbound'),
      msg(3002, '00:10', 'outbound'), // in cap: 600 s
      msg(3003, '22:00', 'inbound'), // pending at 23:00
    ];
    const f = exportFiles({ messages: late, chats: [], transactions: [], turns: fanTurns(late, { asOf: at('23:00') }) });
    expect(f['reply_times.csv'].split('\n').slice(1, -1).map((l) => l.split(',').slice(4, 6).join(','))).toEqual(['late,false', 'in_cap,false', 'pending,false']);
    const report = diffReport(readOurs({ messages: f['messages.csv'], replyTimes: f['reply_times.csv'], chats: f['chats.csv'] }), readInfloww(HEADER));
    expect(report.replyTime.ours).toMatchObject({ replied: 2, meanFirst: (46_800 + 600) / 2, median: 600, p90: 600 });
  });

  it('prefers the candidate whose chat has the fan username in "Sent to"', () => {
    const near = msg(4001, '15:00', 'outbound');
    const far = { ...msg(4002, '15:00', 'outbound'), createdAt: new Date(at('15:00').getTime() + 30_000) };
    const f = exportFiles({
      messages: [near, far],
      chats: [
        { chatId: 4001, fanUsername: 'fan_a', oldestMessageId: null, oldestAt: null, reachedStart: true, walkedAt: at('23:00') },
        { chatId: 4002, fanUsername: 'fan_b', oldestMessageId: null, oldestAt: null, reachedStart: true, walkedAt: at('23:00') },
      ],
      transactions: [],
      turns: [],
    });
    expect(f['chats.csv'].split('\n')[1]!.startsWith('4001,fan_a,')).toBe(true);
    const o = readOurs({ messages: f['messages.csv'], replyTimes: f['reply_times.csv'], chats: f['chats.csv'] });
    const rows = readInfloww([HEADER, 'Ben,Model,,hi,15:00:00,"Sep 1, 2026",,0,no,Sent,@Fan_B'].join('\n')).rows;
    expect(joinRows(o.sends, rows).pairs.map((p) => p.ours.chatId)).toEqual([4001]); // nearest, without usernames
    expect(joinRows(o.sends, rows, o.chats).pairs.map((p) => p.ours.chatId)).toEqual([4002]);
    expect(diffReport(o, { headers: readInfloww(HEADER).headers, rows }).summary).toMatchObject({ matched: 1, oursOnly: 1 });
  });

  it('warns first when most sent times are unreadable', () => {
    const csv = [HEADER, 'Ann,Model,,hi,10:10,01/09/2026,,0,no,Sent,fan_a', 'Ann,Model,,hi,10:11,01/09/2026,,0,no,Sent,fan_a'].join('\n');
    expect(diffReport(ours, readInfloww(csv)).lines[0]).toBe(
      'warning: 2 of 2 Infloww rows have no readable sent time; expected a date like "Aug 21, 2024" and a time like "23:20:54" (Sent date + Sent time)',
    );
  });

  it('reports n/a for Infloww without a reply time column', () => {
    const report = diffReport(ours, readInfloww('Sent date,Sent time,Price\n"Sep 1, 2026",10:10:00,0\n'));
    expect(report.replyTime.infloww).toBeNull();
    expect(report.lines.join('\n')).toMatch(/mean, timer from the first fan message\s+1200 s\s+n\/a \(no reply time column\)/);
  });
});

describe('analytics:diff CLI', () => {
  const run = (...args: string[]) => spawnSync(join(api, 'node_modules/.bin/tsx'), ['src/cli/analytics-diff.ts', ...args], { cwd: api, encoding: 'utf8', env: { ...process.env, INIT_CWD: api } });

  it('prints the report and exits 0 with unresolved rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'analytics-diff-'));
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    writeFileSync(join(dir, 'infloww.csv'), INFLOWW);
    const res = run('--ours', dir, '--infloww', join(dir, 'infloww.csv'));
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/unresolved {4}2/);
  });

  it('asks for a CSV when given the .xlsx', () => {
    const res = run('--ours', '/tmp', '--infloww', '/tmp/Message_Dashboard.xlsx');
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/export the sheet as CSV/);
  });
});
