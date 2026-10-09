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
} from '../src/cli/analytics-csv.js';

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
