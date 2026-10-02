import type { FastifyBaseLogger } from 'fastify';
// `ws`, not the global WebSocket (deviates from plan-v4 §1.2): only `ws` can terminate() a peer that never answers close.
import WebSocket from 'ws';
import { env } from '../../env.js';
import { createIngestQueue, parseFrame } from './ingest.js';

/** Reconnect backoff and the no-frame window; overridable for tests only. */
export type SourceTimings = { backoffMinMs: number; backoffMaxMs: number; staleMs: number };
const TIMINGS: SourceTimings = { backoffMinMs: 1000, backoffMaxMs: 60_000, staleMs: 90_000 };

let current: { stop: () => Promise<void> } | null = null;

/**
 * The single upstream event socket (`UPSTREAM_WS_URL`; unset = nothing opened). Reconnects with jittered backoff
 * (reset by every frame) and when no frame (heartbeats included) arrives within the stale window.
 * `stop()` closes the socket, clears every timer, discards queued frames and waits for the one in flight.
 */
export function startEventSource(log: FastifyBaseLogger, timings: SourceTimings = TIMINGS): { stop: () => Promise<void> } {
  const url = env.UPSTREAM_WS_URL;
  if (!url) return { stop: async () => {} };
  if (current) {
    log.warn('upstream event source already running; not starting another');
    return current;
  }
  const protocols = ['bearer', `bearer.${env.UPSTREAM_TOKEN}`];
  const queue = createIngestQueue(log);
  let socket: WebSocket | null = null;
  let stopped = false;
  let backoff = timings.backoffMinMs;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let staleTimer: NodeJS.Timeout | undefined;

  /** Forgets the socket (its late events are ignored), drops its TCP connection and schedules the next connect. */
  function reconnect(sock: WebSocket) {
    if (socket !== sock) return;
    socket = null;
    clearTimeout(staleTimer);
    sock.terminate();
    if (stopped) return;
    const delay = backoff / 2 + Math.random() * (backoff / 2);
    backoff = Math.min(backoff * 2, timings.backoffMaxMs);
    reconnectTimer = setTimeout(connect, delay);
  }

  function armStale(sock: WebSocket) {
    clearTimeout(staleTimer);
    staleTimer = setTimeout(() => {
      log.warn({ staleMs: timings.staleMs }, 'upstream event socket silent; reconnecting');
      reconnect(sock);
    }, timings.staleMs);
  }

  function connect() {
    const sock = new WebSocket(url!, protocols);
    socket = sock;
    let opened = false;
    armStale(sock); // also bounds a handshake that never completes
    sock.onopen = () => {
      opened = true;
      log.info('upstream event socket connected');
    };
    sock.onmessage = (ev) => {
      if (socket !== sock) return;
      armStale(sock);
      backoff = timings.backoffMinMs;
      const frame = typeof ev.data === 'string' ? parseFrame(ev.data, () => queue.drop('bad_amount')) : 'malformed';
      if (frame === 'heartbeat') return;
      if (typeof frame === 'string') queue.drop(frame);
      else queue.push(frame);
    };
    // A refused handshake closes with 1006 before `open`: hence the hint.
    const down = (close: { code: number; reason: string }) => {
      if (socket !== sock) return;
      if (opened) log.warn(close, 'upstream event socket closed; reconnecting');
      else log.warn('upstream event socket refused or unreachable: check UPSTREAM_WS_URL / UPSTREAM_TOKEN; retrying');
      reconnect(sock);
    };
    sock.onclose = (ev) => down({ code: ev.code, reason: ev.reason });
    sock.onerror = () => {}; // ws always follows error with close; a listener is still required
  }

  connect();
  const handle = {
    stop: async () => {
      stopped = true;
      clearTimeout(reconnectTimer);
      if (socket) reconnect(socket);
      if (current === handle) current = null;
      queue.clear();
      await queue.idle();
    },
  };
  current = handle;
  return handle;
}
