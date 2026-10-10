// The open `/v1/ws` sockets (plan-v4 Phase 2): one bus subscription fans each event out to them, and a sweep
// re-checks their keys against the database. One hub per app (its state lives in startHub's closure), so two apps in
// one process never share sockets.
import { eq, inArray } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { WebSocket } from 'ws';
import { db } from '../../db/index.js';
import { apiKey, requestLog, teamBackend } from '../../db/schema.js';
import { subscribe, type BusEvent } from '../../lib/event-bus.js';
import { envelope } from '../../lib/signature.js';

export const MAX_SOCKETS_PER_KEY = 5;
const MAX_BUFFERED_BYTES = 1024 * 1024;
const SWEEP_MS = 15_000;

type Client = {
  socket: WebSocket;
  keyId: string;
  /** The key's workspace: only events of accounts it owns reach the socket. */
  teamId: string;
  /** The key's allowlist as of the last sweep; null = every account. */
  allowed: number[] | null;
  /** The `?accountId` filter; null = every allowed account. */
  accountId: number | null;
  /** The session's request_log row and its insert (false if it failed), awaited before the closing update. */
  logId: string;
  logged: Promise<boolean>;
  bytesSent: number;
  /** False from a ping until its pong. */
  alive: boolean;
  done: boolean;
};

/** The owning workspace's sockets whose filter and allowlist take the account. */
function admits(c: Client, { accountId, teamId }: BusEvent): boolean {
  if (teamId !== c.teamId) return false;
  if (c.accountId !== null && c.accountId !== accountId) return false;
  return c.allowed === null || c.allowed.includes(accountId);
}

export type Hub = {
  /** Registers an open socket: inserts its log row, sends `ready`, then events. */
  add(
    socket: WebSocket,
    session: { keyId: string; teamId: string; allowed: number[] | null; accountId: number | null },
    row: typeof requestLog.$inferInsert,
  ): void;
  /** Open sockets of one key (the per-key cap). */
  count(keyId: string): number;
  /**
   * Every 15 s: one query for every open socket's key. Revoked or deleted key or unlinked workspace → 4401; a filtered
   * socket whose account left the allowlist → 4403; otherwise the allowlist is updated in place. Then a ping each; a
   * socket that missed the previous ping's pong is terminated.
   */
  sweep(): Promise<void>;
  /** Closes every socket with 1001 (terminated after 1 s if the peer does not answer) and waits for the log writes. */
  stop(): Promise<void>;
};

const running = new Set<Hub>();

/** Sweeps every running hub now (for tests; the hubs also sweep on their own every 15 s). */
export async function sweep(): Promise<void> {
  await Promise.all([...running].map((h) => h.sweep()));
}

/** Subscribes to the bus and starts the sweep timer. */
export function startHub(log: FastifyBaseLogger): Hub {
  const clients = new Set<Client>();
  const pending = new Set<Promise<void>>();
  /** Sockets the hub sent a close to, until their `close` event; out of `clients` already, so `stop()` needs them. */
  const closing = new Set<WebSocket>();
  let sweeping: Promise<void> | null = null;

  function track(p: Promise<unknown>) {
    const t: Promise<void> = p
      .then(
        () => {},
        (err) => log.error({ err }, 'realtime request log write failed'),
      )
      .finally(() => pending.delete(t));
    pending.add(t);
  }

  /** Ends the session's bookkeeping once: out of the hub, final `resp_bytes` and `error_code` on its log row. */
  function finish(c: Client, errorCode: string | null) {
    if (c.done) return;
    c.done = true;
    clients.delete(c);
    track(
      c.logged.then(async (ok) => {
        if (ok) await db.update(requestLog).set({ respBytes: c.bytesSent, errorCode }).where(eq(requestLog.id, c.logId));
      }),
    );
  }

  /** Server-side close; `reason` is also the log row's `error_code`. */
  function close(c: Client, code: number, reason: string) {
    finish(c, reason);
    closing.add(c.socket);
    c.socket.close(code, reason);
  }

  /** At-most-once: a frame for a socket that is not open is dropped. */
  function send(c: Client, frame: string, bytes: number) {
    if (c.done || c.socket.readyState !== c.socket.OPEN) return;
    if (c.socket.bufferedAmount > MAX_BUFFERED_BYTES) return close(c, 1013, 'slow_consumer');
    c.socket.send(frame);
    c.bytesSent += bytes;
  }

  function broadcast(e: BusEvent) {
    if (clients.size === 0) return;
    const frame = envelope(e);
    const bytes = Buffer.byteLength(frame);
    for (const c of clients) if (admits(c, e)) send(c, frame, bytes);
  }

  async function runSweep() {
    // Sockets opened while the query runs wait for the next sweep.
    const open = [...clients];
    if (open.length === 0) return;
    const rows = await db
      .select({ id: apiKey.id, revokedAt: apiKey.revokedAt, allowed: apiKey.allowedAccountIds, linked: teamBackend.teamId })
      .from(apiKey)
      .leftJoin(teamBackend, eq(teamBackend.teamId, apiKey.teamId))
      .where(inArray(apiKey.id, [...new Set(open.map((c) => c.keyId))]));
    const keys = new Map(rows.map((r) => [r.id, r]));
    for (const c of open) {
      if (c.done) continue;
      const key = keys.get(c.keyId);
      if (!key || key.revokedAt) close(c, 4401, 'invalid_api_key');
      else if (!key.linked) close(c, 4401, 'team_not_linked');
      else if (c.accountId !== null && key.allowed && !key.allowed.includes(c.accountId)) close(c, 4403, 'account_not_allowed');
      else if (!c.alive) {
        finish(c, 'pong_timeout');
        c.socket.terminate();
      } else {
        c.allowed = key.allowed;
        c.alive = false;
        c.socket.ping();
      }
    }
  }

  const hub: Hub = {
    add(socket, session, row) {
      const logged = db
        .insert(requestLog)
        .values(row)
        .then(
          () => true,
          (err) => {
            log.error({ err }, 'realtime request log insert failed');
            return false;
          },
        );
      track(logged);
      const c: Client = { ...session, socket, logId: row.id, logged, bytesSent: 0, alive: true, done: false };
      clients.add(c);
      socket.on('pong', () => {
        c.alive = true;
      });
      // A client- or network-side close; after a server-side close this is a no-op.
      socket.on('close', (code) => {
        closing.delete(socket);
        finish(c, code === 1006 ? 'connection_lost' : null);
      });
      const ready = JSON.stringify({ type: 'ready', accountIds: c.accountId !== null ? [c.accountId] : c.allowed });
      send(c, ready, Buffer.byteLength(ready));
    },
    count(keyId) {
      let n = 0;
      for (const c of clients) if (c.keyId === keyId) n++;
      return n;
    },
    sweep() {
      sweeping ??= runSweep().finally(() => {
        sweeping = null;
      });
      return sweeping;
    },
    async stop() {
      running.delete(hub);
      clearInterval(timer);
      unsubscribe();
      await sweeping?.catch(() => {});
      for (const c of [...clients]) {
        finish(c, null);
        closing.add(c.socket);
        c.socket.close(1001, 'shutdown');
      }
      // A dead peer never answers the close; do not let it hold the shutdown (Docker's grace is 10 s).
      for (const socket of closing) setTimeout(() => socket.terminate(), 1000).unref();
      await Promise.allSettled(pending);
    },
  };

  const unsubscribe = subscribe(broadcast);
  const timer = setInterval(() => {
    hub.sweep().catch((err) => log.error({ err }, 'realtime sweep failed'));
  }, SWEEP_MS).unref();
  running.add(hub);
  return hub;
}
