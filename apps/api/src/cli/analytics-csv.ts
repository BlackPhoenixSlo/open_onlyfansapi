// The four CSVs of the analytics step 0 export (docs/analytics-backfill.md), and a reader for them and for an Infloww
// export. RFC 4180 quoting, no dependency. No database access, so the diff runs without one.
import type { chatCoverage, messageFact, purchaseFact } from '../db/schema.js';
import type { FanTurn } from '../modules/analytics/turns.js';

export const MESSAGE_COLUMNS = [
  'message_id',
  'chat_id',
  'created_at',
  'direction',
  'is_mass',
  'queue_id',
  'is_automated',
  'automated_reason',
  'price_cents',
  'is_tip',
  'media_count',
  'text_hash',
] as const;
export const CHAT_COLUMNS = [
  'chat_id',
  'fan_username',
  'oldest_message_id',
  'oldest_at',
  'reached_start',
  'walked_at',
  'messages_total',
  'inbound',
  'outbound',
  'dm',
  'mass',
  'automated',
] as const;
export const TRANSACTION_COLUMNS = ['tx_id', 'created_at', 'kind', 'gross_cents', 'net_cents', 'currency', 'fan_id', 'fan_id_source'] as const;
export const REPLY_TIME_COLUMNS = ['chat_id', 'inbound_at', 'dm_at', 'wait_seconds', 'status', 'breached', 'is_automated'] as const;

type Message = typeof messageFact.$inferSelect;
export type ExportMessage = Pick<
  Message,
  'messageId' | 'chatId' | 'createdAt' | 'direction' | 'isMass' | 'queueId' | 'isAutomated' | 'automatedReason' | 'priceCents' | 'isTip' | 'mediaCount' | 'textHash'
>;
export type ExportChat = Pick<typeof chatCoverage.$inferSelect, 'chatId' | 'fanUsername' | 'oldestMessageId' | 'oldestAt' | 'reachedStart' | 'walkedAt'>;
export type ExportTransaction = Pick<
  typeof purchaseFact.$inferSelect,
  'txId' | 'createdAt' | 'kind' | 'grossCents' | 'netCents' | 'currency' | 'fanId' | 'fanIdSource'
>;
export type ExportData = {
  /** The range's messages only. */
  messages: ExportMessage[];
  /** Every chat the account's walks covered; the counts are over `messages`. */
  chats: ExportChat[];
  transactions: ExportTransaction[];
  turns: FanTurn[];
};

/** One field: empty for null, ISO for a date, quoted when it holds a quote, comma or line break. */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = value instanceof Date ? value.toISOString() : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCsv(columns: readonly string[], rows: Record<string, unknown>[]): string {
  return [columns, ...rows.map((r) => columns.map((c) => r[c]))].map((line) => line.map(csvField).join(',') + '\n').join('');
}

/** The file contents, keyed by file name. */
export function exportFiles(data: ExportData): Record<'messages.csv' | 'chats.csv' | 'transactions.csv' | 'reply_times.csv', string> {
  const counts = new Map<number, { messages_total: number; inbound: number; outbound: number; dm: number; mass: number; automated: number }>();
  for (const m of data.messages) {
    const c = counts.get(m.chatId) ?? { messages_total: 0, inbound: 0, outbound: 0, dm: 0, mass: 0, automated: 0 };
    c.messages_total++;
    c[m.direction]++;
    if (m.isMass) c.mass++;
    if (m.isAutomated) c.automated++;
    if (m.direction === 'outbound' && !m.isMass && !m.isAutomated) c.dm++;
    counts.set(m.chatId, c);
  }
  const none = { messages_total: 0, inbound: 0, outbound: 0, dm: 0, mass: 0, automated: 0 };
  return {
    'messages.csv': toCsv(
      MESSAGE_COLUMNS,
      data.messages.map((m) => ({
        message_id: m.messageId,
        chat_id: m.chatId,
        created_at: m.createdAt,
        direction: m.direction,
        is_mass: m.isMass,
        queue_id: m.queueId,
        is_automated: m.isAutomated,
        automated_reason: m.automatedReason,
        price_cents: m.priceCents,
        is_tip: m.isTip,
        media_count: m.mediaCount,
        text_hash: m.textHash,
      })),
    ),
    'chats.csv': toCsv(
      CHAT_COLUMNS,
      data.chats.map((c) => ({
        chat_id: c.chatId,
        fan_username: c.fanUsername,
        oldest_message_id: c.oldestMessageId,
        oldest_at: c.oldestAt,
        reached_start: c.reachedStart,
        walked_at: c.walkedAt,
        ...(counts.get(c.chatId) ?? none),
      })),
    ),
    'transactions.csv': toCsv(
      TRANSACTION_COLUMNS,
      data.transactions.map((t) => ({
        tx_id: t.txId,
        created_at: t.createdAt,
        kind: t.kind,
        gross_cents: t.grossCents,
        net_cents: t.netCents,
        currency: t.currency,
        fan_id: t.fanId,
        fan_id_source: t.fanIdSource,
      })),
    ),
    'reply_times.csv': toCsv(
      REPLY_TIME_COLUMNS,
      data.turns.map((t) => ({
        chat_id: t.chatId,
        inbound_at: t.inboundAt,
        dm_at: t.dmAt,
        wait_seconds: t.waitSeconds,
        status: t.status,
        breached: t.status === 'breached',
        is_automated: t.isAutomated,
      })),
    ),
  };
}

/** Rows of fields. Strips a BOM; takes `;` as the delimiter when the header has more of them than commas (Excel). */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const header = src.slice(0, src.search(/\r?\n|$/));
  const delimiter = header.split(';').length > header.split(',').length ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c !== '"') field += c;
      else if (src[i + 1] === '"') field += src[++i];
      else quoted = false;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) rows.push([...row, field]);
  return rows.filter((r) => r.length > 1 || r[0] !== '');
}

/** Rows keyed by the header line's names. */
export function readCsv(text: string): Record<string, string>[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  return rows.map((r) => Object.fromEntries(header.map((name, i) => [name, r[i] ?? ''])));
}
