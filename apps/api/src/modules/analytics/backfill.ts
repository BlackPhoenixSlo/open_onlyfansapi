import { setTimeout as sleep } from 'node:timers/promises';
import { and, eq, getTableColumns, sql, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { db, pool } from '../../db/index.js';
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
const CHAT_PAGE = 50; // the upstream's cap on /chats; OF answers 10 to 20 a page whatever the limit
/** Chat-list pages in a row adding no new chat that end the list: OF repeating itself, not the list moving. */
const STALE_CHAT_PAGES = 3;
const PAGE = 100; // the upstream's cap on messages, mass history and transactions
/** Chats in a row OF refuses (its 400 or 403) that end the run: a dead session answers every chat read 400 "Wrong user" or 403. */
const DEAD_SESSION_CHATS = 5;

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
  /** The chats of the account's stored messages: walked too when the chat list leaves them out. */
  chatIds(): Promise<number[]>;
  /** After the walk, stopped or not. */
  finish(): Promise<void>;
}

/** What a dry run read: every message walked (both sides of the range), each chat's walk, the range's transactions. */
export type BackfillRows = {
  messages: DerivedMessage[];
  chats: ChatWalk[];
  transactions: DerivedPurchase[];
};

/** The run's step, in order: each reads before the next starts. */
export type BackfillPhase = 'transactions' | 'mass history' | 'welcome message' | 'chat list' | 'chats';

export type BackfillResult = {
  phase: BackfillPhase;
  /** The signal ended the run early. */
  stopped: boolean;
  /** Upstream requests made, 429s and retries included. */
  requests: number;
  /** Retries after a transient failure (502, 503, 504 or a network error); 429 backoffs are not counted. */
  retries: number;
  chats: number;
  /** Chats to walk (the listed active ones and the seeded ones); 0 until the chat list is read. */
  chatsTotal: number;
  messages: number;
  broadcasts: number;
  transactions: number;
  /** A welcome message is set on the account. */
  welcome: boolean;
  /** Chats whose walk stopped on a page with no new id before reaching back to `from` (nor to the chat's start). */
  incompleteChats: number;
  /** Chats the chat list did not name, walked as well: the fans of the range's transactions and of stored messages. */
  seededChats: number;
  /** Chats whose first messages page OF answered 404 (a deleted fan's): skipped. */
  missingChats: number;
  /** Chats whose walk the upstream answered another 4xx (not 401 or 429): skipped, their ids here. DEAD_SESSION_CHATS of OF's 400 or 403 in a row end the run. */
  failedChats: number[];
  /** Chat-list entries without a readable fan id. */
  droppedChats: number;
};

/** Statuses retried with `transientDelaysMs`: a proxy or gateway error at the upstream, or the upstream unreachable. */
const TRANSIENT = new Set([502, 503, 504]);

/**
 * The upstream answered `status`, not retried (or past its retries); `ofError` when the body is OF's error passed
 * through (`code: of_error`); `nextStep` ends the message with what to do.
 */
class StatusError extends Error {
  constructor(
    readonly status: number,
    readonly ofError: boolean,
    path: string,
    nextStep?: string,
  ) {
    super(`backfill: the upstream answered ${status} to GET ${path}${nextStep ? `: ${nextStep}` : ''}`);
  }
}
/** OF's own 400 or 403 (`ofError`): its answer to a dead session's reads, e.g. 400 "Wrong user". */
const ofRefused = (status: number, ofError: boolean) => ofError && (status === 400 || status === 403);
/** What to do after the upstream's last answer `status` fails the run, if anything (`ofError`: OF's error passed through). */
function nextStep(status: number, ofError: boolean, cfg: BackfillConfig): string | undefined {
  if (status === 429) {
    return `still rate limited after ${cfg.maxRetries} retries (waits from ${cfg.backoffBaseMs} ms, doubling) at ${cfg.requestsPerHourPerAccount} requests an hour (ANALYTICS_REQUESTS_PER_HOUR): wait, then run again with a lower cap`;
  }
  if (TRANSIENT.has(status)) {
    return `still failing after ${cfg.transientDelaysMs.length} retries: check that the upstream at UPSTREAM_URL is running and answers within UPSTREAM_TIMEOUT_MS, read its logs, then run again`;
  }
  if (ofRefused(status, ofError)) return "if the account's OF session is dead, re-connect it in Accounts, then run again";
  return undefined;
}
const isOfError = (body: Buffer): boolean => {
  try {
    return (JSON.parse(body.toString('utf8')) as { error?: { code?: unknown } } | null)?.error?.code === 'of_error';
  } catch {
    return false;
  }
};

/**
 * OF answered 401, or `reason`: DEAD_SESSION_CHATS chats in a row refused. The session behind the account is dead, so it
 * must be re-connected in Accounts before a run can work.
 */
export class SessionExpiredError extends Error {
  constructor(accountId: number, reason?: string) {
    super(`OF session of account ${accountId} expired${reason ? ` (${reason})` : ''}: re-connect it in Accounts, then run the backfill again`);
  }
}

/** One account at a time across the process (spec §6.1). */
const oneAtATime = limiter(1);

/** 409 `backfill_running`: another session (the CLI, another API process, or a run in this one) holds the account's backfill lock. */
export class BackfillRunningError extends AppError {
  constructor(accountId: number) {
    super(
      409,
      'backfill_running',
      `A backfill of account ${accountId} is already running (from the dashboard, the daily refresh or analytics:backfill, in this or another process): wait for it to end, then run again`,
    );
  }
}

/**
 * The account's backfill lock, `pg_try_advisory_lock(accountId)`, on a connection of its own held until `release`;
 * null when another session holds it. Session-level, so it holds across processes (CLI, API) on one database, and ends
 * with its connection: a connection lost mid-run drops the lock (and is logged, not thrown, so it cannot crash the
 * process).
 */
async function lockAccount(accountId: number): Promise<{ release(): Promise<void> } | null> {
  const client = await pool.connect();
  const onError = (err: Error) => console.error(`backfill: the lock connection of account ${accountId} failed:`, err.message);
  client.on('error', onError);
  let locked = false;
  try {
    const { rows } = await client.query<{ locked: boolean }>('select pg_try_advisory_lock($1) as locked', [accountId]);
    locked = rows[0]?.locked === true;
  } finally {
    if (!locked) {
      client.off('error', onError);
      client.release();
    }
  }
  if (!locked) return null;
  return {
    async release() {
      // A connection that could not unlock is closed instead of pooled, which drops the lock.
      const unlocked = await client.query('select pg_advisory_unlock($1)', [accountId]).then(
        () => true,
        () => false,
      );
      client.off('error', onError);
      client.release(!unlocked);
    },
  };
}

/** 409 `backfill_running` when a backfill of the account holds its lock now (`POST /v1/stats/backfill`, before starting a run). */
export async function assertBackfillUnlocked(accountId: number): Promise<void> {
  const lock = await lockAccount(accountId);
  if (!lock) throw new BackfillRunningError(accountId);
  await lock.release();
}

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

/** `set` for an upsert: every column not named in `keep` (the primary key, and any column to keep) takes the incoming row's value. */
function updateAll(table: PgTable, keep: string[]): Record<string, SQL> {
  return Object.fromEntries(
    Object.entries(getTableColumns(table))
      .filter(([name]) => !keep.includes(name))
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
 * Messages from `massFrom` on upsert every column on `(account_id, message_id)` (`updateAll`, which clears
 * `deleted_at` too: the derived rows have none). Older ones were derived without their mass history, so on conflict
 * they update every column but `is_mass`, `is_automated` and `automated_reason`: the flags a run that read the mass
 * history derived are not undone. A message read again exists upstream, so either way its `deleted_at` is cleared.
 * Coverage merges: it never moves back. Transactions upsert on `(account_id, tx_id)`. `finish` syncs the account's
 * script candidates.
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
      if (tail.length) {
        await db
          .insert(messageFact)
          .values(tail.map((r) => ({ ...owned, ...r })))
          .onConflictDoUpdate({
            target: [messageFact.accountId, messageFact.messageId],
            set: updateAll(messageFact, ['accountId', 'messageId', 'isMass', 'isAutomated', 'automatedReason']),
          });
      }
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
      if (!merged) throw new Error(`chat_coverage upsert returned no row for chat ${walk.chatId}`);
      return merged;
    },
    async transactions(rows) {
      if (!rows.length) return;
      await db
        .insert(purchaseFact)
        .values(rows.map((r) => ({ ...owned, ...r })))
        .onConflictDoUpdate({ target: [purchaseFact.accountId, purchaseFact.txId], set: updateAll(purchaseFact, ['accountId', 'txId']) });
    },
    async chatIds() {
      const rows = await db
        .selectDistinct({ chatId: messageFact.chatId })
        .from(messageFact)
        .where(and(eq(messageFact.teamId, teamId), eq(messageFact.accountId, accountId)));
      return rows.map((r) => r.chatId);
    },
    async finish() {
      await syncScripts(teamId, accountId);
    },
  };
}

/**
 * A dry run's store: adds what is read to `rows` (without OF's objects) and stores nothing. Coverage is the walk's
 * own; the stored chats are those of `rows`.
 */
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
    async chatIds() {
      return rows.messages.map((m) => m.chatId);
    },
    async finish() {},
  };
}

/**
 * Backfills one account's range (spec §4.2): first the range's transactions (a few pages, so a long run that dies
 * still has them), then mass history in one-day windows from a day before `from` up to now (the walks store messages
 * on both sides of the range) and the welcome template (both feed the derived columns), then the chats active in the
 * range in the chat list's order, then the range's payers and the chats with stored messages that the list left out,
 * each chat's messages newest first down to the range start, all into `store` (`dbStore` upserts, so a re-run never
 * double counts). A chat whose first messages page OF answers 404 is skipped, as is one the upstream answers another
 * 4xx (not 401 or 429). Paced per account within the run (the hourly cap spread evenly: a request starts every hour
 * / cap), backs off on 429, retries transient failures (502, 503, 504, network errors) up to
 * `transientDelaysMs.length` times, and stops when `signal` aborts. Ends with
 * `store.finish()`, stopped or not. Throws `SessionExpiredError` when OF answers 401 or refuses DEAD_SESSION_CHATS chats
 * in a row with its 400 or 403 (a walked chat resets the count). Holds the account's lock (`lockAccount`) for the run,
 * across processes: `BackfillRunningError` (409 `backfill_running`) when another run of the account holds it.
 */
export function backfill(opts: BackfillOptions): Promise<BackfillResult> {
  return oneAtATime(async () => {
    const lock = await lockAccount(opts.accountId);
    if (!lock) throw new BackfillRunningError(opts.accountId);
    try {
      return await run(opts);
    } finally {
      await lock.release();
    }
  });
}

async function run(opts: BackfillOptions): Promise<BackfillResult> {
  const { upstream, accountId, signal, store } = opts;
  const from = opts.from.getTime();
  const to = opts.to.getTime();
  if (!(from < to)) throw new Error('backfill: `from` must be before `to`');
  const cfg = backfillConfig(opts.config);

  const result: BackfillResult = {
    phase: 'transactions',
    stopped: false,
    requests: 0,
    retries: 0,
    chats: 0,
    chatsTotal: 0,
    messages: 0,
    broadcasts: 0,
    transactions: 0,
    welcome: false,
    incompleteChats: 0,
    seededChats: 0,
    missingChats: 0,
    failedChats: [],
    droppedChats: 0,
  };
  /**
   * The hourly cap as an even spacing between request starts (6 s at 600), not a burst then a wait for the hour to
   * roll over; per run, not shared across runs.
   */
  const spacingMs = Math.floor(HOUR_MS / cfg.requestsPerHourPerAccount);
  /** When the previous request started: the spacing runs from there. */
  let lastStart = -Infinity;
  /** When the previous response ended: the page delay runs from there. */
  let lastDone = -Infinity;

  /** Waits for the page delay and the hourly cap's spacing. */
  async function pace() {
    for (;;) {
      const now = Date.now();
      // No spacing (a cap over 3,600,000 an hour) must not wait at all, even if the clock went back since the last start.
      const wait = Math.max(lastDone + cfg.pageDelayMs - now, spacingMs ? lastStart + spacingMs - now : 0);
      if (wait <= 0) break;
      await sleep(wait, undefined, { signal });
    }
    lastStart = Date.now();
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
      if (out instanceof AppError) throw new AppError(out.statusCode, out.code, `${out.message}: ${nextStep(out.statusCode, false, cfg)}`);
      if (out.status === 429 && limited < cfg.maxRetries) {
        await sleep(retryDelay(out.headers.get('retry-after'), limited++, cfg), undefined, { signal });
        continue;
      }
      if (out.status === 401) throw new SessionExpiredError(accountId);
      if (!out.ok) {
        const ofError = isOfError(out.body);
        throw new StatusError(out.status, ofError, path, nextStep(out.status, ofError, cfg));
      }
      return JSON.parse(out.body.toString('utf8')) as unknown;
    }
  }

  try {
    // Transactions first: the chat walks can take hours, and a run that dies (an API restart, an expired session) before
    // the end would otherwise store no money at all.
    const payers = new Set<number>();
    await readTransactions(get, store, from, to, (stored) => {
      result.transactions += stored.length;
      for (const tx of stored) if (tx.fanId !== null) payers.add(tx.fanId);
    });
    // Mass history from a day before the range up to now: the walks store outbound messages outside the range too.
    result.phase = 'mass history';
    const massFrom = from - DAY_MS;
    const mass: Raw[] = [];
    const now = Date.now();
    for (let start = massFrom; start < now; start += DAY_MS) {
      mass.push(...(await readMass(get, start, Math.min(start + DAY_MS, now))));
    }
    result.broadcasts = new Set(mass.map((m) => String(m.id))).size;

    result.phase = 'welcome message';
    const welcome = (await get('/settings/welcome-message')) as Raw | null;
    result.welcome = welcome !== null && typeof welcome === 'object';
    const ctx = deriveContext(accountId, mass, result.welcome ? welcome : null, cfg.automationTexts);

    result.phase = 'chat list';
    const list = await listChats(get, from);
    result.droppedChats = list.dropped;
    // OF's chat list leaves some chats out (a deleted or deactivated fan's; its offset still counts them), so the
    // range's payers and the chats with stored messages are walked too when the list did not name them.
    const seeded = [...new Set([...payers, ...(await store.chatIds())])].filter(
      (id) => Number.isSafeInteger(id) && id > 0 && id !== accountId && !list.listed.has(id),
    );
    result.seededChats = seeded.length;
    result.chatsTotal = list.active.length + seeded.length;
    result.phase = 'chats';
    let refusedInARow = 0;
    for (const chat of [...list.active, ...seeded.map((id) => ({ id, username: null, name: null, customName: null }))]) {
      // One chat's 4xx (401 aside: SessionExpiredError; 429 aside: retried, then fatal) skips that chat; a 5xx ends the
      // run. `refused`: OF's own 400 or 403, its answer to a dead session's chat reads; DEAD_SESSION_CHATS in a row end
      // the run. Another 4xx (`failed`) or a missing chat neither counts nor resets the run of refusals.
      const walk = await walkChat(get, store, ctx, chat, from, massFrom).catch((err: unknown) => {
        if (!(err instanceof StatusError) || err.status < 400 || err.status >= 500 || err.status === 429) throw err;
        return ofRefused(err.status, err.ofError) ? ('refused' as const) : ('failed' as const);
      });
      if (walk === 'missing') {
        result.missingChats++;
      } else if (walk === 'refused' || walk === 'failed') {
        result.failedChats.push(chat.id);
        if (walk === 'refused') refusedInARow++;
      } else {
        result.messages += walk.messages;
        if (walk.incomplete) result.incompleteChats++;
        result.chats++;
        refusedInARow = 0;
      }
      opts.onProgress?.(result);
      if (refusedInARow >= DEAD_SESSION_CHATS) {
        throw new SessionExpiredError(accountId, `OF refused ${refusedInARow} chats in a row with a 400 or 403`);
      }
    }
  } catch (err) {
    if (!signal?.aborted) throw err;
    result.stopped = true;
  }
  await store.finish();
  return result;
}

/**
 * The CLI's progress line: phase, requests, chats done (walked or skipped) of the total and the ETA, from the pace of
 * the chats done since `chatsStartedAt` (when the chat phase began).
 */
export function progressLine(r: Readonly<BackfillResult>, chatsStartedAt: number | null, now = Date.now()): string {
  const done = r.chats + r.missingChats + r.failedChats.length;
  let eta = 'ETA once the chat list is read';
  if (r.phase === 'chats') {
    const pace = chatsStartedAt !== null && done > 0 ? (now - chatsStartedAt) / done : null;
    const minutes = pace === null ? null : Math.ceil((pace * (r.chatsTotal - done)) / 60_000);
    eta = minutes === null ? 'ETA after the first chat' : `ETA ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }
  return `progress: ${r.phase}, ${r.requests} requests, chats ${done}/${r.chatsTotal || '?'}, ${eta}`;
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

/** The fan's id and, as the chat list gives them (null for a chat it left out), username, name and custom name (`displayName`). */
type Chat = { id: number; username: string | null; name: string | null; customName: string | null };

/**
 * The whole chat list (`skip_users=none` so OF sends the full `withUser`): `active`, the chats active since `from`;
 * `listed`, every fan id it named; `dropped`, the entries without a readable fan id. Pages by the page's `nextOffset`
 * (else by the chats it returned) until a page is empty, says `hasMore` false, or STALE_CHAT_PAGES pages in a row add
 * no new chat (the bound when OF repeats itself; one page of repeats is the list moving while it is read). No quiet
 * page ends it: OF's order is not by the last message (unread chats first, a mass message does not move a chat, and a
 * tail ordered by fan id), and its offset counts chats it does not return (pages of 20 places held 13 to 19). A chat
 * with `lastMessage: null` (its latest message deleted) counts as active; one without a readable last-message time
 * does not.
 */
async function listChats(get: Get, from: number): Promise<{ active: Chat[]; listed: Set<number>; dropped: number }> {
  const active: Chat[] = [];
  const listed = new Set<number>();
  let dropped = 0;
  let stale = 0;
  for (let offset = 0; ; ) {
    const page = await get(`/chats?limit=${CHAT_PAGE}&offset=${offset}&order=recent&skip_users=none`);
    const list = items(page);
    let added = 0;
    for (const chat of list) {
      const id = Number((chat.withUser as Raw | undefined)?.id);
      if (!Number.isSafeInteger(id) || id <= 0) {
        dropped++;
        continue;
      }
      if (listed.has(id)) continue; // a repeat: the list moved while it was read
      listed.add(id);
      added++;
      // `lastMessage: null`: OF's answer when the chat's latest message was deleted. Walked and counted active, so
      // its other messages are read.
      const lastAt = chat.lastMessage === null ? from : time((chat.lastMessage as Raw | undefined)?.createdAt);
      if (!(lastAt >= from)) continue; // quiet since before the range, or no readable last message
      active.push({ id, username: username(chat.withUser), name: field(chat.withUser, 'name'), customName: field(chat.withUser, 'displayName') });
    }
    stale = added ? 0 : stale + 1;
    if (list.length === 0 || !hasMore(page) || stale >= STALE_CHAT_PAGES) return { active, listed, dropped };
    const next = Number((page as Raw).nextOffset);
    offset = Number.isInteger(next) && next > offset ? next : offset + list.length;
  }
}

/**
 * Pages one chat newest first with `first_id=<oldest id seen>` (OF's `id`), never `x-next-page`: OF returns short
 * pages before the end. Stops on `hasMore` false (the chat's start: OF's last page of messages still says true, and
 * the empty page after it false), a page with no new id, or the first page reaching before `from` (the boundary
 * page). Each page goes to `store`, split at `massFrom` (the boundary page's tail before it was derived without its
 * mass history), then the walk's coverage. Returns the messages read and whether the store's coverage still falls
 * short of `from`, or `missing` when OF answers 404 to the first page (a fan it no longer has; nothing is stored).
 */
async function walkChat(
  get: Get,
  store: BackfillStore,
  ctx: DeriveContext,
  chat: Chat,
  from: number,
  massFrom: number,
): Promise<{ messages: number; incomplete: boolean } | 'missing'> {
  const chatId = chat.id;
  const seen = new Set<string | number>();
  let fanUsername = chat.username;
  let oldest: { id: number; at: Date } | null = null;
  let reachedStart = false;
  for (;;) {
    const cursor = oldest ? `&first_id=${oldest.id}` : '';
    let page: unknown;
    try {
      page = await get(`/chats/${chatId}/messages?limit=${PAGE}&order=desc${cursor}`);
    } catch (err) {
      if (!oldest && err instanceof StatusError && err.status === 404 && err.ofError) return 'missing';
      throw err;
    }
    const fetchedAt = new Date();
    const list = items(page);
    const derived = list.flatMap((raw) => {
      const d = deriveMessage(raw, chatId, ctx, fanNames({ name: chat.name, username: chat.username, displayName: chat.customName }));
      return d ? [{ d, raw }] : [];
    });
    const rows: WalkedMessage[] = unique(derived, (x) => x.d.messageId, seen).map(({ d, raw }) => ({ ...d, raw, fetchedAt }));
    if (rows.length === 0) {
      // OF's last page of messages still says `hasMore`; the empty page after it says false: the chat's start. A page
      // of ids already read (OF ignored the cursor) proves nothing.
      if (list.length === 0 && !hasMore(page)) reachedStart = true;
      break;
    }
    const covered = rows.filter((r) => r.createdAt.getTime() >= massFrom);
    const tail = rows.filter((r) => !(r.createdAt.getTime() >= massFrom));
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
  return { messages: seen.size, incomplete };
}

/**
 * The range's transactions (newest first from OF) into `store`, stopping at the first page reaching before `from`.
 * `onStored` gets each page's rows once they are stored, so a run stopped mid-way counts what it stored.
 */
async function readTransactions(get: Get, store: BackfillStore, from: number, to: number, onStored: (rows: DerivedPurchase[]) => void): Promise<void> {
  const seen = new Set<string>();
  for (let offset = 0; ; offset += PAGE) {
    const page = await get(`/payouts/transactions?limit=${PAGE}&offset=${offset}&startDate=${encodeURIComponent(ofDate(from))}`);
    const list = unique(items(page).filter((tx) => tx.id !== undefined && tx.id !== null), (tx) => String(tx.id), seen);
    if (list.length === 0) break;
    const rows = list.map((raw) => ({ ...derivePurchase(raw), raw })).filter((r) => r.createdAt.getTime() >= from && r.createdAt.getTime() < to);
    await store.transactions(rows);
    onStored(rows);
    if (!hasMore(page) || list.some((tx) => time(tx.createdAt) < from)) break;
  }
}
