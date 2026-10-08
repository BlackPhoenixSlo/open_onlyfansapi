import { setTimeout as sleep } from 'node:timers/promises';
import { getTableColumns, sql, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { db } from '../../db/index.js';
import { chatCoverage, messageFact, purchaseFact } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { limiter } from '../../lib/limiter.js';
import type { Upstream } from '../../lib/upstream.js';
import { backfillConfig, type BackfillConfig } from './config.js';
import { deriveContext, deriveMessage, derivePurchase, fanNames, type DeriveContext, type DerivedMessage, type DerivedPurchase, type Raw } from './derive.js';
import { syncScripts } from './scripts.js';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const CHAT_PAGE = 50; // the upstream's cap on /chats; OF answers about 10 a page whatever the limit
/** Consecutive chat-list pages with no chat active in the range that end the list: OF's order is not strictly recent. */
const QUIET_CHAT_PAGES = 2;
const PAGE = 100; // the upstream's cap on messages, mass history and transactions

export type BackfillOptions = {
  upstream: Upstream;
  accountId: number;
  /** The range, `from` inclusive, `to` exclusive. */
  from: Date;
  to: Date;
  config?: Partial<BackfillConfig>;
  /** Aborting ends the run at once (a request in flight finishes), keeping the rows already stored. */
  signal?: AbortSignal;
  /** Where the rows read go: `dbStore` (the account claimed first) or, for a dry run, `memoryStore`. */
  store: BackfillStore;
  /** Called after each upstream request and each chat walk with the counts so far. */
  onProgress?: (result: Readonly<BackfillResult>) => void;
};

/** A message as walked: its derived columns, OF's object and when the page was read. */
export type WalkedMessage = DerivedMessage & { raw: Raw; fetchedAt: Date };
export type WalkedPurchase = DerivedPurchase & { raw: Raw };
/** One chat's walk: the fan's names and the oldest message it reached. */
export type ChatWalk = {
  chatId: number;
  fanUsername: string | null;
  fanName: string | null;
  fanCustomName: string | null;
  oldestMessageId: number | null;
  oldestAt: Date | null;
  reachedStart: boolean;
  walkedAt: Date;
};

/** Where a backfill puts what it reads. */
export interface BackfillStore {
  /** One page of a chat: `covered` (from a day before the range on, derived with mass history) and `tail` (older). */
  messages(covered: WalkedMessage[], tail: WalkedMessage[]): Promise<void>;
  /** A chat's walk; returns the chat's coverage after it (a store may merge it with earlier walks). */
  coverage(walk: ChatWalk): Promise<{ oldestAt: Date | null; reachedStart: boolean }>;
  transactions(rows: WalkedPurchase[]): Promise<void>;
  /** After the walk, stopped or not. */
  finish(): Promise<void>;
}

/** What a dry run read: every message walked (both sides of the range), each chat's walk, the range's transactions. */
export type BackfillRows = {
  messages: DerivedMessage[];
  chats: ChatWalk[];
  transactions: DerivedPurchase[];
};

export type BackfillResult = {
  /** The signal ended the run early. */
  stopped: boolean;
  /** Upstream requests made, 429s and retries included. */
  requests: number;
  /** Retries after a transient failure (502, 503, 504 or a network error); 429 backoffs are not counted. */
  retries: number;
  chats: number;
  messages: number;
  broadcasts: number;
  transactions: number;
  /** A welcome message is set on the account. */
  welcome: boolean;
  /** Distinct queue ids on outbound messages from the mass window on that mass history does not list (an anomaly). */
  unmatchedQueueIds: number;
  /** Chats whose walk stopped on a page with no new id before reaching back to `from` (nor to the chat's start). */
  incompleteChats: number;
};

/** Statuses retried with `transientDelaysMs`: a proxy or gateway error at the upstream, or the upstream unreachable. */
const TRANSIENT = new Set([502, 503, 504]);

/** OF answered 401: the session behind the account is dead, so it must be re-connected in Accounts before a run can work. */
export class SessionExpiredError extends Error {
  constructor(accountId: number) {
    super(`OF session expired for account ${accountId}: re-connect it in Accounts`);
  }
}

/** One account at a time across the process (spec §6.1). */
const oneAtATime = limiter(1);

/** `YYYY-MM-DD HH:MM:SS` in UTC, the date format OF's stats and transaction calls take. */
const ofDate = (t: number) => new Date(t).toISOString().slice(0, 19).replace('T', ' ');

/** The 429 wait: Retry-After (seconds or an HTTP date) when present, else exponential; both capped. */
export function retryDelay(retryAfter: string | null, attempt: number, cfg: Pick<BackfillConfig, 'backoffBaseMs' | 'backoffMaxMs'>): number {
  let ms = cfg.backoffBaseMs * 2 ** attempt;
  if (retryAfter) {
    const parsed = /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(parsed)) ms = Math.max(0, parsed);
  }
  return Math.min(ms, cfg.backoffMaxMs);
}

/** `set` for an upsert: every column but the primary key takes the incoming row's value. */
function updateAll(table: PgTable, key: string[]): Record<string, SQL> {
  return Object.fromEntries(
    Object.entries(getTableColumns(table))
      .filter(([name]) => !key.includes(name))
      .map(([name, col]) => [name, sql.raw(`excluded."${col.name}"`)]),
  );
}

const items = (page: unknown, key = 'list'): Raw[] => {
  const list = (page as Raw | null)?.[key];
  return Array.isArray(list) ? (list.filter((x) => x && typeof x === 'object') as Raw[]) : [];
};
const hasMore = (page: unknown) => (page as Raw | null)?.hasMore === true;
const time = (v: unknown) => new Date(String(v)).getTime();
/** The items whose key is not in `seen` yet (first wins); adds their keys to `seen`. */
function unique<T>(list: T[], key: (x: T) => string | number, seen: Set<string | number>): T[] {
  return list.filter((x) => {
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * The analytics tables of workspace `teamId`, which must own the account (`claimAccount` or `assignAccount` first).
 * Messages from `massFrom` on upsert on `(account_id, message_id)`; older ones were derived without their mass
 * history, so they are only inserted, never updated: a later run that read it is not undone. Coverage merges: it
 * never moves back. Transactions upsert on `(account_id, tx_id)`. `finish` syncs the account's script candidates.
 */
export function dbStore(teamId: string, accountId: number): BackfillStore {
  const owned = { teamId, accountId };
  return {
    async messages(covered, tail) {
      if (covered.length) {
        await db
          .insert(messageFact)
          .values(covered.map((r) => ({ ...owned, ...r })))
          .onConflictDoUpdate({ target: [messageFact.accountId, messageFact.messageId], set: updateAll(messageFact, ['accountId', 'messageId']) });
      }
      if (tail.length) await db.insert(messageFact).values(tail.map((r) => ({ ...owned, ...r }))).onConflictDoNothing();
    },
    async coverage(walk) {
      // A narrower walk keeps what an earlier one reached: the older oldest message (with its time) and reached_start.
      const older = sql`(${chatCoverage.oldestMessageId} is null or excluded.oldest_message_id < ${chatCoverage.oldestMessageId})`;
      const [merged] = await db
        .insert(chatCoverage)
        .values({ ...owned, ...walk })
        .onConflictDoUpdate({
          target: [chatCoverage.accountId, chatCoverage.chatId],
          set: {
            teamId: sql`excluded.team_id`,
            fanUsername: sql`coalesce(excluded.fan_username, ${chatCoverage.fanUsername})`,
            fanName: sql`coalesce(excluded.fan_name, ${chatCoverage.fanName})`,
            fanCustomName: sql`coalesce(excluded.fan_custom_name, ${chatCoverage.fanCustomName})`,
            oldestMessageId: sql`least(excluded.oldest_message_id, ${chatCoverage.oldestMessageId})`,
            oldestAt: sql`case when ${older} then excluded.oldest_at else ${chatCoverage.oldestAt} end`,
            reachedStart: sql`excluded.reached_start or ${chatCoverage.reachedStart}`,
            walkedAt: sql`excluded.walked_at`,
          },
        })
        .returning({ oldestAt: chatCoverage.oldestAt, reachedStart: chatCoverage.reachedStart });
      return merged ?? walk;
    },
    async transactions(rows) {
      if (!rows.length) return;
      await db
        .insert(purchaseFact)
        .values(rows.map((r) => ({ ...owned, ...r })))
        .onConflictDoUpdate({ target: [purchaseFact.accountId, purchaseFact.txId], set: updateAll(purchaseFact, ['accountId', 'txId']) });
    },
    async finish() {
      await syncScripts(teamId, accountId);
    },
  };
}

/** A dry run's store: adds what is read to `rows` (without OF's objects) and stores nothing. Coverage is the walk's own. */
export function memoryStore(rows: BackfillRows): BackfillStore {
  return {
    async messages(covered, tail) {
      rows.messages.push(...[...covered, ...tail].map(({ raw: _r, fetchedAt: _f, ...d }) => d));
    },
    async coverage(walk) {
      rows.chats.push(walk);
      return walk;
    },
    async transactions(list) {
      rows.transactions.push(...list.map(({ raw: _r, ...d }) => d));
    },
    async finish() {},
  };
}

/**
 * Backfills one account's range (spec §4.2): mass history in one-day windows from a day before `from` up to now
 * (the walks store messages on both sides of the range) and the welcome template (both feed the derived columns),
 * then chats newest first and each chat's messages newest first down to the range start, then the range's
 * transactions, all into `store` (`dbStore` upserts, so a re-run never double counts). Paced and capped per account
 * within the run, backs off on 429, retries transient failures (502, 503, 504, network errors) up to
 * `transientDelaysMs.length` times, and stops when `signal` aborts. Ends with `store.finish()`, stopped or not.
 * Throws `SessionExpiredError` when OF answers 401.
 */
export function backfill(opts: BackfillOptions): Promise<BackfillResult> {
  return oneAtATime(() => run(opts));
}

async function run(opts: BackfillOptions): Promise<BackfillResult> {
  const { upstream, accountId, signal, store } = opts;
  const from = opts.from.getTime();
  const to = opts.to.getTime();
  if (!(from < to)) throw new Error('backfill: `from` must be before `to`');
  const cfg = backfillConfig(opts.config);

  const result: BackfillResult = {
    stopped: false,
    requests: 0,
    retries: 0,
    chats: 0,
    messages: 0,
    broadcasts: 0,
    transactions: 0,
    welcome: false,
    unmatchedQueueIds: 0,
    incompleteChats: 0,
  };
  /** This run's request start times in the last hour: the hourly cap is per run, not shared across runs. */
  const times: number[] = [];
  /** When the previous response ended: the page delay runs from there. */
  let lastDone: number | null = null;

  /** Waits for the page delay and the hourly cap. */
  async function pace() {
    for (;;) {
      const now = Date.now();
      while (times.length && times[0]! <= now - HOUR_MS) times.shift();
      const wait = Math.max(
        lastDone === null ? 0 : lastDone + cfg.pageDelayMs - now,
        times.length >= cfg.requestsPerHourPerAccount ? times[0]! + HOUR_MS - now : 0,
      );
      if (wait <= 0) break;
      await sleep(wait, undefined, { signal });
    }
    times.push(Date.now());
  }

  async function get(path: string): Promise<unknown> {
    let limited = 0;
    let transient = 0;
    for (;;) {
      signal?.throwIfAborted();
      await pace();
      const out = await upstream
        .forward({ accountId, path, method: 'GET', headers: { accept: 'application/json', 'x-request-id': newId('req') } })
        .catch((err: unknown) => {
          // A network error or timeout (502 `upstream_unavailable`, 504 `upstream_timeout`) is transient; anything else is not.
          if (err instanceof AppError && TRANSIENT.has(err.statusCode)) return err;
          throw err;
        })
        .finally(() => {
          lastDone = Date.now();
          result.requests++;
          opts.onProgress?.(result);
        });
      const delay = cfg.transientDelaysMs[transient];
      if (TRANSIENT.has(out instanceof AppError ? out.statusCode : out.status) && delay !== undefined) {
        transient++;
        result.retries++;
        opts.onProgress?.(result);
        await sleep(delay, undefined, { signal });
        continue;
      }
      if (out instanceof AppError) throw out;
      if (out.status === 429 && limited < cfg.maxRetries) {
        await sleep(retryDelay(out.headers.get('retry-after'), limited++, cfg), undefined, { signal });
        continue;
      }
      if (out.status === 401) throw new SessionExpiredError(accountId);
      if (!out.ok) throw new Error(`backfill: the upstream answered ${out.status} to GET ${path}`);
      return JSON.parse(out.body.toString('utf8')) as unknown;
    }
  }

  try {
    // Mass history from a day before the range up to now: the walks store outbound messages outside the range too.
    const massFrom = from - DAY_MS;
    const mass: Raw[] = [];
    const now = Date.now();
    for (let start = massFrom; start < now; start += DAY_MS) {
      mass.push(...(await readMass(get, start, Math.min(start + DAY_MS, now))));
    }
    result.broadcasts = new Set(mass.map((m) => String(m.id))).size;

    const welcome = (await get('/settings/welcome-message')) as Raw | null;
    result.welcome = welcome !== null && typeof welcome === 'object';
    const ctx = deriveContext(accountId, mass, result.welcome ? welcome : null, cfg.automationTexts);

    const unmatched = new Set<number>();
    for (const chat of await listChats(get, from)) {
      const walk = await walkChat(get, store, ctx, chat, from, massFrom);
      result.messages += walk.messages;
      for (const q of walk.unmatchedQueueIds) unmatched.add(q);
      result.unmatchedQueueIds = unmatched.size;
      if (walk.incomplete) result.incompleteChats++;
      result.chats++;
      opts.onProgress?.(result);
    }
    result.transactions = await readTransactions(get, store, from, to);
  } catch (err) {
    if (!signal?.aborted) throw err;
    result.stopped = true;
  }
  await store.finish();
  return result;
}

type Get = (path: string) => Promise<unknown>;

/**
 * The broadcasts sent in `[start, end)`. The endpoint ignores `offset` and always reports `hasMore`, so a window is
 * one page; a full page may have been cut, so the window splits in halves until a page is not full. A full page
 * for an hour or less fails the run.
 */
async function readMass(get: Get, start: number, end: number): Promise<Raw[]> {
  const q = new URLSearchParams({ startDate: ofDate(start), endDate: ofDate(end - 1000), limit: String(PAGE) });
  const list = items(await get(`/mass-messaging/overview?${q}`), 'items');
  if (list.length < PAGE) return list;
  if (end - start <= HOUR_MS) {
    throw new Error(`backfill: mass history lists ${PAGE} broadcasts from ${ofDate(start)} to ${ofDate(end - 1000)}, a full page: some may be missing`);
  }
  const mid = start + Math.floor((end - start) / 2000) * 1000;
  return [...(await readMass(get, start, mid)), ...(await readMass(get, mid, end))];
}

const field = (user: unknown, key: string): string | null => {
  const value = (user as Raw | null | undefined)?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
};
const username = (user: unknown) => field(user, 'username');

/** The fan's id and, as the chat list gives them, username, name and custom name (`displayName`). */
type Chat = { id: number; username: string | null; name: string | null; customName: string | null };

/**
 * Chats (the fan's id and username, `skip_users=none` so OF sends the full `withUser`), most recent first. Pages by
 * the page's `nextOffset` (else by the chats it returned: OF's pages are short whatever the limit) until `hasMore` is
 * false, a page adds no new chat, or QUIET_CHAT_PAGES pages in a row have no chat active since `from`: the order is
 * not strictly recent (a pinned or unread chat can come first, an older one mid-list). A chat with `lastMessage: null`
 * (its latest message deleted) counts as active.
 */
async function listChats(get: Get, from: number): Promise<Chat[]> {
  const chats: Chat[] = [];
  const seen = new Set<number>();
  let quiet = 0;
  for (let offset = 0; ; ) {
    const page = await get(`/chats?limit=${CHAT_PAGE}&offset=${offset}&order=recent&skip_users=none`);
    const list = items(page);
    let fresh = 0;
    let active = 0;
    for (const chat of list) {
      const id = Number((chat.withUser as Raw | undefined)?.id);
      if (!Number.isFinite(id) || seen.has(id)) continue; // no fan, or a repeat
      seen.add(id);
      fresh++;
      // `lastMessage: null`: OF's answer when the chat's latest message was deleted. Walked and counted active, so
      // its other messages are read and it never ends the list early.
      const lastAt = chat.lastMessage === null ? from : time((chat.lastMessage as Raw | undefined)?.createdAt);
      if (!(lastAt >= from)) continue; // no messages, or quiet since before the range
      chats.push({ id, username: username(chat.withUser), name: field(chat.withUser, 'name'), customName: field(chat.withUser, 'displayName') });
      active++;
    }
    quiet = active ? 0 : quiet + 1;
    if (!hasMore(page) || fresh === 0 || quiet >= QUIET_CHAT_PAGES) return chats;
    const next = Number((page as Raw).nextOffset);
    offset = Number.isInteger(next) && next > offset ? next : offset + list.length;
  }
}

/**
 * Pages one chat newest first with `first_id=<oldest id seen>` (OF's `id`), never `x-next-page`: OF returns short
 * pages before the end. Stops on `hasMore` false (the chat's start), a page with no new id, or the first page
 * reaching before `from` (the boundary page). Each page goes to `store`, split at `massFrom` (the boundary page's
 * tail before it was derived without its mass history), then the walk's coverage. Returns the messages read, the
 * queue ids from `massFrom` on that mass history does not list, and whether the store's coverage still falls short
 * of `from`.
 */
async function walkChat(
  get: Get,
  store: BackfillStore,
  ctx: DeriveContext,
  chat: Chat,
  from: number,
  massFrom: number,
): Promise<{ messages: number; unmatchedQueueIds: number[]; incomplete: boolean }> {
  const chatId = chat.id;
  const seen = new Set<string | number>();
  const unmatched = new Set<number>();
  let fanUsername = chat.username;
  let oldest: { id: number; at: Date } | null = null;
  let reachedStart = false;
  for (;;) {
    const cursor = oldest ? `&first_id=${oldest.id}` : '';
    const page = await get(`/chats/${chatId}/messages?limit=${PAGE}&order=desc${cursor}`);
    const fetchedAt = new Date();
    const derived = items(page).flatMap((raw) => {
      const d = deriveMessage(raw, chatId, ctx, fanNames({ name: chat.name, username: chat.username, displayName: chat.customName }));
      return d ? [{ d, raw }] : [];
    });
    const rows: WalkedMessage[] = unique(derived, (x) => x.d.messageId, seen).map(({ d, raw }) => ({ ...d, raw, fetchedAt }));
    if (rows.length === 0) break;
    const covered = rows.filter((r) => r.createdAt.getTime() >= massFrom);
    const tail = rows.filter((r) => !(r.createdAt.getTime() >= massFrom));
    for (const r of covered) {
      if (r.direction === 'outbound' && r.queueId !== null && !ctx.massSent.has(r.queueId)) unmatched.add(r.queueId);
    }
    for (const r of rows) {
      const fan = Number((r.raw.fromUser as Raw | undefined)?.id) === chatId ? r.raw.fromUser : r.raw.toUser;
      fanUsername ??= username(fan);
    }
    await store.messages(covered, tail);
    for (const r of rows) {
      if (!oldest || r.messageId < oldest.id) oldest = { id: r.messageId, at: r.createdAt };
    }
    if (!hasMore(page)) {
      reachedStart = true;
      break;
    }
    if (rows.some((r) => r.createdAt.getTime() < from)) break;
  }
  const merged = await store.coverage({
    chatId,
    fanUsername,
    fanName: chat.name,
    fanCustomName: chat.customName,
    oldestMessageId: oldest?.id ?? null,
    oldestAt: oldest?.at ?? null,
    reachedStart,
    walkedAt: new Date(),
  });
  const incomplete = !merged.reachedStart && merged.oldestAt !== null && merged.oldestAt.getTime() > from;
  return { messages: seen.size, unmatchedQueueIds: [...unmatched], incomplete };
}

/** The range's transactions (newest first from OF) into `store`, stopping at the first page reaching before `from`. */
async function readTransactions(get: Get, store: BackfillStore, from: number, to: number): Promise<number> {
  const seen = new Set<string>();
  let read = 0;
  for (let offset = 0; ; offset += PAGE) {
    const page = await get(`/payouts/transactions?limit=${PAGE}&offset=${offset}&startDate=${encodeURIComponent(ofDate(from))}`);
    const list = unique(items(page).filter((tx) => tx.id !== undefined && tx.id !== null), (tx) => String(tx.id), seen);
    if (list.length === 0) break;
    const rows = list.map((raw) => ({ ...derivePurchase(raw), raw })).filter((r) => r.createdAt.getTime() >= from && r.createdAt.getTime() < to);
    await store.transactions(rows);
    read += rows.length;
    if (!hasMore(page) || list.some((tx) => time(tx.createdAt) < from)) break;
  }
  return read;
}
