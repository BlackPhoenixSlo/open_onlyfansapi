// The step 0 diff (docs/analytics-backfill.md): our CSVs against an Infloww Message Dashboard export. Every
// difference is explained by a rule from docs/spec/infloww-definitions.md (RULES) or listed as unresolved.
// Pure: the analytics:diff CLI reads the files and prints the lines.
import { readCsv } from './analytics-csv.js';

/** Seconds: how far apart two send times may be to join, and two reply times to agree. */
const TOLERANCE_S = 60;

export type Field =
  | 'sentDate'
  | 'sentTime'
  | 'replyTime'
  | 'price'
  | 'sender'
  | 'fan'
  | 'status'
  | 'purchased'
  | 'creator'
  | 'fanText'
  | 'creatorText'
  | 'messageId';

/**
 * Infloww export columns, matched case-insensitively with punctuation ignored: an exact name first, then a header
 * starting with one. The first name is the Message Dashboard export's own (seen in a real .xlsx); the rest are
 * guesses for other exports.
 */
export const ALIASES: Record<Field, string[]> = {
  sentDate: ['sent date', 'date'],
  sentTime: ['sent time', 'time', 'sent at', 'date time', 'created at'],
  replyTime: ['replay time', 'reply time', 'response time'], // "Replay" is Infloww's spelling
  price: ['price', 'ppv price'],
  sender: ['sender', 'employee', 'sent by'],
  fan: ['sent to', 'fan', 'fan id', 'recipient'],
  status: ['status'],
  purchased: ['purchased'],
  creator: ['creator'],
  fanText: ['fans message', 'fan message'],
  creatorText: ['creator message'],
  messageId: ['message id', 'id', 'msg id'],
};

const FIELDS = Object.keys(ALIASES) as Field[];
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const label = (f: Field) => f.replace(/[A-Z]/g, (c) => ' ' + c.toLowerCase());

export type HeaderMap = { columns: Partial<Record<Field, string>>; missing: Field[]; unused: string[] };

export function mapHeaders(headers: string[]): HeaderMap {
  const columns: Partial<Record<Field, string>> = {};
  const used = new Set<string>();
  const passes = [(h: string, a: string) => h === a, (h: string, a: string) => h.startsWith(a + ' ')];
  for (const match of passes) {
    for (const field of FIELDS) {
      if (columns[field] !== undefined) continue;
      for (const alias of ALIASES[field]) {
        const header = headers.find((h) => !used.has(h) && match(norm(h), norm(alias)));
        if (header === undefined) continue;
        columns[field] = header;
        used.add(header);
        break;
      }
    }
  }
  return { columns, missing: FIELDS.filter((f) => columns[f] === undefined), unused: headers.filter((h) => !used.has(h)) };
}

/** `UTC`, `Z`, `+02:00`, `-5`, `UTC+5:30` → minutes east of UTC; null if unreadable. */
export function parseOffset(tz: string): number | null {
  const s = tz.trim().toUpperCase().replace(/^(UTC|GMT)/, '');
  if (s === '' || s === 'Z') return 0;
  const m = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(s);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const CLOCK = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)? ?([ap]m)?(?: ?(Z|[+-]\d{2}:?\d{2}))?$/i;
const DATE_FORMS: [RegExp, (m: RegExpExecArray) => [number, number, number]][] = [
  [/^(\d{4})-(\d{2})-(\d{2})[ T]/, (m) => [+m[1]!, +m[2]!, +m[3]!]],
  [/^([a-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4}),? /i, (m) => [+m[3]!, MONTHS.indexOf(m[1]!.toLowerCase()) + 1, +m[2]!]], // Aug 21, 2024
  [/^(\d{1,2}) ([a-z]{3})[a-z]*\.?,? (\d{4}),? /i, (m) => [+m[3]!, MONTHS.indexOf(m[2]!.toLowerCase()) + 1, +m[1]!]], // 21 Aug 2024
];

/**
 * A send time from Infloww's date and time columns joined by a space (`Aug 21, 2024 23:20:54`, or one ISO value).
 * Read in the report's time zone, `offsetMinutes` east of UTC, unless the value carries its own zone.
 * Null if unreadable.
 */
export function parseSentAt(text: string, offsetMinutes = 0): Date | null {
  const s = text.trim().replace(/\s+/g, ' ');
  for (const [form, ymd] of DATE_FORMS) {
    const d = form.exec(s);
    if (!d) continue;
    const t = CLOCK.exec(s.slice(d[0].length));
    if (!t) return null;
    const [y, mo, day] = ymd(d);
    let h = Number(t[1]);
    if (t[4]) h = (h % 12) + (t[4].toLowerCase() === 'pm' ? 12 : 0);
    const offset = t[5] ? parseOffset(t[5])! : offsetMinutes;
    const ms = Date.UTC(y, mo - 1, day, h, Number(t[2]), Number(t[3] ?? 0)) - offset * 60_000;
    return mo >= 1 && Number.isFinite(ms) ? new Date(ms) : null;
  }
  return null;
}

/** `1m 49s`, `2h 3m`, `1d 2h`, `01:49`, `0:01:49`, or bare seconds → seconds; null when empty or unreadable. */
export function parseDuration(text: string): number | null {
  const s = text.trim().toLowerCase();
  const clock = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(s);
  if (clock) return clock[3] === undefined ? +clock[1]! * 60 + +clock[2]! : +clock[1]! * 3600 + +clock[2]! * 60 + +clock[3]!;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const unit: Record<string, number> = { d: 86_400, h: 3600, m: 60, s: 1 };
  let total = 0;
  let found = false;
  for (const [, n, u] of s.matchAll(/(\d+(?:\.\d+)?)\s*([dhms])[a-z]*/g)) {
    total += Number(n) * unit[u!]!;
    found = true;
  }
  return found ? total : null;
}

/** `0`, `$12.50`, `1,234.00` → cents; null when empty. */
export function parsePrice(text: string): number | null {
  const s = text.replace(/[^0-9.-]/g, '');
  const n = Number(s);
  return s && Number.isFinite(n) ? Math.round(n * 100) : null;
}

export type InflowwRow = {
  /** The line in the export (1 = header). */
  line: number;
  sentAt: Date | null;
  replySeconds: number | null;
  priceCents: number | null;
  sender: string;
  fan: string;
  status: string;
  messageId: number | null;
};

export function readInfloww(text: string, offsetMinutes = 0): { headers: HeaderMap; rows: InflowwRow[] } {
  const records = readCsv(text);
  const headers = mapHeaders(Object.keys(records[0] ?? {}));
  const get = (r: Record<string, string>, f: Field) => {
    const col = headers.columns[f];
    return col === undefined ? '' : (r[col] ?? '').trim();
  };
  const rows = records.map((r, i) => {
    const id = get(r, 'messageId');
    return {
      line: i + 2,
      sentAt: parseSentAt([get(r, 'sentDate'), get(r, 'sentTime')].filter(Boolean).join(' '), offsetMinutes),
      replySeconds: parseDuration(get(r, 'replyTime')),
      priceCents: parsePrice(get(r, 'price')),
      sender: get(r, 'sender'),
      fan: get(r, 'fan'),
      status: get(r, 'status'),
      messageId: /^\d+$/.test(id) ? Number(id) : null,
    };
  });
  return { headers, rows };
}

/** `status`: reply_times.csv's, `in_cap` or `late` for a replied turn. */
type TurnWaits = { firstWait: number; lastWait: number; status: string };

/** One outbound message of ours (messages.csv), with the fan turn it ended, if any (reply_times.csv). */
export type OurSend = {
  messageId: number;
  chatId: number;
  createdAt: Date;
  isMass: boolean;
  isAutomated: boolean;
  automatedReason: string;
  queueId: number | null;
  priceCents: number;
  /** Set when this DM ended a fan turn: the wait from the turn's first and from its last inbound message. */
  turn: TurnWaits | null;
  /** A DM ending no turn, right after a turn its chat closed with a scheduled (queued 1:1) DM. */
  afterScheduledReply: boolean;
};

export type Ours = {
  sends: OurSend[];
  /** Replied turns (reply_times.csv rows with a DM: `in_cap` and `late`). */
  replied: TurnWaits[];
  /** Each inbound message to the DM that answered it (spec §2 "Per-message reply time"). */
  perMessageWaits: number[];
  chats: Map<number, { fanUsername: string | null; oldestAt: Date | null; reachedStart: boolean }>;
  /** The first and last message time in messages.csv. */
  range: [number, number] | null;
};

const bool = (v: string | undefined) => v === 'true';

/** Our side, from the texts of messages.csv, reply_times.csv and chats.csv. */
export function readOurs(files: { messages: string; replyTimes: string; chats: string }): Ours {
  const messages = readCsv(files.messages)
    .map((r) => ({ r, id: Number(r.message_id), chat: Number(r.chat_id), at: new Date(r.created_at ?? '') }))
    .sort((a, b) => a.at.getTime() - b.at.getTime() || a.id - b.id);
  const turnsByDm = new Map<string, { firstWait: number; status: string }>();
  for (const t of readCsv(files.replyTimes)) {
    if (t.dm_at) turnsByDm.set(`${t.chat_id}|${t.dm_at}`, { firstWait: Number(t.wait_seconds), status: t.status ?? '' });
  }

  const sends: OurSend[] = [];
  const replied: TurnWaits[] = [];
  const perMessageWaits: number[] = [];
  const chatState = new Map<number, { inbound: Date[]; scheduledReply: boolean }>();
  for (const { r, id, chat, at } of messages) {
    const state = chatState.get(chat) ?? { inbound: [], scheduledReply: false };
    chatState.set(chat, state);
    if (r.direction === 'inbound') {
      state.inbound.push(at);
      state.scheduledReply = false;
      continue;
    }
    const send: OurSend = {
      messageId: id,
      chatId: chat,
      createdAt: at,
      isMass: bool(r.is_mass),
      isAutomated: bool(r.is_automated),
      automatedReason: r.automated_reason ?? '',
      queueId: r.queue_id ? Number(r.queue_id) : null,
      priceCents: Number(r.price_cents),
      turn: null,
      afterScheduledReply: false,
    };
    sends.push(send);
    if (send.isMass || send.isAutomated) continue;
    // A DM: it ends the open turn, if any.
    const turn = turnsByDm.get(`${chat}|${r.created_at}`);
    const lastInbound = state.inbound.at(-1);
    if (turn) {
      send.turn = { ...turn, lastWait: lastInbound ? (at.getTime() - lastInbound.getTime()) / 1000 : turn.firstWait };
      replied.push(send.turn);
    } else send.afterScheduledReply = state.scheduledReply;
    for (const inboundAt of state.inbound) perMessageWaits.push((at.getTime() - inboundAt.getTime()) / 1000);
    state.inbound = [];
    state.scheduledReply = turn !== undefined && send.queueId !== null;
  }

  const chats = new Map(
    readCsv(files.chats).map((c) => [
      Number(c.chat_id),
      { fanUsername: c.fan_username || null, oldestAt: c.oldest_at ? new Date(c.oldest_at) : null, reachedStart: bool(c.reached_start) },
    ]),
  );
  const range: [number, number] | null = messages.length ? [messages[0]!.at.getTime(), messages.at(-1)!.at.getTime()] : null;
  return { sends, replied, perMessageWaits, chats, range };
}

export type Pair = { ours: OurSend; theirs: InflowwRow; by: 'id' | 'time'; candidates: number };

const close = (a: number, b: number) => Math.abs(a - b) <= TOLERANCE_S;
const replyAgrees = (s: OurSend, r: InflowwRow) =>
  r.replySeconds === null ? s.turn === null : s.turn !== null && (close(s.turn.firstWait, r.replySeconds) || close(s.turn.lastWait, r.replySeconds));

/** `@Name` and `name` are the same username. */
const sameUser = (a: string, b: string | null | undefined) => !!b && a.replace(/^@/, '').toLowerCase() === b.replace(/^@/, '').toLowerCase();

/**
 * Joins by message id when the export has one, else by send time within ±60 s and the same price (and the same fan
 * when the export's fan is a numeric id). Among several candidates: a chat whose fan username (chats.csv) is the
 * row's `Sent to`, then a reply time that agrees, then a DM, then the nearest time.
 */
export function joinRows(
  sends: OurSend[],
  rows: InflowwRow[],
  chats: Ours['chats'] = new Map(),
): { pairs: Pair[]; oursOnly: OurSend[]; inflowwOnly: InflowwRow[] } {
  const byId = new Map(sends.map((s) => [s.messageId, s]));
  const used = new Set<OurSend>();
  const pairs: Pair[] = [];
  const pending: InflowwRow[] = [];
  for (const r of rows) {
    const s = r.messageId === null ? undefined : byId.get(r.messageId);
    if (s && !used.has(s)) {
      used.add(s);
      pairs.push({ ours: s, theirs: r, by: 'id', candidates: 1 });
    } else pending.push(r);
  }

  const sorted = [...sends].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const window = TOLERANCE_S * 1000;
  const inflowwOnly: InflowwRow[] = [];
  for (const r of pending.sort((a, b) => (a.sentAt?.getTime() ?? 0) - (b.sentAt?.getTime() ?? 0))) {
    if (!r.sentAt) {
      inflowwOnly.push(r);
      continue;
    }
    const t = r.sentAt.getTime();
    let lo = 0;
    for (let hi = sorted.length; lo < hi; ) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]!.createdAt.getTime() < t - window) lo = mid + 1;
      else hi = mid;
    }
    const candidates: OurSend[] = [];
    for (let i = lo; i < sorted.length && sorted[i]!.createdAt.getTime() <= t + window; i++) {
      const s = sorted[i]!;
      if (used.has(s) || (r.priceCents !== null && s.priceCents !== r.priceCents)) continue;
      if (/^\d+$/.test(r.fan) && Number(r.fan) !== s.chatId) continue;
      candidates.push(s);
    }
    const score = (s: OurSend) =>
      [
        sameUser(r.fan, chats.get(s.chatId)?.fanUsername) ? 0 : 1,
        replyAgrees(s, r) ? 0 : 1,
        s.isMass || s.isAutomated ? 1 : 0,
        Math.abs(s.createdAt.getTime() - t),
      ] as const;
    const best = candidates
      .map((s) => ({ s, k: score(s) }))
      .sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.k[2] - b.k[2] || a.k[3] - b.k[3])[0]?.s;
    if (!best) {
      inflowwOnly.push(r);
      continue;
    }
    used.add(best);
    pairs.push({ ours: best, theirs: r, by: 'time', candidates: candidates.length });
  }
  return { pairs, oursOnly: sends.filter((s) => !used.has(s)), inflowwOnly };
}

export type Diff =
  | { kind: 'ours-only'; ours: OurSend }
  | { kind: 'infloww-only'; theirs: InflowwRow }
  | { kind: 'reply-time'; ours: OurSend; theirs: InflowwRow }
  | { kind: 'price'; ours: OurSend; theirs: InflowwRow };

type Ctx = Pick<Ours, 'chats' | 'range'>;
type Rule = { explains: string; when: (d: Diff, ctx: Ctx) => boolean };

/**
 * The first rule that holds explains a difference; none = unresolved. § = infloww-definitions.md. Infloww's export
 * has one row per reply, and its client counts a reply once per fan turn (the first chatter send after a fan
 * message); mass and scheduled sends never close its turn.
 */
export const RULES: Record<string, Rule> = {
  mass: { explains: 'Infloww excludes mass messages from DMs (§7)', when: (d) => d.kind === 'ours-only' && d.ours.isMass },
  welcome: { explains: 'Infloww excludes welcome messages (§7)', when: (d) => d.kind === 'ours-only' && d.ours.automatedReason === 'welcome' },
  automated: { explains: 'Infloww excludes automated messages (§7)', when: (d) => d.kind === 'ours-only' && d.ours.isAutomated },
  scheduled: {
    explains: 'a scheduled send: it never closes a turn in Infloww, so Infloww has no reply row for it',
    when: (d) => d.kind === 'ours-only' && d.ours.queueId !== null,
  },
  notAReply: {
    explains: "Infloww's export has one row per reply, and this DM ended no fan turn",
    when: (d) => d.kind === 'ours-only' && d.ours.turn === null,
  },
  withdrawn: {
    explains: 'withdrawn in Infloww: an unsent message is gone from OF history (spec §2)',
    when: (d) => d.kind === 'infloww-only' && /withdr|unsen|delet/i.test(d.theirs.status),
  },
  outsideRange: {
    explains: 'outside the time span of our messages.csv',
    when: (d, ctx) => {
      const t = d.kind === 'infloww-only' ? d.theirs.sentAt?.getTime() : undefined;
      return t !== undefined && ctx.range !== null && (t < ctx.range[0] - TOLERANCE_S * 1000 || t > ctx.range[1] + TOLERANCE_S * 1000);
    },
  },
  beforeCoverage: {
    explains: 'before the oldest message our walk of that chat reached',
    when: (d, ctx) => {
      if (d.kind !== 'infloww-only' || !d.theirs.sentAt || !/^\d+$/.test(d.theirs.fan)) return false;
      const chat = ctx.chats.get(Number(d.theirs.fan));
      return !!chat && !chat.reachedStart && chat.oldestAt !== null && d.theirs.sentAt < chat.oldestAt;
    },
  },
  lastFanMessage: {
    explains:
      "Infloww starts the clock at the first unanswered fan message, moved later if the chat was marked read (§8); here it matches ours from the turn's last fan message",
    when: (d) =>
      d.kind === 'reply-time' && d.theirs.replySeconds !== null && d.ours.turn !== null && close(d.ours.turn.lastWait, d.theirs.replySeconds),
  },
  afterScheduled: {
    explains: "the chat's previous turn was closed by a scheduled send: ours closes the turn there, Infloww's does not (§8)",
    when: (d) => d.kind === 'reply-time' && d.theirs.replySeconds !== null && d.ours.turn === null && d.ours.afterScheduledReply,
  },
  onlineOnly: {
    explains: 'Infloww shows reply time only for DMs to online fans (§1)',
    when: (d) => d.kind === 'reply-time' && d.theirs.replySeconds === null && d.ours.turn !== null,
  },
};

const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 19) + 'Z' : 'no time');
const secs = (n: number | null | undefined) => (n === null || n === undefined ? 'n/a' : `${Math.round(n)} s`);

function describe(d: Diff): { text: string; hint: string } {
  if (d.kind === 'infloww-only') {
    const r = d.theirs;
    return {
      text: `infloww-only  line ${r.line} ${iso(r.sentAt)} sender "${r.sender}" to "${r.fan}" price ${r.priceCents ?? '?'} reply ${secs(r.replySeconds)}`,
      hint: r.sentAt ? 'no send of ours within ±60 s at this price' : 'no readable sent time',
    };
  }
  const s = d.ours;
  const head = `msg ${s.messageId} chat ${s.chatId} ${iso(s.createdAt)}`;
  if (d.kind === 'ours-only') {
    return {
      text: `ours-only     ${head} price ${s.priceCents}${s.turn ? ' (a reply)' : ''}`,
      hint: 'a reply Infloww does not list: sent outside Infloww? It sees only its own sends (§4)',
    };
  }
  if (d.kind === 'price') return { text: `price         ${head}: ours ${s.priceCents}, Infloww ${d.theirs.priceCents} (line ${d.theirs.line})`, hint: '' };
  const ours = s.turn ? `${secs(s.turn.firstWait)} from the first / ${secs(s.turn.lastWait)} from the last fan message` : 'no fan turn ended here';
  return { text: `reply time    ${head}: ours ${ours}, Infloww ${secs(d.theirs.replySeconds)} (line ${d.theirs.line})`, hint: '' };
}

function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  return sorted[lo]! + (sorted[Math.min(lo + 1, sorted.length - 1)]! - sorted[lo]!) * (pos - lo);
}
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export type Summary = {
  matched: number;
  byId: number;
  byTime: number;
  /** Time joins that had more than one candidate. */
  ambiguous: number;
  oursOnly: number;
  inflowwOnly: number;
  explained: number;
  unresolved: number;
  byRule: Record<string, number>;
};

export type ReplyTimeComparison = {
  ours: { replied: number; meanFirst: number | null; meanLast: number | null; median: number | null; p90: number | null; perMessageMean: number | null };
  /** Null: the export has no reply time column. */
  infloww: { rows: number; mean: number | null } | null;
};

export type DiffReport = { lines: string[]; summary: Summary; replyTime: ReplyTimeComparison };

/** The whole report; `tz` only labels the note. */
export function diffReport(ours: Ours, infloww: { headers: HeaderMap; rows: InflowwRow[] }, tz = 'UTC+00:00'): DiffReport {
  const { headers, rows } = infloww;
  const lines: string[] = [];
  const unreadable = rows.filter((r) => r.sentAt === null).length;
  if (unreadable * 2 > rows.length) {
    lines.push(
      `warning: ${unreadable} of ${rows.length} Infloww rows have no readable sent time; expected a date like "Aug 21, 2024" and a time like "23:20:54" (Sent date + Sent time)`,
      '',
    );
  }
  lines.push('Infloww columns:');
  for (const f of FIELDS) if (headers.columns[f] !== undefined) lines.push(`  ${label(f).padEnd(13)} <- "${headers.columns[f]}"`);
  lines.push(`  could not map: ${headers.missing.map(label).join(', ') || 'none'}`);
  if (headers.unused.length) lines.push(`  unused columns: ${headers.unused.map((h) => `"${h}"`).join(', ')}`);
  if (headers.columns.sentTime === undefined && headers.columns.messageId === undefined) {
    lines.push('  warning: no sent time and no message id column, so no row can join');
  }
  lines.push(
    'note: our CSVs carry no message text, so rows join by message id or by send time (±60 s) and price, preferring a chat whose fan username is the row\'s "Sent to"; never by text',
    `note: Infloww times without a zone are read as ${tz} (--tz to change); inbound messages are not compared (Infloww lists chatter sends)`,
    '',
    'differences:',
  );

  const { pairs, oursOnly, inflowwOnly } = joinRows(ours.sends, rows, ours.chats);
  const diffs: Diff[] = [
    ...oursOnly.map((o): Diff => ({ kind: 'ours-only', ours: o })),
    ...inflowwOnly.map((t): Diff => ({ kind: 'infloww-only', theirs: t })),
  ];
  const hasReply = headers.columns.replyTime !== undefined;
  for (const { ours: o, theirs: t, by } of pairs) {
    if (by === 'id' && t.priceCents !== null && t.priceCents !== o.priceCents) diffs.push({ kind: 'price', ours: o, theirs: t });
    if (!hasReply) continue;
    const r = t.replySeconds;
    const agrees = r === null ? o.turn === null : o.turn !== null && close(o.turn.firstWait, r);
    if (!agrees) diffs.push({ kind: 'reply-time', ours: o, theirs: t });
  }
  const at = (d: Diff) => (d.kind === 'infloww-only' ? d.theirs.sentAt : d.ours.createdAt)?.getTime() ?? 0;
  diffs.sort((a, b) => at(a) - at(b));

  const byRule: Record<string, number> = {};
  let unresolved = 0;
  for (const d of diffs) {
    const { text, hint } = describe(d);
    const rule = Object.entries(RULES).find(([, r]) => r.when(d, ours));
    if (rule) {
      byRule[rule[0]] = (byRule[rule[0]] ?? 0) + 1;
      lines.push(`${text} -> explained: ${rule[1].explains}`);
    } else {
      unresolved++;
      lines.push(`${text} -> unresolved${hint ? ` (${hint})` : ''}`);
    }
  }
  if (!diffs.length) lines.push('  none');

  const summary: Summary = {
    matched: pairs.length,
    byId: pairs.filter((p) => p.by === 'id').length,
    byTime: pairs.filter((p) => p.by === 'time').length,
    ambiguous: pairs.filter((p) => p.candidates > 1).length,
    oursOnly: oursOnly.length,
    inflowwOnly: inflowwOnly.length,
    explained: diffs.length - unresolved,
    unresolved,
    byRule,
  };

  const withinCap = ours.replied.filter((t) => t.status === 'in_cap').map((t) => t.firstWait).sort((a, b) => a - b);
  const theirWaits = rows.flatMap((r) => (r.replySeconds === null ? [] : [r.replySeconds]));
  const replyTime: ReplyTimeComparison = {
    ours: {
      replied: ours.replied.length,
      meanFirst: mean(ours.replied.map((t) => t.firstWait)),
      meanLast: mean(ours.replied.map((t) => t.lastWait)),
      median: quantile(withinCap, 0.5),
      p90: quantile(withinCap, 0.9),
      perMessageMean: mean(ours.perMessageWaits),
    },
    infloww: hasReply ? { rows: theirWaits.length, mean: mean(theirWaits) } : null,
  };

  const walked = [...ours.chats.values()];
  lines.push(
    '',
    'summary:',
    `  matched       ${summary.matched} (by id ${summary.byId}, by time ${summary.byTime}; ${summary.ambiguous} had more than one candidate)`,
    `  ours-only     ${summary.oursOnly}`,
    `  infloww-only  ${summary.inflowwOnly}`,
    `  explained     ${summary.explained}`,
    ...Object.entries(byRule).map(([name, n]) => `    ${name.padEnd(16)}${n}`),
    `  unresolved    ${summary.unresolved}`,
    `  chats walked  ${walked.length} (${walked.filter((c) => c.reachedStart).length} to their first message)`,
    '',
    ...replyTimeTable(replyTime),
  );
  return { lines, summary, replyTime };
}

/**
 * Infloww counts reply time once per fan turn, as a mean over replied turns with unreplied ones excluded
 * (infloww-definitions.md §1), so the per-turn means are the comparison. Its clock starts at the first unanswered
 * fan message, moved later if the chat was marked read (§8); its cap is unknown.
 */
function replyTimeTable(rt: ReplyTimeComparison): string[] {
  const theirs = rt.infloww ? secs(rt.infloww.mean) : 'n/a (no reply time column)';
  const row = (name: string, ours: string, inf: string) => `  ${name.padEnd(42)}${ours.padEnd(12)}${inf}`;
  const lines = [
    'reply time (seconds):',
    row('per fan turn', 'ours', 'Infloww'),
    row('replied turns (in cap + late) / rows', String(rt.ours.replied), rt.infloww ? String(rt.infloww.rows) : 'n/a'),
    row('mean, timer from the first fan message', secs(rt.ours.meanFirst), theirs),
    row('mean, timer from the last fan message', secs(rt.ours.meanLast), theirs),
    row('median, replied within reply_cap', secs(rt.ours.median), 'n/a (Infloww: a mean, cap unknown)'),
    row('p90, replied within reply_cap', secs(rt.ours.p90), 'n/a (Infloww: a mean, cap unknown)'),
    row('mean per inbound message (not per turn)', secs(rt.ours.perMessageMean), 'n/a (Infloww counts per turn)'),
  ];
  const target = rt.infloww?.mean;
  if (target !== null && target !== undefined) {
    const variants: [string, number][] = [];
    if (rt.ours.meanFirst !== null) variants.push(['first fan message', rt.ours.meanFirst]);
    if (rt.ours.meanLast !== null) variants.push(['last fan message', rt.ours.meanLast]);
    const best = variants.sort((a, b) => Math.abs(a[1] - target) - Math.abs(b[1] - target))[0];
    if (best) lines.push(`  closest to Infloww's mean: timer from the ${best[0]} (off by ${secs(Math.abs(best[1] - target))})`);
  }
  return lines;
}
